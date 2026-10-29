import { ROAD_HALF, STEP, WATER_Y, rightOf, sectionDrop, surfaceY, type RoadPoint } from "./road";
import { Landscape, RoadDistance, WILD_M } from "./terrain";

/** The near ground's mesh is a lattice this many metres apart (the world's tiles are built on it). */
export const GRID_M = 4;

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
  private readonly lattice = new Map<number, { y: number; dry: number }>();
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
    if (this.lattice.size > 20000) this.lattice.clear();
  }

  /** Forgets cached ground (call when the road has been laid somewhere new). */
  reset(): void {
    this.lattice.clear();
    this.centre = { x: Infinity, z: Infinity };
  }

  private node(i: number, j: number) {
    const key = (i + 1_000_000) * 2_000_003 + (j + 1_000_000);
    let n = this.lattice.get(key);
    if (!n) {
      const x = i * GRID_M;
      const z = j * GRID_M;
      this.dist.query(x, z, this.q);
      const g = this.land.ground(x, z, this.q[0], this.q[1]);
      n = { y: g.y, dry: g.dry };
      this.lattice.set(key, n);
    }
    return n;
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
    const h00 = this.node(i, j);
    const h10 = this.node(i + 1, j);
    const h01 = this.node(i, j + 1);
    const h11 = this.node(i + 1, j + 1);
    const y = u + v <= 1 ? h00.y + u * (h10.y - h00.y) + v * (h01.y - h00.y) : h11.y + (1 - u) * (h01.y - h11.y) + (1 - v) * (h10.y - h11.y);
    return { y, dry: h00.dry };
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
