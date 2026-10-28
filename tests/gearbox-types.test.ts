import { describe, expect, it } from "vitest";
import { Simulation } from "../lib/sim/Simulation";
import type { SimEvent } from "../lib/sim/types";
import type { GearboxType, VehicleConfig } from "../lib/vehicles/types";
import { loadConfig, run, seeded } from "./helpers";

/** The same car with a different gearbox, started and idling. */
function sim(type: GearboxType, extra: Partial<VehicleConfig["gearbox"]> = {}) {
  const cfg = loadConfig("muscle_v8");
  const s = new Simulation({ ...cfg, gearbox: { ...cfg.gearbox, type, ...extra } }, seeded());
  s.toggleIgnition();
  run(s, 1.2);
  return { s, cfg };
}

/** Full throttle in 1st up to a speed, then an upshift; returns the speed 0.4 s after the shift. */
function speedAfterShift(type: GearboxType) {
  const { s } = sim(type);
  s.shiftUp();
  s.input.throttle = 1;
  while (s.state.speedKmh < 60) run(s, 1 / 120);
  s.shiftUp();
  run(s, 0.4);
  return s.state.speedKmh;
}

describe("gearbox types", () => {
  it("a torque converter lets the revs flare to its stall speed pulling away, then couples", () => {
    const { s, cfg } = sim("auto", { stallRpm: 2400 });
    s.shiftUp();
    run(s, 0.6); // into gear
    s.input.throttle = 1;
    run(s, 0.3);
    // the engine is already well up while the car has barely moved
    expect(s.state.rpm).toBeGreaterThan(2000);
    expect(s.state.rpm).toBeLessThan(2500);
    expect(s.state.speedKmh).toBeLessThan(15);
    run(s, 3);
    // coupled: the revs now follow the wheels, well past stall
    expect(s.state.rpm).toBeGreaterThan(3500);
    expect(s.state.rpm).toBeLessThanOrEqual(cfg.engine.limiterRpm);
  });

  it("a dual-clutch keeps driving through an upshift; a manual's open clutch doesn't", () => {
    const dct = speedAfterShift("dct");
    const manual = speedAfterShift("manual");
    const amt = speedAfterShift("amt");
    expect(dct).toBeGreaterThan(manual);
    expect(dct).toBeGreaterThan(amt);
  });

  it("an automatic kicks down when you floor it at low revs, and only then", () => {
    const { s } = sim("auto");
    s.shiftUp();
    s.input.throttle = 0.6;
    while (s.state.gear < 4) {
      run(s, 1.2);
      s.shiftUp();
    }
    s.input.throttle = 0.15;
    run(s, 1.5);
    expect(s.state.gear).toBe(4);
    const shifts: SimEvent[] = [];
    s.subscribe((e) => e.type === "shift" && shifts.push(e));
    s.input.throttle = 1;
    run(s, 0.3);
    expect(s.state.gear).toBe(3);
    expect(shifts).toEqual([{ type: "shift", direction: "down" }]);
  });

  it("automated boxes change down as the car rolls to a stop; a manual stays where you left it", () => {
    for (const [type, gear] of [["dct", 1], ["amt", 1], ["auto", 1], ["manual", 3], ["sequential", 3]] as const) {
      const { s } = sim(type);
      s.shiftUp();
      s.input.throttle = 1;
      for (let g = 1; g < 3; g++) {
        run(s, 1.5);
        s.shiftUp();
      }
      run(s, 1);
      s.input.throttle = 0;
      s.input.brake = 1;
      run(s, 8);
      expect([type, s.state.speedKmh < 0.01]).toEqual([type, true]);
      expect([type, s.state.gear]).toEqual([type, gear]);
    }
  });

  it("only clutch-cut boxes crack on a loaded upshift; a torque converter slurs through", () => {
    for (const [type, cracks] of [["dct", true], ["amt", true], ["sequential", true], ["auto", false], ["manual", false]] as const) {
      const { s } = sim(type);
      const seen: string[] = [];
      s.subscribe((e) => seen.push(e.type));
      s.shiftUp();
      s.input.throttle = 1;
      run(s, 1.5);
      s.shiftUp();
      run(s, 0.3);
      expect([type, seen.includes("shiftCrack")]).toEqual([type, cracks]);
    }
  });
});
