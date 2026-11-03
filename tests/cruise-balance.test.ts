import { describe, expect, it } from "vitest";
import { chassisOf, stepHandling, tractionLimit, type Motion } from "../lib/cruise/handling";
import { SPECS } from "../lib/cruise/specs";
import { vehicles } from "../lib/vehicles";
import { loadConfig } from "./helpers";

const AIDS = { abs: true, tc: true, esc: false };

/** A steady circle at a fixed speed, the steering wound on slowly: the most cornering held (g), and the
 * understeer at half a g (degrees of steering beyond the geometric angle, per g). */
function skidpad(id: string, vx = 22) {
  const c = chassisOf(loadConfig(id), 4.5);
  const m: Motion = { vy: 0, r: 0, delta: 0 };
  let best = 0;
  let deltaAtHalf = NaN;
  for (let t = 0; t < 12; t += 1 / 120) {
    stepHandling(m, c, { vx, steer: Math.min(1, t / 10), accel: 0, mu: c.tyre, aids: AIDS }, 1 / 120);
    const g = Math.abs(vx * m.r) / 9.81;
    if (Number.isNaN(deltaAtHalf) && g >= 0.5) deltaAtHalf = m.delta;
    best = Math.max(best, g);
  }
  const geometric = (c.wheelbase * 0.5 * 9.81) / (vx * vx);
  return { g: best, understeer: ((deltaAtHalf - geometric) * 57.3) / 0.5 };
}

describe("cruise: each car's balance in a bend", () => {
  it.each(vehicles.filter((v) => v.type === "car").map((v) => v.id))("%s holds about its real skidpad figure", (id) => {
    const { g } = skidpad(id);
    expect(g / SPECS[id].g).toBeGreaterThan(0.86);
    expect(g / SPECS[id].g).toBeLessThan(1.1);
  });

  it("nose-heavy saloons push wide, mid-engined cars are near neutral, a single-seater is sharpest", () => {
    const us = (id: string) => skidpad(id).understeer;
    const saloon = us("amg_c63");
    const muscle = us("hellcat");
    const sports = us("supra_mk4");
    const mid = us("ferrari_f40");
    const f1 = us("ferrari_f2004");
    for (const u of [saloon, muscle, sports, mid, f1]) expect(u).toBeGreaterThan(0); // all stable
    expect(saloon).toBeGreaterThan(sports + 0.5);
    expect(muscle).toBeGreaterThan(sports + 0.5);
    expect(sports).toBeGreaterThan(mid + 0.5);
    expect(mid).toBeGreaterThan(f1);
    // and within what real cars measure (about 0.5 to 4 degrees per g)
    expect(saloon).toBeLessThan(4.5);
    expect(f1).toBeGreaterThan(0.3);
  });

  it("a bend banked into the turn helps the car round; a road leaning the other way pushes it out", () => {
    const c = chassisOf(loadConfig("supra_mk4"), 4.6);
    const run = (bank: number) => {
      const m: Motion = { vy: 0, r: 0, delta: 0 };
      for (let t = 0; t < 4; t += 1 / 60) stepHandling(m, c, { vx: 25, steer: 0.4, accel: 0, mu: c.tyre, aids: AIDS, bank }, 1 / 60);
      return m;
    };
    const flat = run(0);
    const into = run(0.08); // right-hand bend, its right side lower
    const away = run(-0.08);
    // sideways speed: the car is carried towards the inside of the bend, or off it
    expect(into.vy).toBeGreaterThan(flat.vy);
    expect(away.vy).toBeLessThan(flat.vy);
  });

  it("parked across a slope, the tyres hold it", () => {
    const c = chassisOf(loadConfig("supra_mk4"), 4.6);
    const m: Motion = { vy: 0, r: 0, delta: 0 };
    for (let t = 0; t < 3; t += 1 / 60) stepHandling(m, c, { vx: 0, steer: 0, accel: 0, mu: c.tyre, aids: AIDS, bank: 0.3 }, 1 / 60);
    expect(Math.abs(m.vy)).toBeLessThan(1e-6);
  });

  it("an open diff loses drive to the unloaded inside wheel out of a bend; a limited-slip diff doesn't", () => {
    const open = chassisOf(loadConfig("flat6_sports"), 4.3);
    const lsd = chassisOf(loadConfig("supra_mk4"), 4.5);
    expect(open.diff).toBe("open");
    expect(lsd.diff).toBe("lsd");
    const ratio = (c: typeof open) => tractionLimit(c, c.tyre, 2, 0, 20, 7) / tractionLimit(c, c.tyre, 2, 0, 20, 0);
    expect(ratio(open)).toBeLessThan(0.9);
    expect(ratio(lsd)).toBeCloseTo(1, 6);
  });
});
