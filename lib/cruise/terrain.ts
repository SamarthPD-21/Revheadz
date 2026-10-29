import { clamp, fbm, gradientNoise, lerp, smoothstep, type Noise2 } from "./noise";
import { ROAD_HALF, Road, WATER_Y } from "./road";

export type RGB = [number, number, number];

/** Past this distance from the road the ground is left wild (mountains at full height), m. */
export const WILD_M = 420;

const LUSH: RGB = [0.2, 0.38, 0.13];
const MEADOW: RGB = [0.45, 0.5, 0.2];
const DRY: RGB = [0.66, 0.56, 0.32];
const SAND: RGB = [0.78, 0.7, 0.5];
const ROCK: RGB = [0.4, 0.38, 0.36];
const SNOW: RGB = [0.93, 0.95, 1];
const VERGE: RGB = [0.36, 0.33, 0.25];

/** What a point of ground is like, for colouring it and planting it. */
export interface Ground {
  y: number;
  color: RGB;
  /** 0-1: how likely a tree is to grow here. */
  trees: number;
  /** 0 lush .. 1 desert. */
  dry: number;
}

/**
 * The world: a road and the land around it, both grown from one seed. Rolling hills
 * everywhere; mountains that rise only away from the road (so it threads valleys between
 * them); lakes and sea wherever the ground falls below WATER_Y. Biomes drift slowly from
 * lush forest through meadow to dry, sandy country.
 */
export class Landscape {
  readonly road: Road;
  private readonly nBase: Noise2;
  private readonly nHill: Noise2;
  private readonly nMask: Noise2;
  private readonly nRidge: Noise2;
  private readonly nDry: Noise2;
  private readonly nForest: Noise2;
  private readonly nTint: Noise2;

  constructor(readonly seed: number) {
    this.nBase = gradientNoise(seed + 1);
    this.nHill = gradientNoise(seed + 2);
    this.nMask = gradientNoise(seed + 3);
    this.nRidge = gradientNoise(seed + 4);
    this.nDry = gradientNoise(seed + 5);
    this.nForest = gradientNoise(seed + 6);
    this.nTint = gradientNoise(seed + 7);
    this.road = new Road(seed, (x, z) => this.hills(x, z));
  }

  /** The gentle part of the land: what the road rides on. */
  hills(x: number, z: number): number {
    return fbm(this.nBase, x / 900, z / 900, 4) * 42 + 16 + fbm(this.nHill, x / 240, z / 240, 3) * 9;
  }

  /** Mountain ridges (sharp crests from folded noise), only where the slow mask allows. */
  ridge(x: number, z: number): number {
    const mask = smoothstep(0.05, 0.55, fbm(this.nMask, x / 2400, z / 2400, 3));
    if (mask <= 0) return 0;
    const r = 1 - Math.abs(fbm(this.nRidge, x / 650, z / 650, 5, 0.52));
    return r * r * 230 * mask;
  }

  dryness(x: number, z: number): number {
    return smoothstep(-0.35, 0.45, fbm(this.nDry, x / 3200, z / 3200, 2));
  }

