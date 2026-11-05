import { describe, expect, it } from "vitest";
import { KEEP_BEHIND, Progress, WrongWay } from "../lib/cruise/progress";
import { Landscape } from "../lib/cruise/terrain";

describe("cruise: the road only goes forward", () => {
  const land = new Landscape(4242);
  const road = land.road;

  it("closes the world a fixed way behind the furthest point reached, and only ever moves it forward", () => {
    const p = new Progress(road, 1500);
    expect(p.boundary).toBe(1500 - KEEP_BEHIND);
    expect(p.advance(1800)).toBe(true);
    expect(p.boundary).toBe(1800 - KEEP_BEHIND);
    // going back doesn't reopen anything
    expect(p.advance(1700)).toBe(false);
    expect(p.boundary).toBe(1800 - KEEP_BEHIND);
  });

  it("counts road behind the line as closed and road ahead as open", () => {
    const p = new Progress(road, 3000);
    const behind = road.at(p.boundary - 200);
    const ahead = road.at(p.boundary + 200);
    expect(p.isBehind(behind.x, behind.z, p.boundary - 200)).toBe(true);
    expect(p.isBehind(ahead.x, ahead.z, p.boundary + 200)).toBe(false);
  });

  it("never closes ground by road that's still ahead, even if the road has curled back past the line", () => {
    const p = new Progress(road, 3000);
    const behind = road.at(p.boundary - 300);
    // pretend that spot's nearest road is still ahead of the boundary (a road looping back)
    expect(p.isBehind(behind.x, behind.z, p.boundary + 50)).toBe(false);
  });

  it("off the road, far out to the side, the line itself decides", () => {
    const p = new Progress(road, 3000);
    const b = road.at(p.boundary);
    const [ax, az] = [Math.cos(b.heading), Math.sin(b.heading)];
    const [rx, rz] = p.across;
    // 2 km out to the side, 100 m back from the line / ahead of it
    expect(p.isBehind(b.x + rx * 2000 - ax * 100, b.z + rz * 2000 - az * 100)).toBe(true);
    expect(p.isBehind(b.x + rx * 2000 + ax * 100, b.z + rz * 2000 + az * 100)).toBe(false);
  });
});

describe("cruise: wrong way", () => {
  it("says so after about a second of driving back down the road, not for a moment's reverse", () => {
    const w = new WrongWay();
    // backing up slowly
    for (let t = 0; t < 2; t += 0.1) w.update(0.1, -1, 0, 1.5, 1, 0);
    expect(w.active).toBe(false);
    // driving against the road at speed: a brief moment isn't enough
    for (let t = 0; t < 0.5; t += 0.1) w.update(0.1, -1, 0, 15, 1, 0);
    expect(w.active).toBe(false);
    for (let t = 0; t < 1; t += 0.1) w.update(0.1, -1, 0, 15, 1, 0);
    expect(w.active).toBe(true);
    // turned round: it clears
    for (let t = 0; t < 1; t += 0.1) w.update(0.1, 1, 0, 15, 1, 0);
    expect(w.active).toBe(false);
  });

  it("crossing the road (side on) isn't the wrong way", () => {
    const w = new WrongWay();
    for (let t = 0; t < 3; t += 0.1) w.update(0.1, 0, 1, 15, 1, 0);
    expect(w.active).toBe(false);
  });
});
