import { describe, expect, it } from "vitest";
import { ROAD_HALF, STEP, WATER_Y } from "../lib/cruise/road";
import { Landscape, RoadDistance } from "../lib/cruise/terrain";

describe("cruise road", () => {
  it("is the same road for the same seed, however it is laid out", () => {
    const a = new Landscape(7).road;
    const b = new Landscape(7).road;
    b.ensure(9000); // laid out in one go vs piece by piece
    for (let s = 0; s < 9000; s += 377) expect(a.at(s)).toEqual(b.at(s));
    expect(new Landscape(8).road.at(4000).x).not.toBeCloseTo(a.at(4000).x, 0);
  });

  it("is smooth: no jumps, bends no tighter than 110 m, grades within 8%, always above water", () => {
    const road = new Landscape(3).road;
    let prev = road.at(0);
    let straights = 0;
    for (let s = STEP; s < 30000; s += STEP) {
      const p = road.at(s);
      expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeCloseTo(STEP, 1);
      expect(Math.abs(p.y - prev.y)).toBeLessThanOrEqual(0.08 * STEP + 1e-9);
      expect(Math.abs(p.curvature)).toBeLessThanOrEqual(1 / 110 + 1e-12);
      expect(p.y).toBeGreaterThan(WATER_Y + 1.5);
      if (Math.abs(p.curvature) < 1 / 3000) straights++;
      prev = p;
    }
    // there are proper straights along the way, not just endless bends
    expect(straights * STEP).toBeGreaterThan(2500);
  });

  it("lays the ground flat under the road and lets it rise away from it", () => {
    const land = new Landscape(5);
    const road = land.road;
    const dist = new RoadDistance(road);
    const p = road.at(3000);
    dist.prepare(p.x - 50, p.z - 50, p.x + 50, p.z + 50, 450);
    const [d, y] = dist.query(p.x, p.z);
    expect(d).toBeLessThan(1);
    expect(land.ground(p.x, p.z, d, y).y).toBeCloseTo(p.y - 0.5, 1);
    // on the verge, still just below the road
    const r: [number, number] = [-Math.sin(p.heading), Math.cos(p.heading)];
    const vx = p.x + r[0] * (ROAD_HALF + 0.5);
    const vz = p.z + r[1] * (ROAD_HALF + 0.5);
    const [dv, yv] = dist.query(vx, vz);
    expect(dv).toBeCloseTo(ROAD_HALF + 0.5, 0);
    expect(land.ground(vx, vz, dv, yv).y).toBeCloseTo(p.y - 0.5, 1);
  });

  it("is quick enough to grow ground as you drive", () => {
    const land = new Landscape(11);
    const dist = new RoadDistance(land.road);
    land.road.ensure(8000);
    const p = land.road.at(4000);
    const t0 = performance.now();
    dist.prepare(p.x - 80, p.z - 80, p.x + 80, p.z + 80, 450);
    const q: [number, number] = [0, 0];
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
      const x = p.x - 80 + i * 4;
      const z = p.z - 80 + j * 4;
      dist.query(x, z, q);
      land.ground(x, z, q[0], q[1]);
    }
    const ms = performance.now() - t0;
    // one 160 m tile at 4 m spacing
    expect(ms).toBeLessThan(60);
    console.log(`tile: ${ms.toFixed(1)} ms`);
  });
});
