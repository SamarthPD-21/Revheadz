import { describe, expect, it } from "vitest";
import { SpeedHold, autoShift, safeSpeedKmh } from "../lib/cruise/autopilot";
import { loadConfig, run, startedSim } from "./helpers";

/** Drives on autopilot for `seconds`, the way the cruise screen does each frame. */
function cruise(id: string, targetKmh: number, seconds: number) {
  const cfg = loadConfig(id);
  const sim = startedSim(id);
  let lastShift = 0;
  let t = 0;
  const dt = 1 / 60;
  let maxGear = 0;
  const hold = new SpeedHold();
  for (; t < seconds; t += dt) {
    const c = hold.update(sim.state.speedKmh, targetKmh, dt);
    sim.input.throttle = c.throttle;
    sim.input.brake = c.brake;
    lastShift = autoShift(sim, cfg, sim.input.throttle, t, lastShift);
    run(sim, dt);
    maxGear = Math.max(maxGear, sim.state.gear);
  }
  return { sim, cfg, maxGear };
}

describe("cruise autopilot", () => {
  it("pulls away, works up the gears and holds the speed it was set to", () => {
    for (const id of ["supra_mk4", "hellcat", "ninja_h2", "muscle_v8"]) {
      const { sim, cfg, maxGear } = cruise(id, 100, 40);
      expect([id, Math.abs(sim.state.speedKmh - 100) < 2]).toEqual([id, true]);
      expect([id, maxGear >= 3]).toEqual([id, true]);
      // relaxed: well under the redline at a steady cruise
      expect([id, sim.state.rpm < cfg.engine.redlineRpm * 0.8]).toEqual([id, true]);
    }
  });

  it("slows ahead of a tight bend, not in it", () => {
    const open = [{ curvature: 0, at: 0 }];
    expect(safeSpeedKmh(open, 120)).toBeCloseTo(120, 9);
    // a 110 m bend 200 m ahead: easing off already, but still quicker than the bend itself
    const bend = [{ curvature: 0, at: 0 }, { curvature: 1 / 110, at: 200 }];
    const now = safeSpeedKmh(bend, 160);
    const inBend = safeSpeedKmh([{ curvature: 1 / 110, at: 0 }], 160);
    expect(inBend).toBeCloseTo(Math.sqrt(3.2 * 110) * 3.6, 5);
    expect(now).toBeLessThan(160);
    expect(now).toBeGreaterThan(inBend);
  });

  it("brakes only when well over the target, and never on the gas at the same time", () => {
    const hold = new SpeedHold();
    const over = hold.update(150, 100, 1 / 60);
    expect(over.throttle).toBe(0);
    expect(over.brake).toBeGreaterThan(0);
    expect(new SpeedHold().update(102, 100, 1 / 60).brake).toBe(0);
    expect(new SpeedHold().update(40, 100, 1 / 60).throttle).toBe(1);
  });
});
