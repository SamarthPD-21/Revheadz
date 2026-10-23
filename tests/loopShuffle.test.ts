import { describe, expect, it } from "vitest";
import { shuffleLoop } from "../lib/audio/loopShuffle";

const SR = 44100;

/** Just enough of AudioBuffer / BaseAudioContext for shuffleLoop. */
class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(channels: number, length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  get numberOfChannels() {
    return this.data.length;
  }
  get length() {
    return this.data[0].length;
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number) {
    return this.data[c];
  }
  copyToChannel(src: Float32Array, c: number) {
    this.data[c].set(src);
  }
}
const ctx = { createBuffer: (c: number, n: number, sr: number) => new FakeBuffer(c, n, sr) } as unknown as BaseAudioContext;

/** An engine-like loop: a whole number of cycles of a harmonic comb at rpm/120 Hz, plus noise. */
function engineLoop(rpm: number, seconds: number, noise = 0.05) {
  const f0 = rpm / 120;
  const cycles = Math.max(1, Math.round(seconds * f0));
  const n = Math.round((cycles / f0) * SR);
  const b = new FakeBuffer(1, n, SR);
  const x = b.getChannelData(0);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * cycles; // in cycles, so the loop is seamless
    let v = 0;
    for (let h = 1; h <= 24; h++) v += Math.sin(2 * Math.PI * h * t + h * 0.7) / h;
    x[i] = 0.3 * v + noise * rand();
  }
  return b as unknown as AudioBuffer;
}

/** Largest sample-to-sample jump, as a multiple of the signal's typical step (catches clicks). */
function worstStep(y: Float32Array, wrap: boolean) {
  const steps: number[] = [];
  for (let i = 1; i < y.length; i++) steps.push(Math.abs(y[i] - y[i - 1]));
  if (wrap) steps.push(Math.abs(y[0] - y[y.length - 1]));
  const sorted = [...steps].sort((a, b) => a - b);
  return sorted[sorted.length - 1] / sorted[Math.floor(sorted.length * 0.99)];
}

describe("loop shuffling", () => {
  it("leaves long loops alone", () => {
    const b = engineLoop(3000, 3);
    expect(shuffleLoop(ctx, b, { rpm: 3000 })).toBe(b);
  });

  for (const rpm of [900, 3000, 7000, 15000]) {
    it(`makes a short ${rpm} rpm loop several seconds long without clicks or level dips`, () => {
      const b = engineLoop(rpm, 0.45);
      const out = shuffleLoop(ctx, b, { rpm, seconds: 5, seed: rpm });
      expect(out.duration).toBeGreaterThan(4.5);
      expect(out.duration).toBeLessThan(5.6);
      const y = out.getChannelData(0);
      // splices (including the wrap back to the start) are no worse than the signal's own steepest 1%
      expect(worstStep(y, true)).toBeLessThan(2.5);
      // no level dips at crossfades: the quietest 10 ms is about as loud as the original loop's quietest
      const x = b.getChannelData(0);
      const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
      const win = Math.round(0.01 * SR);
      const quietest = (a: Float32Array) => {
        let m = Infinity;
        for (let i = 0; i + win < a.length; i += Math.round(win / 4)) m = Math.min(m, rms(a.subarray(i, i + win)));
        return m;
      };
      expect(quietest(y)).toBeGreaterThan(quietest(x) * 0.7);
    });
  }
});
