import { describe, expect, it } from "vitest";
import { autoShift } from "../lib/cruise/autopilot";
import { brakeLimit, chassisOf, tractionLimit } from "../lib/cruise/handling";
import { roadModel, SPECS } from "../lib/cruise/specs";
import { Simulation } from "../lib/sim/Simulation";
import { vehicles } from "../lib/vehicles";

const STEP = 1 / 120;

/** Flat out from a standstill on dry tarmac, the way a road tester would: 0-100 time and top speed. */
function flatOut(id: string) {
  const cfg = vehicles.find((v) => v.id === id)!;
  const sim = new Simulation(cfg, () => 0.5);
  sim.model = roadModel(cfg);
  const ch = chassisOf(cfg, cfg.type === "bike" ? 2.1 : 4.5);
  sim.toggleIgnition();
  for (let i = 0; i < 150; i++) sim.step(STEP);
  sim.shiftUp();
  for (let i = 0; i < 60; i++) sim.step(STEP);
  // (a tester feathers the throttle where a car has no traction control)
  sim.input.tc = true;
  sim.input.throttle = 1;
  let t = 0;
  let t100 = NaN;
  let last = -9;
  let accel = 0;
  let top = 0;
  while (t < 100) {
    last = autoShift(sim, cfg, 1, t, last);
    const before = sim.state.speedKmh / 3.6;
    sim.input.traction = tractionLimit(ch, ch.tyre, accel, 0, before);
    sim.step(STEP);
    t += STEP;
    accel += ((sim.state.speedKmh / 3.6 - before) / STEP - accel) * 0.025;
    if (Number.isNaN(t100) && sim.state.speedKmh >= 100) t100 = t;
    top = Math.max(top, sim.state.speedKmh);
  }
  return { t100, top };
}

describe("cruise: the real cars", () => {
  it("make their rated power at their rated revs, and no more", () => {
    for (const cfg of vehicles) {
      const spec = SPECS[cfg.id];
      const model = roadModel(cfg);
      let peak = 0;
      for (let rpm = cfg.engine.idleRpm; rpm <= cfg.engine.limiterRpm; rpm += 25) peak = Math.max(peak, (model.torque(rpm) * rpm * Math.PI) / 30);
      expect(peak / 745.7, cfg.id).toBeLessThanOrEqual(spec.hp * 1.001);
      expect(peak / 745.7, cfg.id).toBeGreaterThan(spec.hp * 0.97);
    }
  });

  it("every car in the garage has its real figures", () => {
    for (const cfg of vehicles) expect(SPECS[cfg.id], cfg.id).toBeDefined();
  });

  // road-test figures are best-case launches by professionals: hold the model within reach of them
  it.each(vehicles.map((v) => v.id))("%s: 0-100 km/h and top speed like the real one", (id) => {
    const { t100, top } = flatOut(id);
    const spec = SPECS[id];
    expect(t100 / spec.t100).toBeGreaterThan(0.85);
    expect(t100 / spec.t100).toBeLessThan(1.27);
    expect(top / spec.vmax).toBeGreaterThan(0.93);
    expect(top / spec.vmax).toBeLessThan(1.09);
  });

  it("stops from 100 km/h in a real car's distance, and longer with locked wheels or in the wet", () => {
    const stop = (id: string, mu: number, abs: boolean) => {
      const cfg = vehicles.find((v) => v.id === id)!;
      const sim = new Simulation(cfg, () => 0.5);
      sim.model = roadModel(cfg);
      const ch = chassisOf(cfg, 4.5);
      sim.toggleIgnition();
      for (let i = 0; i < 150; i++) sim.step(STEP);
      sim.input.throttle = 1;
      let last = -9;
      let t = 0;
      while (sim.state.speedKmh < 100) {
        last = autoShift(sim, cfg, 1, t, last);
        sim.step(STEP);
        t += STEP;
      }
      sim.input.throttle = 0;
      sim.input.brake = 1;
      sim.input.abs = abs;
      sim.neutral();
      let d = 0;
      let locked = false;
      while (sim.state.speedKmh > 0.5) {
        sim.input.brakeGrip = brakeLimit(ch, ch.tyre * mu, sim.state.speedKmh / 3.6);
        sim.step(STEP);
        locked ||= Boolean(sim.state.locked);
        d += sim.state.speedKmh / 3.6 * STEP;
      }
      return { d, locked };
    };
    const dry = stop("supra_mk4", 1, true);
    expect(dry.d).toBeGreaterThan(34);
    expect(dry.d).toBeLessThan(44);
    expect(dry.locked).toBe(false);
    const wet = stop("supra_mk4", 0.72, true);
    expect(wet.d).toBeGreaterThan(dry.d * 1.15);
    const noAbs = stop("supra_mk4", 0.72, false);
    expect(noAbs.locked).toBe(true);
    expect(noAbs.d).toBeGreaterThan(wet.d * 1.1);
  });

  it("the Chiron stops pulling at its 420 km/h limiter", () => {
    expect(flatOut("bugatti_chiron").top).toBeLessThan(421);
  });
});
