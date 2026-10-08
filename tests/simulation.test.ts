import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Gearbox } from "../lib/sim/Gearbox";
import { Simulation } from "../lib/sim/Simulation";
import type { SimEvent } from "../lib/sim/types";
import { loadConfig, run, seeded, startedSim } from "./helpers";

const IDS = readdirSync(path.join(process.cwd(), "public", "vehicles"));

describe("ignition", () => {
  it("cranks for ~800 ms, then idles", () => {
    const cfg = loadConfig("muscle_v8");
    const sim = new Simulation(cfg, seeded());
    sim.toggleIgnition();
    run(sim, 0.4);
    expect(sim.state.ignition).toBe("cranking");
    run(sim, 0.5);
    expect(sim.state.ignition).toBe("running");
    run(sim, 3);
    expect(sim.state.rpm).toBeCloseTo(cfg.engine.idleRpm, -1);
  });

  it("emits start and stop events", () => {
    const sim = new Simulation(loadConfig("muscle_v8"), seeded());
    const seen: string[] = [];
    sim.subscribe((e) => seen.push(e.type));
    sim.toggleIgnition();
    run(sim, 1);
    sim.toggleIgnition();
    expect(seen).toEqual(["start", "stop"]);
  });
});

describe.each(IDS)("%s", (id) => {
  it("RPM stays between idle and limiter in every gear", () => {
    const cfg = loadConfig(id);
    const sim = startedSim(id);
    sim.input.throttle = 1;
    let min = Infinity;
    let max = 0;
    const track = () => {
      min = Math.min(min, sim.state.rpm);
      max = Math.max(max, sim.state.rpm);
    };
    for (let g = 0; g <= cfg.gearbox.ratios.length; g++) {
      if (g > 0) sim.shiftUp();
      for (let i = 0; i < 120 * 6; i++) {
        sim.step(1 / 120);
        track();
      }
    }
    sim.input.throttle = 0;
    sim.input.brake = 1;
    for (let i = 0; i < 120 * 20; i++) {
      sim.step(1 / 120);
      track();
    }
    expect(min).toBeGreaterThanOrEqual(cfg.engine.idleRpm - 1e-6);
    expect(max).toBeLessThanOrEqual(cfg.engine.limiterRpm + 1e-6);
  });

  it("free-revs to the limiter in neutral and bounces off it", () => {
    const cfg = loadConfig(id);
    const sim = startedSim(id);
    const events: SimEvent[] = [];
    sim.subscribe((e) => events.push(e));
    sim.input.throttle = 1;
    run(sim, 3);
    expect(events.filter((e) => e.type === "limiter").length).toBeGreaterThan(3);
    expect(sim.state.rpm).toBeGreaterThan(cfg.engine.limiterRpm * 0.9);
  });

  it("is stationary in neutral after braking", () => {
    const sim = startedSim(id);
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 4);
    expect(sim.state.speedKmh).toBeGreaterThan(20);
    sim.neutral();
    sim.input.throttle = 0;
    sim.input.brake = 1;
    run(sim, 30);
    expect(sim.state.speedKmh).toBe(0);
    expect(sim.state.gear).toBe(0);
  });
});

