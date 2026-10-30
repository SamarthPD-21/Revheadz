import { describe, expect, it } from "vitest";
import { Barriers, CELL } from "../lib/cruise/barriers";
import { Landscape } from "../lib/cruise/terrain";

describe("guardrails", () => {
  const land = new Landscape(4242);
  const rails = new Barriers(land);
  const cells = 1500; // 15 km
  let bends = 0, bendsRailed = 0, straights = 0, straightsRailed = 0, gaps = 0;
  let prev = 0;
  for (let c = 0; c < cells; c++) {
    const v = rails.cell(c);
    const k = Math.abs(land.road.curvatureAt(c * CELL + CELL / 2));
    const outside = land.road.curvatureAt(c * CELL + CELL / 2) > 0 ? 1 : 2;
    if (k > 1 / 300) {
      bends++;
      if (v & outside) bendsRailed++;
    } else if (k < 1 / 1500) {
      straights++;
      if (v) straightsRailed++;
    }
    if ((prev & 1) && !(v & 1)) gaps++;
    prev = v;
  }

  it("rails the outside of most bends", () => {
    expect(bends).toBeGreaterThan(20);
    expect(bendsRailed / bends).toBeGreaterThan(0.85);
  });

  it("leaves most straights open, with plenty of places to leave the road", () => {
    expect(straights).toBeGreaterThan(20);
    expect(straightsRailed / straights).toBeLessThan(0.5);
    expect(gaps).toBeGreaterThan(15);
  });

  it("is the same rail every time for the same road", () => {
    const again = new Barriers(new Landscape(4242));
    for (let c = 0; c < 300; c++) expect(again.cell(c)).toBe(rails.cell(c));
  });

  it("never leaves a stub: every run is at least 40 m", () => {
    for (const bit of [1, 2]) {
      let run = 0;
      for (let c = 0; c < cells; c++) {
        if (rails.cell(c) & bit) run++;
        else {
          if (run && c - run > 5) expect(run).toBeGreaterThanOrEqual(4);
          run = 0;
        }
      }
    }
  });
});
