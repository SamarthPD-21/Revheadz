import { describe, expect, it } from "vitest";
import { chassisOf, stepHandling, tyreForce, type Motion } from "../lib/cruise/handling";
import { loadConfig } from "./helpers";

const supra = chassisOf(loadConfig("supra_mk4"), 4.6);
const OFF = { abs: false, tc: false, esc: false };
const ON = { abs: true, tc: true, esc: true };

/** Holds a speed and steering for `seconds`, returning the motion and how much it slid. */
function hold(vx: number, steer: number, mu: number, seconds: number, accel = 0.5, c = supra, aids = c.aids) {
  const m: Motion = { vy: 0, r: 0, delta: 0 };
  let slide = 0;
  for (let t = 0; t < seconds; t += 1 / 60) slide = stepHandling(m, c, { vx, steer, accel, mu, aids }, 1 / 60);
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
    expect(hold(25, 1, 1, 3, 0.2).slide).toBeLessThan(hold(25, 1, 0.45, 3, 0.2).slide);
    // hard on the power mid-bend with no aids: the tail comes round (it slides at the back)
    const calm = hold(18, 0.5, 0.8, 3, 0.3, supra, OFF).m;
    const power = hold(18, 0.5, 0.8, 3, 5, supra, OFF).m;
    const tail = (m: Motion) => Math.abs(Math.atan2(m.vy - supra.wheelbase * supra.front * m.r, 18));
    expect(tail(power)).toBeGreaterThan(tail(calm) * 1.5);
  });

  it("stays bounded even when it's thrown at a spin: a big slide, never a blow-up", () => {
    for (const mu of [1, 0.5, 0.35]) {
      const m: Motion = { vy: 0, r: 0, delta: 0 };
      for (let t = 0; t < 6; t += 1 / 60) stepHandling(m, supra, { vx: 40, steer: t % 2 < 1 ? 1 : -1, accel: 6, mu, aids: OFF }, 1 / 60);
      expect(Math.abs(m.vy)).toBeLessThanOrEqual(40 + 0.3 + 1e-9);
      expect(Number.isFinite(m.r)).toBe(true);
      expect(Math.abs(m.r)).toBeLessThan(2);
      expect(Number.isFinite(m.scrub)).toBe(true);
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

  it("brake into a bend and the nose bites while the tail goes light: the car tightens its line", () => {
    const steady = hold(22, 0.45, 1, 2.5, 0, supra, OFF).m;
    const m: Motion = { ...steady };
    for (let t = 0; t < 0.6; t += 1 / 60) stepHandling(m, supra, { vx: 22, steer: 0.45, accel: -7, mu: 1, aids: OFF }, 1 / 60);
    expect(Math.abs(m.r)).toBeGreaterThan(Math.abs(steady.r) * 1.05);
  });

  it("stability control catches what would otherwise be a spin, and it costs speed doing it", () => {
    const run = (aids: typeof ON) => {
      const m: Motion = { vy: 0, r: 0, delta: 0 };
      let scrub = 0;
      for (let t = 0; t < 2.5; t += 1 / 60) {
        stepHandling(m, supra, { vx: 25, steer: 0.8, accel: t > 1 ? -8 : 4, mu: 0.75, aids }, 1 / 60);
        scrub = Math.max(scrub, m.scrub ?? 0);
      }
      return { slip: Math.abs(Math.atan2(m.vy, 25)), scrub };
    };
    const off = run(OFF);
    const on = run(ON);
    expect(on.slip).toBeLessThan(off.slip);
    expect(on.scrub).toBeGreaterThan(0);
  });

  it("past its peak a tyre slides with less grip than it had (so a slide has to be caught)", () => {
    const load = 4000;
    const peak = 4000;
    let best = 0;
    let bestAt = 0;
    for (let a = 0; a < 0.6; a += 0.002) {
      const f = Math.abs(tyreForce(a, load, peak));
      if (f > best) [best, bestAt] = [f, a];
    }
    expect(best).toBeCloseTo(peak, 0);
    // the best grip comes at a few degrees of slip, like a road tyre's
    expect(bestAt).toBeGreaterThan(0.08);
    expect(bestAt).toBeLessThan(0.16);
    // well past it, it slides at around four-fifths of that
    const sliding = Math.abs(tyreForce(0.5, load, peak));
    expect(sliding).toBeLessThan(peak * 0.9);
    expect(sliding).toBeGreaterThan(peak * 0.7);
  });

  it("let go of the wheel early in a slide and it self-centres along it, catching the car", () => {
    const m: Motion = { vy: 0, r: 0, delta: 0 };
    let vx = 25;
    let slip = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      // a stab of power at full lock with no aids, then hands off (the slide costs speed, as in the game)
      const accel = t < 0.45 ? 3 : 0;
      stepHandling(m, supra, { vx, steer: t < 0.45 ? 1 : 0, accel, mu: 0.6, aids: OFF }, 1 / 60);
      vx += (accel - (m.scrub ?? 0) / supra.massKg) / 60;
      if (t < 0.7) slip = Math.max(slip, Math.abs(Math.atan2(m.vy, vx)));
    }
    expect(slip).toBeGreaterThan(0.06); // it did slide
    expect(Math.abs(Math.atan2(m.vy, vx))).toBeLessThan(0.01);
    expect(Math.abs(m.r)).toBeLessThan(0.02);
  });

  it("at motorway speed a hard turn and a let-go doesn't throw it the other way", () => {
    for (const mu of [1, 0.72]) {
      for (const aids of [supra.aids, ON]) {
        const m: Motion = { vy: 0, r: 0, delta: 0 };
        let vx = 45;
        let slip = 0;
        let back = 0;
        for (let t = 0; t < 4; t += 1 / 60) {
          const turning = t < 1.2;
          stepHandling(m, supra, { vx, steer: turning ? 1 : 0, accel: turning ? 1 : 0, mu, aids }, 1 / 60);
          vx += ((turning ? 1 : 0) - (m.scrub ?? 0) / supra.massKg) / 60;
          slip = Math.max(slip, Math.abs(Math.atan2(m.vy, vx)));
          // turning right: any yaw to the left after letting go is the car swinging back
          if (!turning) back = Math.min(back, m.r);
        }
        expect(slip).toBeLessThan(0.1); // a few degrees of slip at the limit, not a slide
        expect(back).toBeGreaterThan(-0.15);
        expect(Math.abs(m.r)).toBeLessThan(0.01);
      }
    }
  });

  it("with the wheels locked it hardly turns", () => {
    const rolling = hold(20, 0.6, 1, 1.5, -6, supra, OFF).m.r;
    const m: Motion = { vy: 0, r: 0, delta: 0 };
    for (let t = 0; t < 1.5; t += 1 / 60) stepHandling(m, supra, { vx: 20, steer: 0.6, accel: -6, mu: 1, aids: OFF, locked: true }, 1 / 60);
    expect(Math.abs(m.r)).toBeLessThan(Math.abs(rolling) * 0.5);
  });

  it("cornering hard costs speed", () => {
    expect(hold(25, 0, 1, 2).m.scrub ?? 0).toBeCloseTo(0, 6);
    expect(hold(25, 0.6, 1, 2).m.scrub ?? 0).toBeGreaterThan(200);
  });

  it("parks like a car: at walking pace it just follows the wheels", () => {
    const { m } = hold(1, 1, 1, 2);
    expect(m.vy).toBe(0);
    expect(m.r).toBeCloseTo((1 * Math.tan(m.delta)) / supra.wheelbase, 9);
  });
});
