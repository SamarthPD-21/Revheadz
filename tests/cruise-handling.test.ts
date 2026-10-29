import { describe, expect, it } from "vitest";
import { chassisOf, stepHandling, type Motion } from "../lib/cruise/handling";
import { loadConfig } from "./helpers";

const supra = chassisOf(loadConfig("supra_mk4"), 4.6);

/** Holds a speed and steering for `seconds`, returning the motion and how much it slid. */
function hold(vx: number, steer: number, mu: number, seconds: number, accel = 0.5, c = supra) {
  const m: Motion = { vy: 0, r: 0, delta: 0 };
  let slide = 0;
  for (let t = 0; t < seconds; t += 1 / 60) slide = stepHandling(m, c, { vx, steer, accel, mu }, 1 / 60);
  return { m, slide };
}

describe("cruise handling", () => {
  it("drives straight when the wheel is straight", () => {
    const { m } = hold(30, 0, 1, 5);
    expect(Math.abs(m.r)).toBeLessThan(1e-9);
    expect(Math.abs(m.vy)).toBeLessThan(1e-9);
  });

  it("turns right for right, left for left, and settles into a steady bend", () => {
    const right = hold(20, 0.5, 1, 4).m;
    const left = hold(20, -0.5, 1, 4).m;
    expect(right.r).toBeGreaterThan(0.05);
    expect(left.r).toBeCloseTo(-right.r, 6);
    const later = hold(20, 0.5, 1, 6).m;
    expect(later.r).toBeCloseTo(right.r, 2);
  });

  it("never corners harder than the tyres allow: grip caps the sideways acceleration", () => {
    for (const mu of [1, 0.5]) {
      const { m } = hold(30, 1, mu, 4, 0);
      const lat = Math.abs(30 * m.r);
      expect(lat).toBeLessThan(mu * 9.81 * 1.1);
      expect(lat).toBeGreaterThan(mu * 9.81 * 0.5);
    }
  });

  it("slides on grass where it grips on tarmac, and power makes a rear-drive car step out", () => {
    expect(hold(25, 0.35, 1, 3, 0.2).slide).toBeLessThan(hold(25, 0.35, 0.45, 3, 0.2).slide);
    // hard on the power mid-bend: the tail comes round (more yaw for the same steering)
    const calm = hold(18, 0.5, 0.8, 3, 0.3).m.r;
    const power = hold(18, 0.5, 0.8, 3, 5).m.r;
    expect(power).toBeGreaterThan(calm);
  });

  it("stays bounded even when it's thrown at a spin: a big slide, never a blow-up", () => {
    for (const mu of [1, 0.5, 0.35]) {
      const m: Motion = { vy: 0, r: 0, delta: 0 };
      for (let t = 0; t < 6; t += 1 / 60) stepHandling(m, supra, { vx: 40, steer: t % 2 < 1 ? 1 : -1, accel: 6, mu }, 1 / 60);
      expect(Math.abs(m.vy)).toBeLessThanOrEqual(0.58 * 40 + 0.3 + 1e-9);
      expect(Number.isFinite(m.r)).toBe(true);
      expect(Math.abs(m.r)).toBeLessThan(2);
    }
  });

  it("turns hard at speed when asked, right up to the grip (the aids don't hold it back)", () => {
    for (const mu of [1, 0.55]) {
      const { m } = hold(30, 1, mu, 3, 0.5);
      expect(Math.abs(30 * m.r)).toBeGreaterThan(mu * 9.81 * 0.75);
    }
  });

  it("comes back out of a slide once you straighten the wheel", () => {
    const hellcat = chassisOf(loadConfig("hellcat"), 5);
    const m: Motion = { vy: 0, r: 0, delta: 0 };
    for (let t = 0; t < 1.1; t += 1 / 60) stepHandling(m, hellcat, { vx: 35, steer: 1, accel: 2.5, mu: 0.55 }, 1 / 60);
    expect(Math.abs(m.vy)).toBeGreaterThan(2); // it did slide
    for (let t = 0; t < 2.5; t += 1 / 60) stepHandling(m, hellcat, { vx: 35, steer: 0, accel: 2.5, mu: 0.55 }, 1 / 60);
    // what's left is a few degrees of ordinary slip with the power still hard on, on grass
    expect(Math.abs(m.vy)).toBeLessThan(2.5);
    expect(Math.abs(m.r)).toBeLessThan(0.2);
  });

  it("parks like a car: at walking pace it just follows the wheels", () => {
    const { m } = hold(1, 1, 1, 2);
    expect(m.vy).toBe(0);
    expect(m.r).toBeCloseTo((1 * Math.tan(m.delta)) / supra.wheelbase, 9);
  });
});
