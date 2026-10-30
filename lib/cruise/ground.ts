import { ROAD_HALF, STEP, WATER_Y, rightOf, sectionDrop, surfaceY, type RoadPoint } from "./road";
import { Landscape, RoadDistance, WILD_M } from "./terrain";

/** The near ground's mesh is a lattice this many metres apart (the world's tiles are built on it). */
export const GRID_M = 4;
/** Lattice points the probe keeps; past that it starts again. */
const LATTICE_SLOTS = 20000;

export interface Footing {
  /** Height of whatever is underfoot: road surface or ground. */
  y: number;
  /** On the tarmac (lanes and a little of the shoulder). */
  road: boolean;
  /** Arc length of the nearest road point, and the signed distance across from it (+ right); NaN if no road is near. */
  s: number;
  d: number;
  /** 0 lush .. 1 desert: what the wheels throw up off-road. */
  dry: number;
  /** How deep under water the ground is here (0 when dry). */
  depth: number;
}

/**
 * Height of the world under any point, exactly as it is drawn: the ground mesh's own
 * triangles between lattice points, or the road's banked surface and shoulders where the
 * road is. For a car driving freely over the map.
 */
export class GroundProbe {
  private readonly dist: RoadDistance;
  /** Lattice points worked out so far: a slot each in one flat array (height, dryness). */
  private readonly lattice = new Map<number, number>();
  private readonly data = new Float32Array(LATTICE_SLOTS * 2);
  private next = 0;
  private centre = { x: Infinity, z: Infinity };
  private readonly q: [number, number] = [0, 0];
  private readonly pt: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, grade: 0 };

  constructor(private readonly land: Landscape) {
    this.dist = new RoadDistance(land.road);
  }

  /** Re-gathers the road around a point when the probe has wandered away from the last one. */
  private around(x: number, z: number) {
    if (Math.hypot(x - this.centre.x, z - this.centre.z) < 60) return;
    this.centre = { x, z };
    this.dist.prepare(x - 120, z - 120, x + 120, z + 120, WILD_M);
  }

  /** Forgets cached ground (call when the road has been laid somewhere new). */
  reset(): void {
    this.lattice.clear();
    this.next = 0;
    this.centre = { x: Infinity, z: Infinity };
  }

  private node(i: number, j: number) {
    const key = (i + 1_000_000) * 2_000_003 + (j + 1_000_000);
    let slot = this.lattice.get(key);
    if (slot === undefined) {
      const x = i * GRID_M;
      const z = j * GRID_M;
      this.dist.query(x, z, this.q);
      const g = this.land.ground(x, z, this.q[0], this.q[1]);
      if (this.next === LATTICE_SLOTS) {
        this.lattice.clear();
        this.next = 0;
      }
      slot = this.next++;
      this.data[slot * 2] = g.y;
      this.data[slot * 2 + 1] = g.dry;
      this.lattice.set(key, slot);
    }
    return slot;
  }

  /** The ground mesh's height at a point (its two triangles per cell, split the same way). */
  groundY(x: number, z: number): { y: number; dry: number } {
    this.around(x, z);
    const fx = x / GRID_M;
    const fz = z / GRID_M;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const d = this.data;
    const h00 = d[this.node(i, j) * 2];
    const h10 = d[this.node(i + 1, j) * 2];
    const h01 = d[this.node(i, j + 1) * 2];
    const h11 = d[this.node(i + 1, j + 1) * 2];
    const y = u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    return { y, dry: d[this.node(i, j) * 2 + 1] };
  }

  at(x: number, z: number): Footing {
    const g = this.groundY(x, z);
    let y = g.y;
    let road = false;
    let s = NaN;
    let d = NaN;
    this.dist.query(x, z, this.q);
    const i = this.dist.lastIndex;
    if (i >= 0 && this.q[0] < 600) {
      // project onto the road near the nearest sample for the exact place along and across it
      const road0 = this.land.road.at(i * STEP, this.pt);
      const dx = x - road0.x;
      const dz = z - road0.z;
      s = Math.max(0, i * STEP + dx * Math.cos(road0.heading) + dz * Math.sin(road0.heading));
      const p = this.land.road.at(s, this.pt);
      const [rx, rz] = rightOf(p.heading);
      d = (x - p.x) * rx + (z - p.z) * rz;
      if (Math.abs(d) < ROAD_HALF + 1.8) {
        y = Math.max(y, surfaceY(p, d) + sectionDrop(d));
        road = Math.abs(d) < ROAD_HALF + 0.3;
      }
    }
    return { y, road, s, d, dry: g.dry, depth: Math.max(0, WATER_Y - y) };
  }
}
