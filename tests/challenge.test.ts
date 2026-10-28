import { describe, expect, it } from "vitest";
import { decodeChallenge, encodeChallenge, quantise, REPLAY_VERSION, shareRun, verifyChallenge, type Challenge } from "../lib/drag/challenge";
import { DragRun, replay, TREE_MS, type DriveLog } from "../lib/drag/race";
import { loadConfig } from "./helpers";

/** A real pro-controls drive: staging on the gas before green, a launch, shifts a bit after each cue. */
function drive(id: string): DriveLog {
  const log: DriveLog = { assist: false, events: [[-812.123456, "gas+"], [171.98765, "launch"]] };
  const run = new DragRun(loadConfig(id), TREE_MS, { assist: false });
  for (const [ms, k] of log.events) run.input(ms, k);
  run.on((e) => {
    if (e.type === "cue") {
      const at = run.t + 120.3333;
      log.events.push([at, "up"]);
      run.input(at, "up");
    }
  });
  run.advanceTo(60000);
  return log;
}

describe("challenge links", () => {
  it("round-trip a run exactly (on the 0.1 ms grid) and replay to the same time", () => {
    const log = drive("supra_mk4");
    const c: Challenge = { name: "Sam ✨", carId: "supra_mk4", log };
    const code = encodeChallenge(c);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe as is
    expect(code.length).toBeLessThan(400);
    const back = decodeChallenge(code);
    if (typeof back === "string") throw new Error(back);
    expect(back.name).toBe("Sam ✨");
    expect(back.log).toEqual(quantise(log));
    expect(verifyChallenge(back).result.elapsedMs).toBe(replay(loadConfig("supra_mk4"), quantise(log)).elapsedMs);
  });

  it("quotes the same time in the share message that the receiver will see", () => {
    const log = drive("hellcat");
    const { url, text, result } = shareRun("https://example.com", "Sam", "hellcat", log);
    const back = decodeChallenge(url.split("#c=")[1]);
    if (typeof back === "string") throw new Error(back);
    expect(verifyChallenge(back).result.elapsedMs).toBe(result.elapsedMs);
    expect(text).toContain((result.elapsedMs / 1000).toFixed(3));
  });

  it("rejects junk, unknown cars, events that go back in time, and other versions", () => {
    const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeChallenge("not base64 at all!")).toBe("invalid");
    expect(decodeChallenge(enc({ v: REPLAY_VERSION, n: "x", c: "no_such_car", a: 0, e: [] }))).toBe("car");
    expect(decodeChallenge(enc({ v: REPLAY_VERSION, n: "x", c: "supra_mk4", a: 0, e: [1000, 0, -5, 1] }))).toBe("invalid");
    expect(decodeChallenge(enc({ v: REPLAY_VERSION, n: "x", c: "supra_mk4", a: 0, e: [1000, 99] }))).toBe("invalid");
    expect(decodeChallenge(enc({ v: 999, n: "x", c: "supra_mk4", a: 0, e: [] }))).toBe("version");
    // a link from before the physics last changed can't replay exactly, so it says so
    expect(decodeChallenge(enc({ v: REPLAY_VERSION - 1, n: "x", c: "supra_mk4", a: 0, e: [] }))).toBe("version");
  });
});