describe("gearing", () => {
  it("speed matches the gearing formula within 1%", () => {
    const cfg = loadConfig("muscle_v8");
    const gb = new Gearbox(cfg.gearbox);
    const sim = startedSim("muscle_v8");
    sim.shiftUp();
    sim.input.throttle = 0.5;
    run(sim, 3);
    const { rpm, speedKmh } = sim.state;
    // Skip if the limiter or clutch slip is influencing rpm.
    expect(rpm).toBeLessThan(cfg.engine.limiterRpm - 100);
    const expected = (rpm / (cfg.gearbox.ratios[0] * cfg.gearbox.finalDrive)) * 2 * Math.PI * cfg.gearbox.wheelRadiusM * 60 / 1000;
    expect(Math.abs(speedKmh - expected) / expected).toBeLessThan(0.01);
    expect(Math.abs(gb.speedFromRpm(rpm, 1) - speedKmh) / speedKmh).toBeLessThan(0.01);
  });

  it("upshift lowers RPM, downshift raises it", () => {
    const sim = startedSim("muscle_v8");
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 2.5);
    sim.shiftUp();
    const before = sim.state.rpm;
    sim.input.throttle = 0;
    run(sim, 0.5);
    const afterUp = sim.state.rpm;
    expect(afterUp).toBeLessThan(before);
    sim.shiftDown();
    run(sim, 0.5);
    expect(sim.state.rpm).toBeGreaterThan(afterUp);
  });

  it("neutral frees the engine from the road", () => {
    const sim = startedSim("muscle_v8");
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 2);
    sim.neutral();
    run(sim, 2);
    const speed = sim.state.speedKmh;
    expect(speed).toBeGreaterThan(10);
    // engine now revs on its own, independent of speed
    expect(sim.state.rpm).toBeGreaterThan(sim.state.speedKmh * 40);
    sim.input.throttle = 0;
    run(sim, 3);
    expect(sim.state.rpm).toBeLessThan(1200);
  });

  it("refuses a downshift that would over-rev", () => {
    const sim = startedSim("muscle_v8");
    sim.input.throttle = 1;
    for (let i = 0; i < 6; i++) {
      sim.shiftUp();
      run(sim, 0.6); // each shift has to finish before the next
    }
    run(sim, 40);
    const fast = sim.state.speedKmh;
    expect(fast).toBeGreaterThan(100);
    sim.shiftDown(); // 5th is fine; keep going down until refused
    for (let i = 0; i < 6; i++) sim.shiftDown();
    expect(sim.state.gear).toBeGreaterThan(1);
  });

  it("does not stall when pulling away in gear 1 and then accelerates", () => {
    const cfg = loadConfig("muscle_v8");
    const sim = startedSim("muscle_v8");
    sim.shiftUp();
    run(sim, 1);
    expect(sim.state.rpm).toBeGreaterThanOrEqual(cfg.engine.idleRpm);
    sim.input.throttle = 1;
    run(sim, 3);
    expect(sim.state.speedKmh).toBeGreaterThan(30);
  });
});

describe("backfire", () => {
  const count = (sim: Simulation, fn: () => void, seconds: number) => {
    let n = 0;
    sim.subscribe((e) => e.type === "backfire" && n++);
    fn();
    run(sim, seconds);
    return n;
  };

  it("fires 1-4 pops on high-rpm lift-off", () => {
    const sim = startedSim("muscle_v8");
    sim.input.throttle = 1;
    run(sim, 1.2);
    expect(sim.state.rpm).toBeGreaterThan(0.6 * 6500);
    const n = count(sim, () => (sim.input.throttle = 0), 1);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });

  it("does not fire while holding throttle", () => {
    const sim = startedSim("muscle_v8");
    const n = count(sim, () => (sim.input.throttle = 1), 3);
    expect(n).toBe(0);
  });

  it("does not fire on lift-off at low rpm", () => {
    const sim = startedSim("muscle_v8");
    sim.input.throttle = 0.7;
    run(sim, 0.05);
    sim.input.throttle = 1;
    // throttle armed but rpm still low: lift quickly
    const n = count(sim, () => ((sim.input.throttle = 0), undefined), 1);
    expect(sim.state.rpm).toBeLessThan(0.6 * 6500);
    expect(n).toBe(0);
  });
});

describe("no stray pops on gear changes", () => {
  it("lifting to shift never backfires; coasting off the throttle can", () => {
    for (const id of IDS) {
      const cfg = loadConfig(id);
      const sim = startedSim(id, 3);
      let pops = 0;
      sim.subscribe((e) => e.type === "backfire" && pops++);
      sim.shiftUp();
      sim.input.throttle = 1;
      for (let i = 0; i < 120 * 20; i++) {
        if (sim.state.rpm > cfg.engine.redlineRpm * 0.85 && !sim.state.shifting && sim.state.gear < cfg.gearbox.ratios.length && sim.input.throttle === 1) {
          sim.input.throttle = 0;
          run(sim, 0.08); // driver lifts...
          sim.shiftUp(); // ...and changes gear
          run(sim, 0.15);
          sim.input.throttle = 1;
        }
        sim.step(1 / 120);
      }
      expect(pops, id).toBe(0);
    }
  });
});

