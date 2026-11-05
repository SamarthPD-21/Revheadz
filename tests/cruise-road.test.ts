import { describe, expect, it } from "vitest";
import { MIN_RADIUS, ROAD_HALF, STEP, WATER_Y } from "../lib/cruise/road";
import { Landscape, RoadDistance } from "../lib/cruise/terrain";

describe("cruise road", () => {
  it("is the same road for the same seed, however it is laid out", () => {
    const a = new Landscape(7).road;
    const b = new Landscape(7).road;
    b.ensure(9000); // laid out in one go vs piece by piece
    for (let s = 0; s < 9000; s += 377) expect(a.at(s)).toEqual(b.at(s));
    expect(new Landscape(8).road.at(4000).x).not.toBeCloseTo(a.at(4000).x, 0);
  });

  it("is smooth: no jumps, bends no tighter than 70 m, grades within 8%, always above water", () => {
    const road = new Landscape(3).road;
    let prev = road.at(0);
    let straights = 0;
    let run = 0;
    let longest = 0;
    let prevK = road.curvatureAt(0);
    for (let s = STEP; s < 30000; s += STEP) {
      const p = road.at(s);
      expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeCloseTo(STEP, 1);
      expect(Math.abs(p.y - prev.y)).toBeLessThanOrEqual(0.08 * STEP + 1e-9);
      expect(Math.abs(p.curvature)).toBeLessThanOrEqual(1 / MIN_RADIUS + 1e-12);
      expect(p.y).toBeGreaterThan(WATER_Y + 1.5);
      // curvature eases in and out of every bend, never steps
      expect(Math.abs(p.curvature - prevK)).toBeLessThan(0.002);
      if (Math.abs(p.curvature) < 1 / 2000) {
        straights++;
        longest = Math.max(longest, ++run);
      } else run = 0;
      prevK = p.curvature;
      prev = p;
    }
    // mostly bends: a straight here and there, but never long enough to stay flat out for long
    expect(straights * STEP).toBeGreaterThan(1500);
    expect(straights * STEP).toBeLessThan(30000 * 0.3);
    expect(longest * STEP).toBeLessThan(600);
  });

  it("never doubles back over itself", () => {
    const road = new Landscape(21).road;
    road.ensure(40000);
    for (let i = 0; i < road.samples; i += 10) {
      const [x, , z] = road.sample(i);
      for (const j of road.samplesNear(x - 40, z - 40, x + 40, z + 40, 5)) {
        if (Math.abs(j - i) * STEP < 600) continue;
        const [x2, , z2] = road.sample(j);
        expect(Math.hypot(x2 - x, z2 - z)).toBeGreaterThan(40);
      }
    }
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
    // one 160 m tile at 4 m spacing: a few ms normally; the bound only catches something
    // pathologically slow (it runs alongside the whole suite, on a busy machine at times)
    expect(ms).toBeLessThan(150);
    console.log(`tile: ${ms.toFixed(1)} ms`);
  });
});
