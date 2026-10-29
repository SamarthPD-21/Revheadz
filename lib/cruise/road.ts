import { mulberry32, smoothstep } from "./noise";

/** Half the road's width: two 3.6 m lanes and a strip of shoulder each side, m. */
export const ROAD_HALF = 4.2;
/** Where the middle of the right-hand lane is, from the centre line, m. */
export const LANE_OFFSET = 1.9;
/** Spacing of the road's samples along its length, m. */
export const STEP = 2;
/** The sea (and every lake) sits at this height; the road never dips below it. */
export const WATER_Y = 0;
/** The steepest the road ever climbs or falls, as a fraction (8%). */
const MAX_GRADE = 0.08;
/** The road's height is the ground's averaged over this many samples either side. */
const Y_WINDOW = 70;
/** The tightest bend, m of radius. */
const MIN_RADIUS = 110;
/** Road is laid this far past what has been asked for, so its height window is always full. */
const LEAD = (Y_WINDOW + 2) * STEP;

export interface RoadPoint {
  x: number;
  y: number;
  z: number;
  /** Direction of travel in the ground plane, radians: (cos, sin) in (x, z). */
  heading: number;
  /** 1/radius, + bends right. */
  curvature: number;
  /** Rise per metre. */
  grade: number;
}

/** How much the road leans into a bend: how far it drops per metre towards the inside of it. */
export const bankOf = (curvature: number): number => Math.max(-0.05, Math.min(0.05, curvature * 30));

/** Height of the road's surface `d` metres right of the centre line, banked into bends. */
export const surfaceY = (p: RoadPoint, d: number): number => p.y - bankOf(p.curvature) * d;

/** The right-hand side of the road at this heading (y up, so right is (-sin, cos)). */
export const rightOf = (heading: number): [number, number] => [-Math.sin(heading), Math.cos(heading)];

class Growable {
  data = new Float64Array(4096);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

/**
 * A road that never ends, laid out as you go: a seeded wander of bends and straights over
 * the hills. Sample i sits at arc length i * STEP. Deterministic for a seed, whatever order
 * it is asked about in.
 */
export class Road {
  private readonly xs = new Growable();
  private readonly zs = new Growable();
  private readonly hs = new Growable();
  private readonly ground = new Growable();
  private readonly ys = new Growable();
  /** Spatial hash of sample indices, 32 m cells, for "how far is the road from here". */
  private readonly cells = new Map<number, number[]>();
  private readonly waves: { amp: number; k: number; phase: number }[];
  private readonly straight: { k: number; phase: number };
  private readonly twist: { k: number; phase: number };

  constructor(
    seed: number,
    /** The lie of the land the road follows (no mountains: those keep away from it). */
    private readonly groundAt: (x: number, z: number) => number,
  ) {
    const rand = mulberry32(seed ^ 0x5eed);
    const wave = (len: number, amp: number) => ({ amp, k: (2 * Math.PI) / len, phase: rand() * Math.PI * 2 });
    this.waves = [wave(1300, 1 / 320), wave(530, 1 / 300), wave(240, 1 / 520)];
    this.straight = { k: (2 * Math.PI) / 3100, phase: rand() * Math.PI * 2 };
    this.twist = { k: (2 * Math.PI) / 5200, phase: rand() * Math.PI * 2 };
    this.xs.push(0);
    this.zs.push(0);
    this.hs.push(0);
    this.ground.push(groundAt(0, 0));
    this.index(0);
  }

  /** Curvature at arc length s: bends, now and then a long straight, now and then a twisty stretch. */
  curvatureAt(s: number): number {
    let k = 0;
    for (const w of this.waves) k += w.amp * Math.sin(w.k * s + w.phase);
    const straight = smoothstep(-0.25, 0.35, Math.sin(this.straight.k * s + this.straight.phase));
    const twist = 0.65 + 0.7 * smoothstep(-0.2, 0.6, Math.sin(this.twist.k * s + this.twist.phase));
    k *= straight * twist;
    return Math.max(-1 / MIN_RADIUS, Math.min(1 / MIN_RADIUS, k));
  }