describe("fixed timestep", () => {
  it("gives identical results at 60 Hz and 144 Hz frame rates", () => {
    const make = () => {
      const sim = startedSim("muscle_v8");
      sim.shiftUp();
      sim.input.throttle = 1;
      return sim;
    };
    const a = make();
    const b = make();
    for (let i = 0; i < 60 * 3; i++) a.advance(1 / 60);
    for (let i = 0; i < 144 * 3; i++) b.advance(1 / 144);
    expect(Math.abs(a.state.speedKmh - b.state.speedKmh)).toBeLessThan(1.5);
  });
});

describe("low-frequency store", () => {
  it("only notifies on gear / ignition changes and keeps snapshots stable", () => {
    const sim = new Simulation(loadConfig("muscle_v8"), seeded());
    let calls = 0;
    sim.store.subscribe(() => calls++);
    const snap = sim.store.getSnapshot();
    run(sim, 1);
    expect(sim.store.getSnapshot()).toBe(snap);
    sim.toggleIgnition();
    expect(calls).toBe(1);
    run(sim, 1.2); // cranking -> running
    expect(calls).toBe(2);
    sim.shiftUp();
    expect(calls).toBe(3);
    run(sim, 1);
    expect(calls).toBe(3);
  });
});

describe("turbo", () => {
  it("builds boost with lag, adds torque, and blows off on lift", () => {
    const sim = startedSim("jdm_i6_turbo");
    const events: string[] = [];
    sim.subscribe((e) => events.push(e.type));
    expect(sim.state.boost).toBe(0);
    sim.input.throttle = 1;
    run(sim, 0.1);
    const early = sim.state.boost;
    run(sim, 1.5);
    expect(sim.state.boost).toBeGreaterThan(early);
    expect(sim.state.boost).toBeGreaterThan(0.5);
    sim.input.throttle = 0;
    run(sim, 0.6); // the lift has to be confirmed as a coast first
    expect(events).toContain("blowoff");
  });

  it("never has boost without a turbo", () => {
    const sim = startedSim("v12_gt");
    sim.input.throttle = 1;
    run(sim, 2);
    expect(sim.state.boost).toBe(0);
  });
});

describe("realistic shifting", () => {
  it("cuts drive during the shift: the car does not accelerate mid-shift", () => {
    const sim = startedSim("muscle_v8");
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 2.5);
    sim.shiftUp();
    const v0 = sim.state.speedKmh;
    run(sim, 0.2); // inside the 280 ms manual cut
    expect(sim.state.speedKmh).toBeLessThanOrEqual(v0 + 0.01);
    run(sim, 1);
    expect(sim.state.speedKmh).toBeGreaterThan(v0); // drive is back afterwards
  });

  it("upshift: rpm falls during the cut, then blends onto the new gear without a jump", () => {
    const sim = startedSim("muscle_v8");
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 2.5);
    const before = sim.state.rpm;
    sim.shiftUp();
    let prev = sim.state.rpm;
    let maxStep = 0;
    for (let i = 0; i < 120 * 0.6; i++) {
      sim.step(1 / 120);
      maxStep = Math.max(maxStep, Math.abs(sim.state.rpm - prev));
      prev = sim.state.rpm;
    }
    expect(sim.state.rpm).toBeLessThan(before);
    expect(sim.state.shifting).toBe(false);
    expect(maxStep).toBeLessThan(250); // no instant jumps: < 30k rpm/s
  });

  it("downshift blips the throttle to rev-match (audible on-load) without passing the limiter", () => {
    const cfg = loadConfig("v10_supercar");
    const sim = startedSim("v10_supercar");
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 1.5);
    sim.shiftUp();
    run(sim, 1);
    sim.shiftUp();
    run(sim, 1);
    sim.input.throttle = 0;
    run(sim, 0.6);
    const before = sim.state.rpm;
    expect(sim.state.gear).toBe(3);
    sim.shiftDown();
    expect(sim.state.gear).toBe(2);
    let peakLoad = 0;
    let peakRpm = 0;
    for (let i = 0; i < 40; i++) {
      sim.step(1 / 120);
      peakLoad = Math.max(peakLoad, sim.state.load);
      peakRpm = Math.max(peakRpm, sim.state.rpm);
    }
    expect(peakRpm).toBeGreaterThan(before);
    expect(peakLoad).toBeGreaterThan(0.1);
    expect(peakRpm).toBeLessThanOrEqual(cfg.engine.limiterRpm);
  });

  it("DCT and quickshifter crack on loaded upshifts; a manual does not", () => {
    for (const [id, expected] of [["v10_supercar", true], ["superbike_i4", true], ["muscle_v8", false]] as const) {
      const sim = startedSim(id);
      const events: string[] = [];
      sim.subscribe((e) => events.push(e.type));
      sim.shiftUp();
      sim.input.throttle = 1;
      run(sim, 1);
      sim.shiftUp();
      expect(events.includes("shiftCrack"), id).toBe(expected);
    }
  });

  it("a DCT shift is much quicker than a manual one", () => {
    const time = (id: string) => {
      const sim = startedSim(id);
      sim.shiftUp();
      sim.input.throttle = 1;
      run(sim, 1);
      sim.shiftUp();
      let t = 0;
      while (sim.state.shifting && t < 2) {
        sim.step(1 / 120);
        t += 1 / 120;
      }
      return t;
    };
    expect(time("v10_supercar")).toBeLessThan(time("muscle_v8") * 0.6);
  });
});

