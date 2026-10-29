import { describe, expect, it } from "vitest";
import { FrameGate } from "../lib/cruise/frameGate";

/** Runs a screen of `hz` for 5 s with a frame-rate cap; returns frames a second and the gaps between them. */
function screen(hz: number, fps: number) {
  const gate = new FrameGate();
  const drawn: number[] = [];
  for (let i = 0; i < hz * 5; i++) {
    const t = (i * 1000) / hz + Math.sin(i * 1.7) * 0.15; // a touch of timing jitter, like a real browser
    if (gate.tick(t, fps)) drawn.push(t);
  }
  const late = drawn.filter((t) => t > 1000); // after the screen has been measured
  const gaps = late.slice(1).map((t, i) => t - late[i]);
  return { fps: (late.length - 1) / ((late.at(-1)! - late[0]) / 1000), maxGap: Math.max(...gaps), gate };
}

describe("cruise frame pacing", () => {
  it("measures the screen's refresh rate", () => {
    for (const hz of [60, 90, 144, 165, 240]) expect(1000 / screen(hz, 0).gate.screenMs).toBeCloseTo(hz, 0);
  });

  it("holds the chosen frame rate on a faster screen, with no frame more than a refresh late", () => {
    for (const [hz, fps] of [[144, 90], [165, 90], [240, 90], [144, 120], [120, 90], [90, 60], [144, 60]]) {
      const r = screen(hz, fps);
      expect([hz, fps, Math.round(r.fps)]).toEqual([hz, fps, fps]);
      expect(r.maxGap).toBeLessThan(1000 / fps + 1000 / hz + 0.5);
    }
  });

  it("draws every refresh when the screen is slower than the cap, or with no cap", () => {
    for (const [hz, fps] of [[60, 90], [60, 120], [144, 0], [90, 90]]) expect(Math.round(screen(hz, fps).fps)).toBe(hz);
  });

  it("tunes the picture for whichever is slower: the cap or the screen", () => {
    expect(screen(144, 90).gate.targetMs(90)).toBeCloseTo(1000 / 90, 5);
    expect(screen(60, 90).gate.targetMs(90)).toBeCloseTo(1000 / 60, 0);
    expect(screen(144, 0).gate.targetMs(0)).toBeCloseTo(1000 / 144, 0);
  });
});
