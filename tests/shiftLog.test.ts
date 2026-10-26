import { describe, expect, it } from "vitest";
import { ShiftLog } from "../lib/track/shiftLog";

/** Revs climbing from `from` at `perS` rpm/s, sampled at 60 fps from `t0` for `s` seconds. */
function rev(log: ShiftLog, t0: number, s: number, from: number, perS: number, gear: number) {
  for (let i = 0; i <= Math.round(s * 60); i++) log.sample(t0 + i / 60, from + perS * (i / 60), gear);
  return t0 + s;
}

describe("ShiftLog", () => {
  it("rates an upshift by how long after the shift light it came, to the millisecond", () => {
    const log = new ShiftLog(7000);
    log.start(10, 1);
    // 5000 rpm climbing 2000 rpm/s reaches 7000 at exactly 11.0 s
    rev(log, 10, 1.05, 5000, 2000, 1);
    const e = log.shift(11.05, 2);
    expect(e.what).toBe("1→2");
    expect(e.ms).toBeCloseTo(1050, 6);
    expect([e.rating, e.note]).toEqual(["Perfect", "+50 ms"]);
    expect(e.tone).toBe("great");
  });

  it("calls a shift before the light early, by how far short the revs were", () => {
    const log = new ShiftLog(7000);
    log.start(0, 1);
    rev(log, 0, 0.5, 5000, 2000, 1); // tops out at 6000
    const e = log.shift(0.5, 2);
    expect(e.tone).toBe("bad");
    expect([e.rating, e.note]).toEqual(["Early", "1000 rpm short"]);
  });

  it("calls a long wait on the limiter late, and starts each gear afresh", () => {
    const log = new ShiftLog(7000);
    log.start(0, 1);
    rev(log, 0, 1, 6000, 2000, 1); // light at 0.5 s
    expect(log.shift(1.5, 2)).toMatchObject({ rating: "Late", note: "on the limiter" });
    // second gear: the light comes again at 7000, not straight away
    rev(log, 1.5, 0.2, 5200, 2000, 2);
    expect(log.shift(1.7, 3).rating).toBe("Early");
  });

  it("logs downshifts, neutral and splits in time order, without rating them", () => {
    const log = new ShiftLog(7000);
    log.start(0, 3);
    log.sample(0.1, 4000, 3);
    expect(log.shift(2, 2)).toEqual({ ms: 2000, what: "3→2" });
    log.split(1500, "60 ft");
    expect(log.shift(2.5, 0).what).toBe("2→N");
    expect(log.entries.map((e) => e.what)).toEqual(["Launch", "60 ft", "3→2", "2→N"]);
  });
});
