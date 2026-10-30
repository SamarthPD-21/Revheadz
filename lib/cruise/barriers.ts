import { hash2 } from "./noise";
import { ROAD_HALF, STEP, rightOf, type RoadPoint } from "./road";
import type { Landscape } from "./terrain";

/** How far out from the centre line the guardrail stands, m (on the edge of the shoulder). */
export const BARRIER_D = ROAD_HALF + 0.55;
/** The road is planned in cells this long, m. */
export const CELL = 10;

/** Bends tighter than this get a rail on their outside; tighter still, on both sides. */
const OUTSIDE_K = 1 / 450;
const BOTH_K = 1 / 220;
/** A drop beside the road this deep (an embankment, a ravine, water) gets a rail too, m. */
const DROP_M = 4;

/**
 * Where the guardrails are, the way a road authority would put them: round the outside of
 * bends (and both sides of the tight ones), along embankments and drops, and not along the open
 * straights, which are left for you to run off into the country. Short gaps in a run are
 * closed up, stubs too short to be worth it are left out, and now and then a field gate breaks
 * a run. Worked out in 10 m cells from the seed alone, so the same road always has the same
 * rails, and the scene and its collisions agree.
 */
export class Barriers {
  private readonly raw = new Map<number, number>();
  private readonly fin = new Map<number, number>();
  private readonly pt: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, grade: 0 };

  constructor(private readonly land: Landscape) {}

  /** Is there a rail at `s` along the road on that side (1 right, -1 left)? */
  has(s: number, side: 1 | -1): boolean {
    if (s < 0) return false;
    return (this.cell(Math.floor(s / CELL)) & (side === 1 ? 2 : 1)) !== 0;
  }

  /** Both sides of a cell: bit 1 left, bit 2 right. */
  cell(c: number): number {
    let v = this.fin.get(c);
    if (v === undefined) {
      v = 0;
      for (const bit of [1, 2]) if (this.open(c, bit) && this.runLength(c, bit) >= 4) v |= bit;
      this.fin.set(c, v);
    }
    return v;
  }

  /** What each cell would want before tidying: the bends and the drops. */
  private want(c: number): number {
    let v = this.raw.get(c);
    if (v !== undefined) return v;
    v = 0;
    const road = this.land.road;
    // the tightest bend from a little before the cell to a little after it
    let k = 0;
    for (let s = c * CELL - 30; s <= c * CELL + 50; s += CELL) if (s >= 0) {
      const ks = road.curvatureAt(s);
      if (Math.abs(ks) > Math.abs(k)) k = ks;
    }
    const outside = k > 0 ? 1 : 2; // a right-hand bend (+) has its outside on the left
    if (Math.abs(k) > OUTSIDE_K) v |= outside;
    if (Math.abs(k) > BOTH_K) v |= 3;
    // a drop off either side
    const p = road.at(c * CELL + CELL / 2, this.pt);
    const [rx, rz] = rightOf(p.heading);
    for (const [side, bit] of [[-1, 1], [1, 2]] as const) {
      const d = side * (ROAD_HALF + 14);
      if (this.land.hills(p.x + rx * d, p.z + rz * d) < p.y - DROP_M) v |= bit;
    }
    this.raw.set(c, v);
    return v;
  }

  /** A rail, with gaps of up to 30 m in a run closed up. */
  private filled(c: number, bit: number): boolean {
    if (this.want(c) & bit) return true;
    let before = false;
    let after = false;
    for (let i = 1; i <= 3; i++) {
      before ||= (this.want(c - i) & bit) !== 0;
      after ||= (this.want(c + i) & bit) !== 0;
    }
    return before && after;
  }

  /** A rail here once the gates are cut in. */
  private open(c: number, bit: number): boolean {
    return this.filled(c, bit) && !this.gate(c, bit);
  }

  /** How long the run of rail through this cell is, in cells (counting up to 4 each way). */
  private runLength(c: number, bit: number): number {
    let n = 1;
    for (let i = 1; i <= 4 && this.open(c - i, bit); i++) n++;
    for (let i = 1; i <= 4 && this.open(c + i, bit); i++) n++;
    return n;
  }

  /** A field gate: a 20 m break, now and then, but never on a tight bend or above a drop. */
  private gate(c: number, bit: number): boolean {
    for (const g of [c, c - 1]) {
      if (hash2(g, bit, this.land.seed) / 4294967296 < 0.035 && Math.abs(this.land.road.curvatureAt(g * CELL)) < BOTH_K) {
        const p = this.land.road.at(g * CELL + CELL / 2, this.pt);
        const [rx, rz] = rightOf(p.heading);
        const d = (bit === 1 ? -1 : 1) * (ROAD_HALF + 14);
        if (this.land.hills(p.x + rx * d, p.z + rz * d) > p.y - DROP_M) return true;
      }
    }
    return false;
  }
}