describe("deceleration", () => {
  it("a turbo car does not blow off when you lift to change gear", () => {
    const sim = startedSim("jdm_i6_turbo");
    const events: string[] = [];
    sim.subscribe((e) => events.push(e.type));
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 2.5);
    sim.input.throttle = 0;
    run(sim, 0.1);
    sim.shiftUp();
    run(sim, 0.2);
    sim.input.throttle = 1;
    run(sim, 1);
    expect(events).not.toContain("blowoff");
  });

  it("engine braking slows the car clearly more in gear than coasting in neutral", () => {
    const coast = (neutral: boolean) => {
      const sim = startedSim("muscle_v8");
      sim.shiftUp();
      sim.input.throttle = 1;
      run(sim, 1.2);
      sim.shiftUp();
      run(sim, 1.5);
      sim.input.throttle = 0;
      if (neutral) sim.neutral();
      const v0 = sim.state.speedKmh;
      run(sim, 2);
      return v0 - sim.state.speedKmh;
    };
    const inGear = coast(false);
    const inNeutral = coast(true);
    expect(inGear).toBeGreaterThan(inNeutral * 1.5);
    expect(inGear).toBeGreaterThan(5); // noticeable, km/h lost in 2 s
  });

  it("brakes build up progressively and ease off just before stopping (no jolts)", () => {
    const sim = startedSim("muscle_v8");
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 3);
    sim.input.throttle = 0;
    sim.neutral();
    sim.input.brake = 1;
    const dt = 1 / 120;
    let prevV = sim.state.speedKmh / 3.6;
    let prevA = 0;
    let maxJerk = 0;
    let t = 0;
    while (sim.state.speedKmh > 0 && t < 20) {
      sim.step(dt);
      t += dt;
      const v = sim.state.speedKmh / 3.6;
      const a = (v - prevV) / dt;
      if (t > dt * 2 && v > 0) maxJerk = Math.max(maxJerk, Math.abs(a - prevA) / dt);
      prevV = v;
      prevA = a;
    }
    expect(sim.state.speedKmh).toBe(0);
    expect(maxJerk).toBeLessThan(150); // m/s^3: no instant 0 -> 9 m/s^2 steps
  });

  it("coasting at high revs crackles; holding the throttle or shifting does not", () => {
    const sim = startedSim("hot_hatch", 5);
    let crackles = 0;
    sim.subscribe((e) => e.type === "crackle" && crackles++);
    sim.shiftUp();
    sim.input.throttle = 1;
    run(sim, 3);
    expect(crackles).toBe(0);
    sim.input.throttle = 0;
    run(sim, 3);
    expect(crackles).toBeGreaterThan(0);
  });
});