  /** The ground at a point, given its distance from the road and the road's height there. */
  ground(x: number, z: number, roadDist: number, roadY: number): Ground {
    const wild = smoothstep(40, WILD_M, roadDist);
    const raw = this.hills(x, z) + this.ridge(x, z) * wild;
    // a flat verge just under the road (clear of its banking), then a bank up or down to the land
    const blend = smoothstep(ROAD_HALF + 1.2, ROAD_HALF + 30, roadDist);
    const y = lerp(roadY - 0.5, raw, blend);

    const dry = this.dryness(x, z);
    const tint = fbm(this.nTint, x / 90, z / 90, 2);
    let c: RGB = dry < 0.5 ? mix(LUSH, MEADOW, dry * 2) : mix(MEADOW, DRY, (dry - 0.5) * 2);
    c = scale(c, 1 + tint * 0.18);
    // steepness, from the land's slope at this point
    const e = 2;
    const sx = (this.heightRaw(x + e, z, wild) - this.heightRaw(x - e, z, wild)) / (2 * e);
    const sz = (this.heightRaw(x, z + e, wild) - this.heightRaw(x, z - e, wild)) / (2 * e);
    const slope = Math.hypot(sx, sz) * blend;
    c = mix(c, ROCK, smoothstep(0.45, 0.95, slope));
    const snowLine = 150 + tint * 40;
    c = mix(c, SNOW, smoothstep(snowLine, snowLine + 25, y) * (1 - smoothstep(0.9, 1.4, slope)));
    c = mix(c, SAND, 1 - smoothstep(WATER_Y + 0.5, WATER_Y + 3.5, y));
    c = mix(VERGE, c, smoothstep(ROAD_HALF + 0.5, ROAD_HALF + 5, roadDist));

    const forest = smoothstep(-0.15, 0.35, fbm(this.nForest, x / 520, z / 520, 2));
    let trees = forest * (1 - dry * 0.9) + (1 - dry) * 0.08;
    trees *= smoothstep(ROAD_HALF + 4, ROAD_HALF + 9, roadDist); // keep the verge clear
    trees *= 1 - smoothstep(0.6, 1, slope); // nothing clings to cliffs
    trees *= smoothstep(WATER_Y + 2, WATER_Y + 4, y) * (1 - smoothstep(snowLine - 30, snowLine, y));
    return { y, color: c, trees: clamp(trees, 0, 1), dry };
  }

  private heightRaw(x: number, z: number, wild: number) {
    return this.hills(x, z) + this.ridge(x, z) * wild;
  }
}

const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];

/**
 * Distances from many points to the road, fast: the road samples near a patch are gathered
 * once, then each point checks every eighth one and refines around the closest.
 */
export class RoadDistance {
  private coarse: number[] = [];
  private pts: Float64Array = new Float64Array(0);
  private count = 0;
  /** The road sample the last query found nearest (-1 if there was none). */
  lastIndex = -1;

  constructor(private readonly road: Road) {}

  /** Gathers the road near the box (plus `reach` around it). */
  prepare(x0: number, z0: number, x1: number, z1: number, reach: number): void {
    const idx = this.road.samplesNear(x0 - reach, z0 - reach, x1 + reach, z1 + reach);
    this.count = idx.length;
    this.pts = new Float64Array(idx.length * 4);
    idx.forEach((i, k) => {
      const [x, y, z] = this.road.sample(i);
      this.pts[k * 4] = x;
      this.pts[k * 4 + 1] = y;
      this.pts[k * 4 + 2] = z;
      this.pts[k * 4 + 3] = i;
    });
    this.coarse = [];
    for (let k = 0; k < this.count; k += 8) this.coarse.push(k);
    if (this.count && this.coarse[this.coarse.length - 1] !== this.count - 1) this.coarse.push(this.count - 1);
  }

  /** [distance, road height there] for a point; [Infinity, 0] with no road nearby. */
  query(x: number, z: number, out: [number, number] = [0, 0]): [number, number] {
    const p = this.pts;
    if (!this.count) {
      out[0] = Infinity;
      out[1] = 0;
      this.lastIndex = -1;
      return out;
    }
    let best = Infinity;
    let bk = 0;
    for (const k of this.coarse) {
      const dx = p[k * 4] - x;
      const dz = p[k * 4 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bk = k;
      }
    }
    // the closest coarse sample may be on another pass of the road; refine around it
    for (let k = Math.max(0, bk - 9); k <= Math.min(this.count - 1, bk + 9); k++) {
      const dx = p[k * 4] - x;
      const dz = p[k * 4 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bk = k;
      }
    }
    out[0] = Math.sqrt(best);
    out[1] = p[bk * 4 + 1];
    this.lastIndex = p[bk * 4 + 3];
    return out;
  }
}
