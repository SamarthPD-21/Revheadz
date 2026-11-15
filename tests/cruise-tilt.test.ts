import { describe, expect, it } from "vitest";
import { tiltToSteer } from "../components/cruise/tiltSteer";

const g = (deg: number) => 9.81 * Math.sin((deg * Math.PI) / 180);

describe("cruise: tilt steering on a landscape phone", () => {
  it("held level, the car goes straight, and a slight crooked hold is ignored", () => {
    expect(tiltToSteer(0, 90)).toBe(0);
    expect(tiltToSteer(g(2), 90)).toBe(0);
  });

  it("turning the phone right like a wheel steers right, whichever way round it is held", () => {
    expect(tiltToSteer(g(12), 90)).toBeGreaterThan(0.3);
    expect(tiltToSteer(g(-12), 270)).toBeGreaterThan(0.3);
    expect(tiltToSteer(g(-12), 90)).toBeLessThan(-0.3);
  });

  it("reaches full lock and goes no further", () => {
    expect(tiltToSteer(g(25), 90)).toBeCloseTo(1, 5);
    expect(tiltToSteer(g(60), 90)).toBe(1);
    expect(tiltToSteer(-9.81 * 2, 90)).toBe(-1);
  });

  it("does nothing with the phone upright", () => {
    expect(tiltToSteer(g(20), 0)).toBe(0);
    expect(tiltToSteer(g(20), 180)).toBe(0);
  });

  it("takes -90 (older iOS) as 270", () => {
    expect(tiltToSteer(g(-12), -90)).toBe(tiltToSteer(g(-12), 270));
  });
});
