import { describe, expect, it } from "vitest";
import { RunTimer } from "../lib/track/runTimer";

/** Drives the timer with a car accelerating at `a` m/s² from rest, sampled at `hz`. */
function accelerate(timer: RunTimer, a: number, seconds: number, hz = 60, t0 = 1, x0 = 500) {
  for (let i = 0; i <= seconds * hz; i++) {
    const t = i / hz;
    timer.update(t0 + t, x0 + 0.5 * a * t * t, a * t * 3.6);
  }
}

describe("proving ground timer", () => {
  it("times speed and distance splits to about a millisecond from frame samples", () => {
    const timer = new RunTimer();
    for (let i = 0; i < 40; i++) timer.update(i / 60, 500, 0); // sitting still: armed
    expect(timer.armed).toBe(true);
    accelerate(timer, 5, 25, 60, 40 / 60);
    // v = a t, x = a t² / 2; the run starts when the car passes 0.5 km/h
    const t0 = 0.5 / 3.6 / 5;
    const r = timer.results;
    expect(r["0-100"].ms).toBeCloseTo((100 / 3.6 / 5 - t0) * 1000, 0);
    expect(r["100-200"].ms).toBeCloseTo((100 / 3.6 / 5) * 1000, 0);
    const d0 = 0.5 * 5 * t0 * t0;
    const tq = Math.sqrt((2 * (402.336 + d0)) / 5);
    expect(r["1/4"].ms).toBeCloseTo((tq - t0) * 1000, 0);
    expect(r["1/4"].kmh).toBeCloseTo(5 * tq * 3.6, 1);
    expect(timer.topKmh).toBeCloseTo(5 * 25 * 3.6, 6);
    expect(r["0-300"].ms).toBeCloseTo((300 / 3.6 / 5 - t0) * 1000, 0); // 25 s at 5 m/s² reaches 450 km/h
  });

  it("only times launches from a standstill, and keeps the last results until the next one", () => {
    const timer = new RunTimer();
    timer.update(0, 0, 80); // already moving when the page opened
    accelerate(timer, 4, 5, 60, 0.02, 0);
    expect(timer.running).toBe(false);
    expect(Object.keys(timer.results)).toHaveLength(0);
    // come to a stop, wait, launch: timed
    for (let i = 0; i < 30; i++) timer.update(10 + i / 60, 300, 0);
    accelerate(timer, 4, 10, 60, 10.5, 300);
    expect(timer.results["0-100"]).toBeDefined();
    const first = timer.results["0-100"].ms;
    for (let i = 0; i < 30; i++) timer.update(30 + i / 60, 600, 0);
    expect(timer.results["0-100"].ms).toBe(first); // still shown while stopped
    accelerate(timer, 6, 2, 60, 31, 600);
    expect(timer.results["0-100"]).toBeUndefined(); // new run, not there yet
  });
});
