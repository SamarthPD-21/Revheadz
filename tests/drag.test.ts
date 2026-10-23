import { describe, expect, it } from "vitest";
import { driveWithCpu, CPU_LEVELS } from "../lib/drag/cpu";
import { CLASSES } from "../lib/drag/classes";
import { AUTO_SHIFT_MS, bracketOffsets, decide, dialIn, DragRun, replay, TREE_MS, type DriveLog } from "../lib/drag/race";
import { loadConfig } from "./helpers";

/** A driver who launches `rt` ms after green and shifts `shiftRt` ms after every cue. */
function drive(id: string, rt: number, shiftRt: number, treeMs = TREE_MS) {
  const run = new DragRun(loadConfig(id), treeMs);
  const log: DriveLog = { assist: true, events: [[rt, "launch"]] };
  run.input(rt, "launch");
  run.on((e) => {
    if (e.type === "cue") {
      const at = run.t + shiftRt;
      log.events.push([at, "up"]);
      run.input(at, "up");
    }
  });
  run.advanceTo(60000);
  return { result: run.result!, log };
}

describe("drag racing", () => {
  it("replaying a drive log reproduces the live run exactly", () => {
    for (const id of ["supra_mk4", "hellcat", "panigale_v4"]) {
      const live = drive(id, 183.4, 141.7);
      const again = replay(loadConfig(id), live.log);
      expect(again.elapsedMs).toBe(live.result.elapsedMs);
      expect(again.shiftReactionsMs).toEqual(live.result.shiftReactionsMs);
    }
  });

  it("the dial-in is the perfect run, and reactions only ever add time", () => {
    const cfg = loadConfig("ferrari_f40");
    const dial = dialIn(cfg);
    const perfect = drive("ferrari_f40", 0, 0).result.elapsedMs;
    expect(Math.abs(perfect - dial)).toBeLessThan(2);
    const slowLaunch = drive("ferrari_f40", 250, 0).result.elapsedMs;
    const slowShifts = drive("ferrari_f40", 0, 250).result.elapsedMs;
    expect(slowLaunch).toBeGreaterThan(perfect + 200);
    expect(slowShifts).toBeGreaterThan(perfect + 50);
  });

  it("a millisecond of reaction is a millisecond on the clock off the line", () => {
    const a = drive("mustang_gt", 150, 120).result.elapsedMs;
    const b = drive("mustang_gt", 151, 120).result.elapsedMs;
    expect(b - a).toBeGreaterThan(0.5);
    expect(b - a).toBeLessThan(1.5);
  });

  it("reaction, shift reactions and ET are reported", () => {
    const { result } = drive("supra_mk4", 212, 160);
    expect(result.reactionMs).toBe(212);
    expect(result.redLight).toBe(false);
    expect(result.shiftReactionsMs.length).toBeGreaterThanOrEqual(3);
    for (const r of result.shiftReactionsMs) expect(r).toBeCloseTo(160, 0);
    expect(result.etMs).toBeCloseTo(result.elapsedMs - 212, 3);
    expect(result.sixtyFtMs).toBeGreaterThan(1000);
    expect(result.trapKmh).toBeGreaterThan(120);
  });

  it("jumping the green is a red light, and a red light loses", () => {
    const red = drive("bugatti_chiron", -15, 100).result;
    const slow = drive("honda_s2000", 400, 300).result;
    expect(red.redLight).toBe(true);
    const offsets = bracketOffsets(dialIn(loadConfig("bugatti_chiron")), dialIn(loadConfig("honda_s2000")));
    expect(decide(red, slow, offsets)).toBe("b");
    expect(decide(slow, red, [offsets[1], offsets[0]])).toBe("a");
  });

  it("not shifting costs time: the gearbox shifts for you after the time-out", () => {
    const run = new DragRun(loadConfig("muscle_v8"), TREE_MS);
    run.press(0);
    run.advanceTo(60000);
    const r = run.result!;
    expect(r.autoShifts).toBeGreaterThan(0);
    expect(r.shiftReactionsMs.every((ms) => ms === AUTO_SHIFT_MS)).toBe(true);
    expect(r.elapsedMs).toBeGreaterThan(dialIn(loadConfig("muscle_v8")) + 500);
  });

  it("heads-up in a class: two perfect drivers tie whatever they drive", () => {
    for (const c of CLASSES) {
      const times = c.cars.map((id) => drive(id, 0, 0).result.elapsedMs);
      expect(Math.max(...times) - Math.min(...times), c.id).toBeLessThan(8);
    }
  });

  it("heads-up in a class: the quicker reactions win, whichever car", () => {
    const chiron = drive("bugatti_chiron", 220, 180).result;
    const h2 = drive("ninja_h2", 160, 140).result;
    expect(decide(chiron, h2, [0, 0])).toBe("b");
    const s2000 = drive("honda_s2000", 150, 120).result;
    const supra = drive("supra_mk4", 190, 160).result;
    expect(decide(s2000, supra, [0, 0])).toBe("a");
  });

  it("the CPU drives a full run with human reaction times", () => {
    const run = new DragRun(loadConfig("lexus_lfa"), TREE_MS);
    driveWithCpu(run, { ...CPU_LEVELS.club, redLightChance: 0 });
    run.advanceTo(60000);
    const r = run.result!;
    expect(r.dnf).toBe(false);
    expect(r.reactionMs!).toBeGreaterThanOrEqual(95);
    expect(r.shiftReactionsMs.length).toBeGreaterThan(2);
  });

  it("not launching is a DNF", () => {
    const r = replay(loadConfig("supra_mk4"), { assist: true, events: [] });
    expect(r.dnf).toBe(true);
  });

  /** Pro controls: the driver works the gas themselves. */
  function pro(id: string, events: [number, "gas+" | "gas-" | "launch" | "up" | "brake+" | "brake-"][], shiftRt = 100) {
    const run = new DragRun(loadConfig(id), TREE_MS, { assist: false });
    for (const [ms, k] of events) run.input(ms, k);
    run.on((e) => {
      if (e.type === "cue") run.input(run.t + shiftRt, "up");
    });
    run.advanceTo(60000);
    return run.result!;
  }

  it("pro controls: flat on the gas matches the assisted run", () => {
    const assisted = drive("corvette_z06", 150, 100).result.elapsedMs;
    const manual = pro("corvette_z06", [[-1400, "gas+"], [150, "launch"]]).elapsedMs;
    expect(Math.abs(manual - assisted)).toBeLessThan(5);
  });

  it("pro controls: lifting off the gas mid-run costs time, and is reported", () => {
    const flat = pro("corvette_z06", [[-1400, "gas+"], [150, "launch"]]);
    const lift = pro("corvette_z06", [[-1400, "gas+"], [150, "launch"], [3000, "gas-"], [3300, "gas+"]]);
    expect(lift.elapsedMs).toBeGreaterThan(flat.elapsedMs + 150);
    expect(lift.offGasMs).toBeCloseTo(300, -1);
    expect(flat.offGasMs).toBe(0);
  });

  it("pro controls: launching without revs bogs the car down", () => {
    const revved = pro("hellcat", [[-1400, "gas+"], [150, "launch"]]).elapsedMs;
    const cold = pro("hellcat", [[150, "launch"], [150, "gas+"]]).elapsedMs;
    expect(cold).toBeGreaterThan(revved);
  });

  it("pro controls: the brake slows you down after launch", () => {
    const clean = pro("mustang_gt", [[-1400, "gas+"], [150, "launch"]]).elapsedMs;
    const dragged = pro("mustang_gt", [[-1400, "gas+"], [150, "launch"], [2000, "brake+"], [2300, "brake-"]]).elapsedMs;
    expect(dragged).toBeGreaterThan(clean + 100);
  });

  it("after the line the car lifts, brakes and works down the gears to a stop", () => {
    const run = new DragRun(loadConfig("supra_mk4"), TREE_MS);
    run.press(0);
    run.on((e) => {
      if (e.type === "cue") run.press(run.t);
    });
    run.advanceTo(60000);
    const finishGear = run.sim.state.gear;
    let downshifts = 0;
    run.sim.subscribe((e) => {
      if (e.type === "shift" && e.direction === "down") downshifts++;
    });
    const end = run.result!.elapsedMs;
    const speeds: number[] = [];
    for (let t = 0; t <= 14000; t += 500) {
      run.coastTo(end + t);
      speeds.push(run.sim.state.speedKmh);
    }
    expect(downshifts).toBeGreaterThanOrEqual(finishGear - 1);
    expect(run.sim.state.speedKmh).toBeLessThan(5);
    expect(run.sim.state.gear).toBeLessThanOrEqual(1);
    expect(run.distM).toBeGreaterThan(402.336);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1] + 0.01); // never speeds up
    expect(run.result!.elapsedMs).toBe(end); // the cool-down doesn't touch the result
  });
});
