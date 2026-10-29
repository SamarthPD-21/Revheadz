/**
 * Seeded 2D gradient noise (Perlin-style) and fractal sums of it. Pure and deterministic:
 * the same seed always grows the same landscape.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole-number hash of a lattice point, for per-tile or per-cell randomness. */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export type Noise2 = (x: number, y: number) => number;

/** Gradient noise in about -1..1, smooth (quintic fade), period 256 lattice cells. */
export function gradientNoise(seed: number): Noise2 {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = new Float32Array(256);
  const gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rand() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const X = xf & 255;
    const Y = yf & 255;
    const dx = x - xf;
    const dy = y - yf;
    const g = (ix: number, iy: number, ox: number, oy: number) => {
      const h = perm[perm[ix] + iy];
      return gx[h] * ox + gy[h] * oy;
    };
    const n00 = g(X, Y, dx, dy);
    const n10 = g(X + 1, Y, dx - 1, dy);
    const n01 = g(X, Y + 1, dx, dy - 1);
    const n11 = g(X + 1, Y + 1, dx - 1, dy - 1);
    const u = fade(dx);
    const v = fade(dy);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.414;
  };
}

/** Fractal sum of `octaves` layers, each twice the frequency and `gain` the amplitude; about -1..1. */
export function fbm(noise: Noise2, x: number, y: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    // offset each octave so their lattices don't line up
    sum += amp * noise(x * f + i * 17.3, y * f - i * 9.1);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