  /** How far along the road has been laid (with heights), m. */
  get length(): number {
    return (this.ys.length - 1) * STEP;
  }

  /** Lays road (with heights) out to at least arc length s. */
  ensure(s: number): void {
    const need = Math.ceil(s / STEP) + 1;
    while (this.xs.length < need + Y_WINDOW + 2) this.extendPlan();
    while (this.ys.length < need) this.extendHeight();
  }

  private extendPlan() {
    const i = this.xs.length;
    const s0 = (i - 1) * STEP;
    const h0 = this.hs.data[i - 1];
    // integrate the heading over the step (midpoint rule), then move along the mean heading
    const h1 = h0 + this.curvatureAt(s0 + STEP / 2) * STEP;
    const hm = (h0 + h1) / 2;
    const x = this.xs.data[i - 1] + Math.cos(hm) * STEP;
    const z = this.zs.data[i - 1] + Math.sin(hm) * STEP;
    this.xs.push(x);
    this.zs.push(z);
    this.hs.push(h1);
    this.ground.push(this.groundAt(x, z));
    this.index(i);
  }

  private extendHeight() {
    const i = this.ys.length;
    // the land averaged along the road, so it rides the hills without every bump
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - Y_WINDOW); j <= i + Y_WINDOW; j++) {
      sum += this.ground.data[j];
      n++;
    }
    let y = Math.max(WATER_Y + 1.6, sum / n);
    if (i > 0) {
      const prev = this.ys.data[i - 1];
      y = Math.max(prev - MAX_GRADE * STEP, Math.min(prev + MAX_GRADE * STEP, y));
    }
    this.ys.push(y);
  }

  private cellKey(x: number, z: number) {
    return (Math.floor(x / 32) + 32768) * 65536 + (Math.floor(z / 32) + 32768);
  }

  private index(i: number) {
    const key = this.cellKey(this.xs.data[i], this.zs.data[i]);
    let list = this.cells.get(key);
    if (!list) this.cells.set(key, (list = []));
    list.push(i);
  }

  /** The road at arc length s (laid out first if need be), interpolated between samples. */
  at(s: number, out: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, grade: 0 }): RoadPoint {
    if (s < 0) s = 0;
    this.ensure(s + LEAD);
    const f = s / STEP;
    const i = Math.min(Math.floor(f), this.ys.length - 2);
    const t = f - i;
    const L = (a: Float64Array) => a[i] + (a[i + 1] - a[i]) * t;
    out.x = L(this.xs.data);
    out.z = L(this.zs.data);
    out.y = L(this.ys.data);
    out.heading = L(this.hs.data);
    out.curvature = this.curvatureAt(s);
    out.grade = (this.ys.data[i + 1] - this.ys.data[i]) / STEP;
    return out;
  }

  /** Raw sample i: position and height (assumes it has been laid). */
  sample(i: number): [number, number, number] {
    return [this.xs.data[i], this.ys.data[i], this.zs.data[i]];
  }

  get samples(): number {
    return this.ys.length;
  }

  /**
   * Sample indices (with heights) whose points lie within the box, every `every`-th one.
   * For working out distances to the road over a patch of ground.
   */
  samplesNear(x0: number, z0: number, x1: number, z1: number, every = 1): number[] {
    const out: number[] = [];
    const limit = this.ys.length;
    for (let cx = Math.floor(x0 / 32); cx <= Math.floor(x1 / 32); cx++) {
      for (let cz = Math.floor(z0 / 32); cz <= Math.floor(z1 / 32); cz++) {
        const list = this.cells.get((cx + 32768) * 65536 + (cz + 32768));
        if (!list) continue;
        for (const i of list) if (i < limit && i % every === 0) out.push(i);
      }
    }
    return out.sort((a, b) => a - b);
  }
}
