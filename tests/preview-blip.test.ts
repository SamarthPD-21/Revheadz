import { describe, expect, it } from "vitest";
import { BLIP, blipRpm } from "../lib/audio/preview";

const s = { idleRpm: 900, revRpm: 6000 };

describe("the garage's quick rev: where the needle is", () => {
  it("sits at idle before the blip and after it has settled", () => {
    expect(blipRpm(0, s)).toBe(900);
    expect(blipRpm(BLIP.end + 1, s)).toBe(900);
  });

  it("reaches the rev loop's rpm at the top and holds it", () => {
    expect(blipRpm(BLIP.top, s)).toBeCloseTo(6000);
    expect(blipRpm((BLIP.top + BLIP.fall) / 2, s)).toBeCloseTo(6000);
  });

  it("climbs on the way up and drops on the way down", () => {
    const up = [0.25, 0.5, 0.75].map((f) => blipRpm(BLIP.rise + f * (BLIP.top - BLIP.rise), s));
    expect(up[0]).toBeLessThan(up[1]);
    expect(up[1]).toBeLessThan(up[2]);
    const down = [0.25, 0.5, 0.75].map((f) => blipRpm(BLIP.fall + f * (BLIP.end - BLIP.fall), s));
    expect(down[0]).toBeGreaterThan(down[1]);
    expect(down[1]).toBeGreaterThan(down[2]);
  });
});
