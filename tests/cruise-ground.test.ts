import { describe, expect, it } from "vitest";
import { GRID_M, GroundProbe } from "../lib/cruise/ground";
import { LANE_OFFSET, ROAD_HALF, rightOf, surfaceY } from "../lib/cruise/road";
import { Landscape, RoadDistance, WILD_M } from "../lib/cruise/terrain";

describe("cruise ground probe", () => {
  const land = new Landscape(21);
  const probe = new GroundProbe(land);

  it("stands on the road's banked surface on the road, and knows where along it it is", () => {
    for (const s of [1500, 2400, 3333]) {
      const p = land.road.at(s);
      const [rx, rz] = rightOf(p.heading);
      const f = probe.at(p.x + rx * LANE_OFFSET, p.z + rz * LANE_OFFSET);
      expect(f.road).toBe(true);
      expect(f.s).toBeCloseTo(s, 0);
      expect(f.d).toBeCloseTo(LANE_OFFSET, 1);
      expect(f.y).toBeCloseTo(surfaceY(p, LANE_OFFSET), 2);
    }
  });

  it("matches the ground mesh at its lattice points, and is off the road away from it", () => {
    const p = land.road.at(2000);
    const [rx, rz] = rightOf(p.heading);
    const x = Math.round((p.x + rx * 80) / GRID_M) * GRID_M;
    const z = Math.round((p.z + rz * 80) / GRID_M) * GRID_M;
    const dist = new RoadDistance(land.road);
    dist.prepare(x - 10, z - 10, x + 10, z + 10, WILD_M);
    const [d, ry] = dist.query(x, z);
    const f = probe.at(x, z);
    expect(f.road).toBe(false);
    expect(Math.abs(f.d)).toBeGreaterThan(ROAD_HALF + 20);
    expect(f.y).toBeCloseTo(land.ground(x, z, d, ry).y, 4);
  });

  it("is continuous: no steps between neighbouring points", () => {
    const p = land.road.at(2600);
    let prev = probe.at(p.x + 30, p.z + 30).y;
    for (let k = 1; k < 400; k++) {
      const y = probe.at(p.x + 30 + k * 0.25, p.z + 30 + k * 0.1).y;
      expect(Math.abs(y - prev)).toBeLessThan(0.5);
      prev = y;
    }
  });
});
