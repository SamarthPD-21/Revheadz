import { describe, expect, it } from "vitest";
import type { SimEvent } from "../lib/sim/types";
import { Simulation } from "../lib/sim/Simulation";
import { loadConfig, run, seeded } from "./helpers";

function started(id: string, canStall: boolean) {
  const sim = new Simulation(loadConfig(id), seeded());
  sim.canStall = canStall;
  sim.toggleIgnition();
  run(sim, 1.2);
  const events: SimEvent["type"][] = [];
  sim.subscribe((e) => events.push(e.type));
  return { sim, events };
}

/** Pulls away in 1st and gets going in 2nd. */
function rolling(sim: Simulation) {
  sim.shiftUp();
  run(sim, 0.6);
  sim.input.throttle = 0.6;
  run(sim, 2);
  sim.shiftUp();
  run(sim, 1.5);
}

describe("stalling", () => {
  it("a manual stalls when you brake to a stop in gear, and then it's off", () => {
    const { sim, events } = started("supra_mk4", true);
    rolling(sim);
    sim.input.throttle = 0;
    sim.input.brake = 1;
    run(sim, 6);
    expect(events).toContain("stall");
    expect(sim.state.ignition).toBe("off");
  });

  it("stopping in neutral, or crawling in 1st, doesn't stall", () => {
    const a = started("supra_mk4", true);
    rolling(a.sim);
    a.sim.neutral();
    a.sim.input.throttle = 0;
    a.sim.input.brake = 1;
    run(a.sim, 6);
    expect(a.events).not.toContain("stall");
    const b = started("supra_mk4", true);
    b.sim.shiftUp();
    run(b.sim, 5); // idling along in 1st, off the throttle
    expect(b.events).not.toContain("stall");
  });

  it("pulling away in 4th bogs it down and stalls it", () => {
    const { sim, events } = started("supra_mk4", true);
    for (let i = 0; i < 4; i++) {
      sim.shiftUp();
      run(sim, 0.4);
    }
    sim.input.throttle = 0.4;
    run(sim, 2);
    expect(events).toContain("stall");
  });

  it("automatics never stall, and nothing stalls unless asked (the strip)", () => {
    for (const [id, canStall] of [["hellcat", true], ["supra_mk4", false]] as const) {
      const { sim, events } = started(id, canStall);
      rolling(sim);
      sim.input.throttle = 0;
      sim.input.brake = 1;
      run(sim, 6);
      expect([id, events.includes("stall")]).toEqual([id, false]);
    }
  });
});

describe("traction", () => {
  it("past the tyres' grip the wheels spin, the revs flare and the car gains speed slower", () => {
    const free = started("hellcat", false).sim;
    const held = started("hellcat", false).sim;
    for (const sim of [free, held]) {
      sim.shiftUp();
      run(sim, 0.6);
      sim.input.throttle = 1;
    }
    held.input.traction = 0.25 * 2000 * 9.81; // a rear-drive car on wet grass
    run(free, 2);
    run(held, 2);
    expect(held.state.speedKmh).toBeLessThan(free.state.speedKmh * 0.8);
    expect(held.state.wheelspin ?? 0).toBeGreaterThan(0.2);
    // the engine runs ahead of the road speed
    expect(held.state.rpm).toBeGreaterThan(free.state.rpm * (held.state.speedKmh / free.state.speedKmh) * 1.05);
  });

  it("on a steep grassy hill a rear-drive car spins its wheels and stops; all-wheel drive gets up it", () => {
    // a 19 degree slope of grass: what the cruise screen works out the tyres can put down
    const grade = 0.35;
    const cos = 1 / Math.sqrt(1 + grade * grade);
    const climb = (id: string, grip: number, share: number) => {
      const cfg = loadConfig(id);
      const sim = new Simulation(cfg, seeded());
      sim.toggleIgnition();
      run(sim, 1.2);
      sim.shiftUp();
      run(sim, 0.6);
      sim.input.throttle = 1;
      sim.input.grade = grade;
      sim.input.traction = grip * cfg.dynamics.massKg * 9.81 * cos * share;
      let top = 0;
      for (let t = 0; t < 8; t += 0.5) {
        run(sim, 0.5);
        top = Math.max(top, sim.state.speedKmh);
      }
      return { end: sim.state.speedKmh, top, spin: sim.state.wheelspin ?? 0 };
    };
    // Hellcat: muscle-car tyres on grass, the rear's share of the weight (plus a little uphill)
    const rwd = climb("hellcat", 0.6 * 0.92 * 0.85, 0.52);
    // Skyline GT-R: all four wheels driving
    const awd = climb("skyline_r34", 0.6 * 1.08 * 0.8, 1);
    expect(rwd.end).toBeLessThan(1);
    expect(rwd.spin).toBeGreaterThan(0.2);
    expect(awd.end).toBeGreaterThan(20);
  });
});
