import { describe, expect, it } from "vitest";
import { exhaustPops } from "../lib/audio/exhaustPops";

/** Just enough of an AudioContext to render buffers into plain arrays. */
const fakeCtx = () =>
  ({
    sampleRate: 44100,
    createBuffer: (_ch: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
    },
  }) as unknown as BaseAudioContext;

describe("exhaust pops", () => {
  it("makes finite, normalised bangs and crackle clusters for every kind of engine", () => {
    for (const e of [{ cylinders: 4, bike: true }, { cylinders: 6, bike: false }, { cylinders: 8, bike: false }, { cylinders: 12, bike: false }]) {
      const bank = exhaustPops(fakeCtx(), e, 3);
      expect(bank.bangs).toHaveLength(3);
      expect(bank.crackles).toHaveLength(5);
      for (const b of [...bank.bangs, ...bank.crackles]) {
        const d = b.getChannelData(0);
        let peak = 0;
        for (const v of d) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
        }
        expect(peak).toBeGreaterThan(0.8);
        expect(peak).toBeLessThanOrEqual(0.91);
        expect(Math.abs(d[d.length - 1])).toBeLessThan(1e-3); // faded out, no click at the end
      }
    }
  }, 20000); // synthesises every car in the garage: slow when the machine is busy

  it("is the same every time for the same car", () => {
    const a = exhaustPops(fakeCtx(), { cylinders: 8, bike: false }, 42).crackles[2].getChannelData(0);
    const b = exhaustPops(fakeCtx(), { cylinders: 8, bike: false }, 42).crackles[2].getChannelData(0);
    expect(a).toEqual(b);
  });
});
