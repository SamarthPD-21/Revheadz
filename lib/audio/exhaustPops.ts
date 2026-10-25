/**
 * Exhaust pops and bangs, synthesised per engine.
 *
 * A real overrun pop is unburnt fuel lighting off in the exhaust: a pressure spike with an
 * N-shaped wave (a sharp push, then a smaller pull) that rings the exhaust pipe at its
 * resonances, with a low boom underneath and a bright crack on top. On the overrun they come
 * in irregular clusters (the "crackle"); a big lift at high revs ends in a proper bang. Out on
 * a strip each one also slaps back off the walls a few tens of milliseconds later.
 *
 * Each car gets its own bank, tuned by how its exhaust would ring (fewer, bigger cylinders
 * sound deeper), and seeded so the same car always pops the same way.
 */

export interface PopBank {
  /** A single big bang, sometimes with a small pop just ahead of it. */
  bangs: AudioBuffer[];
  /** Clusters of small pops for the overrun. */
  crackles: AudioBuffer[];
}

interface Engine {
  cylinders: number;
  bike: boolean;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RBJ biquad over a whole array. */
function biquad(x: Float32Array, sr: number, type: "bp" | "lp" | "hp", f: number, q: number): Float32Array {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === "bp") [b0, b1, b2] = [alpha, 0, -alpha];
  else if (type === "lp") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** The fundamental the exhaust rings at: big-bore V8s low and deep, small fast engines higher. */
function pipeHz(e: Engine) {
  if (e.bike) return 320;
  if (e.cylinders <= 4) return 245;
  if (e.cylinders <= 6) return 210;
  if (e.cylinders <= 8) return 160;
  return 225; // V10, V12, W16: many small cylinders, a harder, higher crack
}

/** Renders pops at the given times (s), amplitudes and sizes into one finished buffer. */
function render(ctx: BaseAudioContext, e: Engine, seconds: number, pops: { at: number; amp: number; size: number }[], rand: () => number, tune: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.round(seconds * sr);
  // excitation: an N-wave pressure pulse plus a very short burst of noise for each pop
  const ex = new Float32Array(n);
  for (const p of pops) {
    const i0 = Math.round(p.at * sr);
    const push = 0.0012 * p.size;
    const pull = push * 1.4;
    const len = Math.round((push + pull + 0.004) * sr);
    for (let k = 0; k < len && i0 + k < n; k++) {
      const t = k / sr;
      const wave = t < push ? Math.sin((Math.PI * t) / push) : t < push + pull ? -0.55 * Math.sin((Math.PI * (t - push)) / pull) : 0;
      const noise = (rand() * 2 - 1) * Math.exp(-t / (0.0007 * p.size));
      ex[i0 + k] += p.amp * (wave + noise * 0.9);
    }
  }
  // the exhaust: three pipe resonances, a low boom and a bright crack
  const f0 = pipeHz(e) * tune;
  const r1 = biquad(ex, sr, "bp", f0, 4);
  const r2 = biquad(ex, sr, "bp", f0 * 2.07, 5);
  const r3 = biquad(ex, sr, "bp", f0 * 3.31, 6);
  const boom = biquad(biquad(ex, sr, "lp", e.bike ? 140 : 110, 0.9), sr, "lp", 160, 0.7);
  const crack = biquad(ex, sr, "hp", 2400, 0.7);
  const dry = new Float32Array(n);
  for (let i = 0; i < n; i++) dry[i] = Math.tanh((r1[i] * 3.2 + r2[i] * 2.2 + r3[i] * 1.4 + boom[i] * 2.4 + crack[i] * 0.9) * 1.6);
  // the slap back off the walls: two darker, quieter repeats
  const echo = biquad(dry, sr, "lp", 2200, 0.7);
  const d1 = Math.round(0.034 * sr);
  const d2 = Math.round(0.087 * sr);
  const out = ctx.createBuffer(1, n, sr);
  const data = out.getChannelData(0);
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    const v = dry[i] + (i >= d1 ? echo[i - d1] * 0.3 : 0) + (i >= d2 ? echo[i - d2] * 0.16 : 0);
    data[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  const fadeN = Math.round(0.03 * sr);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, (n - 1 - i) / fadeN);
    data[i] = (data[i] / peak) * 0.9 * fade;
  }
  return out;
}

export function exhaustPops(ctx: BaseAudioContext, e: Engine, seed = 1): PopBank {
  const rand = mulberry32(seed * 7919 + e.cylinders);
  const bangs: AudioBuffer[] = [];
  for (let v = 0; v < 3; v++) {
    const pops = [];
    // about half the bangs get a little "p-" ahead of them
    if (rand() < 0.55) pops.push({ at: 0.004, amp: 0.25 + rand() * 0.2, size: 0.6 });
    pops.push({ at: pops.length ? 0.03 + rand() * 0.03 : 0.004, amp: 1, size: 1.4 + rand() * 0.5 });
    bangs.push(render(ctx, e, 0.5, pops, rand, 0.94 + rand() * 0.12));
  }
  const crackles: AudioBuffer[] = [];
  for (let v = 0; v < 5; v++) {
    const pops = [];
    let at = 0.004;
    const count = 3 + Math.floor(rand() * 5);
    for (let k = 0; k < count; k++) {
      pops.push({ at, amp: 0.3 + rand() * 0.6, size: 0.55 + rand() * 0.45 });
      // irregular spacing, mostly tight with the odd gap, like fuel lighting off unevenly
      at += 0.016 + Math.pow(rand(), 2) * 0.06;
    }
    crackles.push(render(ctx, e, at + 0.16, pops, rand, 0.92 + rand() * 0.16));
  }
  return { bangs, crackles };
}
