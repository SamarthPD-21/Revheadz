import { Simulation } from "../sim/Simulation";
import PARITY from "./parity.json";
import type { VehicleConfig } from "../vehicles/types";

/**
 * Drag racing on top of the regular simulation.
 *
 * A run is the car's physics, stepped in 1 ms steps from a canonical staged state, driven by
 * nothing but the moments the driver launched and shifted. The same inputs always give the
 * same run, so both players' browsers can replay both runs and agree on the result, and the
 * live car on screen is that very run.
 *
 * Bracket racing: each car's dial-in is its own perfect run (0 ms reaction, every shift on
 * the cue). The slower car's tree goes green first, by the difference in dial-ins, so two
 * perfect drivers tie whatever they drive. What decides a race is reaction time: off the
 * line and at every shift.
 */

export const DT = 1 / 1000;
export const QUARTER_MILE_M = 402.336;
export const SIXTY_FT_M = 18.288;
export const EIGHTH_MILE_M = 201.168;

/** Sportsman tree: three ambers 0.5 s apart, green 0.5 s after the last. */
export const AMBER_STEP_MS = 500;
export const TREE_MS = AMBER_STEP_MS * 3;
/** Staged engine settle time before the tree may start (revs climb onto the two-step). */
export const STAGE_MS = 1200;
/** No shift this long after the cue: the gearbox shifts for you (and you've lost the time). */
export const AUTO_SHIFT_MS = 900;
/** Not launched this long after green: did not start. */
export const NO_LAUNCH_MS = 4000;
/** Give up after this long (a stalled or broken run). */
const MAX_RUN_MS = 40000;

/** A driver input. "up" before launch launches (one-button play). */
export type DriveKey = "launch" | "up" | "down" | "gas+" | "gas-" | "brake+" | "brake-";

/** What a driver did, in ms relative to their own green light, in time order. */
export interface DriveLog {
  /** Simple controls: the gas is held flat for you. */
  assist: boolean;
  events: [number, DriveKey][];
}

export interface RunResult {
  /** Reaction time off the line, ms (negative = red light). */
  reactionMs: number | null;
  redLight: boolean;
  dnf: boolean;
  /** Green light to the finish line, ms (includes the reaction). */
  elapsedMs: number;
  /** Launch to the finish line, ms. */
  etMs: number;
  sixtyFtMs: number;
  eighthMs: number;
  trapKmh: number;
  /** For each upshift: press time minus cue time (negative = shifted before the cue). */
  shiftReactionsMs: number[];
  /** Shifts the gearbox made because the driver didn't. */
  autoShifts: number;
  /** Time off the gas between launch and the line, ms (lifting costs time). */
  offGasMs: number;
}

const cueCache = new Map<string, number>();

/**
 * Rpm at which the shift cue lights for this car: its fastest constant shift point, found by
 * running the quarter mile at a range of shift rpms. Like a real shift light, the cue is the
 * optimum, so no shifting strategy beats shifting on it, and every millisecond late costs.
 */
export function cueRpm(cfg: VehicleConfig): number {
  const hit = cueCache.get(cfg.id);
  if (hit !== undefined) return hit;
  const e = cfg.engine;
  let best = e.limiterRpm;
  let bestMs = Infinity;
  const lo = Math.max(e.idleRpm * 2, e.redlineRpm * 0.7);
  for (let i = 0; i <= 16; i++) {
    const rpm = lo + ((e.limiterRpm - 1 - lo) * i) / 16;
    const ms = perfectRun(cfg, rpm);
    if (ms < bestMs - 0.01) {
      bestMs = ms;
      best = rpm;
    }
  }
  cueCache.set(cfg.id, best);
  return best;
}

const parityOf = (cfg: VehicleConfig) => PARITY.cars[cfg.id as keyof typeof PARITY.cars] as { cue: number; trim: number } | undefined;

/** Where this car's shift light comes on in a race (its class-parity cue, else its own optimum). */
export function shiftLightRpm(cfg: VehicleConfig): number {
  return parityOf(cfg)?.cue ?? cueRpm(cfg);
}

/** Green to finish with a 0 ms launch and every shift the instant the revs reach `cue`. */
export function perfectRun(cfg: VehicleConfig, cue: number, torqueScale = 1): number {
  const run = new DragRun(cfg, TREE_MS, { cue, assist: true, torqueScale });
  run.press(0);
  run.on((ev) => {
    if (ev.type === "cue") run.press(run.t);
  });
  run.advanceTo(MAX_RUN_MS + 1);
  return run.result!.elapsedMs;
}

/** Same seed every run: the limiter's random cut lengths must replay identically. */
function seeded(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * A drag run you can step: the canonical staged car, then the driver's inputs. Used for the
 * live car (fed inputs as they happen), for replays, and for the dial-in.
 */
export class DragRun {
  readonly sim: Simulation;
  /** ms since this run's green light (negative while staging on the tree). */
  t: number;
  distM = 0;
  launched = false;
  finished = false;
  result: RunResult | null = null;

  /** Rpm at which this run's shift light comes on (and the drag rev limiter cuts in). */
  readonly cue: number;
  private cueAt: number | null = null;
  private launchAt: number | null = null;
  private launchQueued = false;
  /** Pending inputs, in time order. */
  private readonly queue: [number, DriveKey][] = [];
  private gas = false;
  private brake = false;
  private offGas = 0;
  private readonly assist: boolean;
  private readonly shiftReactions: number[] = [];
  private autoShifts = 0;
  private sixtyFt = 0;
  private eighth = 0;
  private prevDist = 0;
  private prevSpeed = 0;
  private listeners: ((e: { type: "cue" | "launch" | "shift" | "finish" }) => void)[] = [];

  /**
   * @param treeMs how long this lane's tree runs before green (bracket: the faster car's
   *   tree runs longer by the dial-in difference)
   */
  constructor(
    readonly cfg: VehicleConfig,
    readonly treeMs: number,
    opts: { cue?: number; assist?: boolean; torqueScale?: number } = {},
  ) {
    // class parity: each car's shift light and engine trim come from lib/drag/parity.json
    const p = parityOf(cfg);
    this.cue = opts.cue ?? shiftLightRpm(cfg);
    const trim = opts.torqueScale ?? (opts.cue === undefined ? (p?.trim ?? 1) : 1);
    this.assist = opts.assist ?? true;
    // Drag ECU: the rev limiter sits at the shift light, so every millisecond late on a shift is
    // spent bouncing off it. (Without this, cars whose best shift is below the limiter could
    // shift late for free.)
    const limiterRpm = Math.min(cfg.engine.limiterRpm, Math.max(this.cue, cfg.engine.idleRpm * 2));
    this.sim = new Simulation({ ...cfg, engine: { ...cfg.engine, limiterRpm, peakTorqueNm: cfg.engine.peakTorqueNm * trim } }, seeded());
    // canonical start: engine running and settled at idle in neutral (silent; not subscribed yet)
    this.sim.toggleIgnition();
    for (let i = 0; i < 1500; i++) this.sim.step(DT);
    this.sim.input.throttle = this.assist ? 1 : 0; // assisted: revs climb onto the two-step by themselves
    this.t = -(STAGE_MS + treeMs);
  }

  on(fn: (e: { type: "cue" | "launch" | "shift" | "finish" }) => void) {
    this.listeners.push(fn);
  }

  /** A driver input at `ms` since green. Inputs must arrive in time order. */
  input(ms: number, key: DriveKey) {
    if (this.finished) return;
    if (key === "launch" || (key === "up" && !this.launchQueued)) {
      if (this.launchQueued) return;
      this.launchQueued = true;
      key = "launch";
    }
    this.queue.push([Math.max(ms, this.t), key]);
  }

  /** One-button play: the first press launches, the rest shift up. */
  press(ms: number) {
    this.input(ms, this.launchQueued ? "up" : "launch");
  }

  /** Is the gas pedal down (always, with assist)? */
  get onGas(): boolean {
    return this.assist || this.gas;
  }

  /** When the driver launched, ms since green (null: not yet). */
  get launchMs(): number | null {
    return this.launched ? this.launchAt : null;
  }

  /** The latest shift's reaction (negative = early, AUTO_SHIFT_MS = missed), ms. */
  get lastShiftMs(): number | null {
    return this.shiftReactions.length ? this.shiftReactions[this.shiftReactions.length - 1] : null;
  }

  get waitingForCue(): boolean {
    return this.cueAt !== null;
  }

  /** Steps the run forward to `ms` since green. */
  advanceTo(ms: number) {
    while (!this.finished && this.t + 1e-9 < ms) this.tick();
  }

  private coastT = 0;
  private finishedAtT = 0;

  /**
   * Where to draw the car at `ms`. The physics moves in whole steps (1 ms racing, 4 ms in the
   * cool-down) and stops on whichever step passes `ms`, so a frame can land up to a step past it.
   * Carrying the position on to `ms` at the current speed keeps the motion even frame to frame;
   * without it the cool-down alternated 16 and 20 ms of travel per frame and the cars shook.
   */
  viewDistM(ms: number) {
    const at = this.coastT > 0 ? this.coastT : this.t;
    const dt = Math.max(-0.02, Math.min(0.02, (ms - at) / 1000));
    return this.distM + (this.sim.state.speedKmh / 3.6) * dt;
  }

  /**
   * After the line (cosmetic: the result is already fixed): lift, brake progressively and
   * work down the gears as the revs fall, each downshift rev-matched by the gearbox's blip,
   * until the car rolls to a stop in neutral. Steps the same physics, so it sounds right.
   */
  coastTo(ms: number) {
    if (!this.finished || !this.result || !Number.isFinite(this.result.elapsedMs)) return;
    const sim = this.sim;
    const s = sim.state;
    const e = this.cfg.engine;
    if (this.coastT === 0) this.coastT = this.finishedAtT = this.t;
    const step = 4 * DT; // coarser steps are fine for the cool-down
    while (this.coastT + 1e-9 < ms) {
      const since = (this.coastT - this.finishedAtT) / 1000;
      sim.input.throttle = 0;
      // ease onto the brakes after a second of coasting through the traps
      sim.input.brake = s.speedKmh < 3 ? 0.6 : Math.min(0.42, Math.max(0, since - 0.9) * 0.3);
      const downAt = Math.max(e.idleRpm * 1.9, e.redlineRpm * 0.42);
      if (!s.shifting && s.gear > 1 && s.rpm < downAt) sim.shiftDown();
      else if (!s.shifting && s.gear === 1 && s.speedKmh < 12) sim.neutral();
      sim.step(step);
      this.distM += (s.speedKmh / 3.6) * step;
      this.coastT += step * 1000;
    }
  }

  private emit(type: "cue" | "launch" | "shift" | "finish") {
    for (const l of this.listeners) l({ type });
  }

  private tick() {
    const sim = this.sim;
    const s = sim.state;
    const t = this.t;

    while (this.queue.length && this.queue[0][0] <= t) {
      const [at, key] = this.queue.shift()!;
      this.apply(at, key);
      if (this.finished) return;
    }
    sim.input.throttle = this.onGas ? 1 : 0;
    sim.input.brake = this.launched && this.brake ? 1 : 0;

    if (!this.launched) {
      if (t >= NO_LAUNCH_MS) {
        this.finish(true);
        return;
      }
    } else {
      if (!this.onGas) this.offGas += DT * 1000;
      // shift cue: lit when the revs reach the cue in any gear but top
      const canShift = s.gear < this.cfg.gearbox.ratios.length && !s.shifting;
      if (canShift && this.cueAt === null && s.rpm >= this.cue - 1) {
        this.cueAt = t;
        this.emit("cue");
      }
      if (canShift && this.cueAt !== null && t - this.cueAt >= AUTO_SHIFT_MS) {
        this.shiftReactions.push(AUTO_SHIFT_MS);
        this.autoShifts++;
        this.cueAt = null;
        sim.shiftUp();
        this.emit("shift");
      }
    }

    sim.step(DT);
    this.t = t + DT * 1000;

    if (this.launched) {
      const v = s.speedKmh / 3.6;
      this.prevDist = this.distM;
      this.distM += ((v + this.prevSpeed) / 2) * DT;
      this.prevSpeed = v;
      const crossed = (mark: number) => this.prevDist < mark && this.distM >= mark;
      // interpolate inside the step for sub-millisecond marks
      const at = (mark: number) => t + ((mark - this.prevDist) / Math.max(1e-9, this.distM - this.prevDist)) * DT * 1000;
      if (crossed(SIXTY_FT_M)) this.sixtyFt = at(SIXTY_FT_M);
      if (crossed(EIGHTH_MILE_M)) this.eighth = at(EIGHTH_MILE_M);
      if (crossed(QUARTER_MILE_M)) {
        this.finishAt(at(QUARTER_MILE_M), s.speedKmh);
        return;
      }
    }
    if (this.t > MAX_RUN_MS) this.finish(true);
  }

  private apply(at: number, key: DriveKey) {
    const sim = this.sim;
    const s = sim.state;
    if (key === "gas+" || key === "gas-") this.gas = key === "gas+";
    else if (key === "brake+" || key === "brake-") this.brake = key === "brake+";
    else if (key === "launch") {
      if (this.launched) return;
      this.launched = true;
      this.launchAt = at;
      // dump the clutch: it slips at the launch revs (no higher than peak torque) until the
      // wheels catch up. No revs on the two-step = a bog.
      const peak = this.cfg.engine.redlineRpm * 0.62;
      sim.launchSlipRpm = Math.max(this.cfg.engine.idleRpm * 1.3, Math.min(peak, s.rpm));
      sim.shiftUp(); // drop it into first
      this.emit("launch");
    } else if (key === "up") {
      const canShift = s.gear < this.cfg.gearbox.ratios.length && !s.shifting;
      if (!this.launched || !canShift) return; // mid-shift or top gear: nothing happens
      // before the cue lit: scored as negative, by how far short of the cue rpm it was
      this.shiftReactions.push(this.cueAt === null ? -earlyMs(this.cue, s.rpm) : at - this.cueAt);
      this.cueAt = null;
      sim.shiftUp();
      this.emit("shift");
    } else if (key === "down") {
      if (!this.launched) return;
      this.cueAt = null;
      sim.shiftDown();
      this.emit("shift");
    }
  }

  private finishAt(elapsedMs: number, trapKmh: number) {
    const launch = this.launchAt ?? 0;
    this.finished = true;
    this.result = {
      reactionMs: this.launchAt,
      redLight: this.launchAt !== null && this.launchAt < 0,
      dnf: false,
      elapsedMs,
      etMs: elapsedMs - Math.max(0, launch),
      sixtyFtMs: this.sixtyFt - Math.max(0, launch),
      eighthMs: this.eighth - Math.max(0, launch),
      trapKmh,
      shiftReactionsMs: this.shiftReactions,
      autoShifts: this.autoShifts,
      offGasMs: this.offGas,
    };
    this.emit("finish");
  }

  private finish(dnf: boolean) {
    this.finished = true;
    this.result = {
      reactionMs: this.launchAt,
      redLight: this.launchAt !== null && this.launchAt < 0,
      dnf,
      elapsedMs: Infinity,
      etMs: Infinity,
      sixtyFtMs: Infinity,
      eighthMs: Infinity,
      trapKmh: 0,
      shiftReactionsMs: this.shiftReactions,
      autoShifts: this.autoShifts,
      offGasMs: this.offGas,
    };
    this.emit("finish");
  }
}

/** An early shift's readout: ~1 ms per 10 rpm short of the cue (the physics already punish it). */
const earlyMs = (cue: number, rpm: number) => Math.max(0, cue - rpm) / 10;

/** Replays a complete drive. */
export function replay(cfg: VehicleConfig, log: DriveLog, treeMs = TREE_MS): RunResult {
  const run = new DragRun(cfg, treeMs, { assist: log.assist });
  for (const [ms, key] of log.events) run.input(ms, key);
  run.advanceTo(MAX_RUN_MS + 1);
  return run.result!;
}

const dialCache = new Map<string, number>();

/** The car's perfect run in drag trim, green to finish (ms): 0 ms reaction, every shift on the cue. */
export function dialIn(cfg: VehicleConfig): number {
  const hit = dialCache.get(cfg.id);
  if (hit !== undefined) return hit;
  const p = parityOf(cfg);
  const ms = p ? perfectRun(cfg, p.cue, p.trim) : perfectRun(cfg, cueRpm(cfg));
  dialCache.set(cfg.id, ms);
  return ms;
}

/** Bracket start: how much later each lane's green comes (the faster car waits). */
export function bracketOffsets(dialA: number, dialB: number): [number, number] {
  return dialA >= dialB ? [0, dialA - dialB] : [dialB - dialA, 0];
}

export type Outcome = "a" | "b" | "tie";

/**
 * Who reached the finish first, counting the bracket head start. A red light loses
 * (both red: the earlier one loses), a no-start loses.
 */
export function decide(a: RunResult, b: RunResult, offsets: [number, number]): Outcome {
  if (a.redLight || b.redLight) {
    if (a.redLight && b.redLight) return a.reactionMs! < b.reactionMs! ? "b" : a.reactionMs! > b.reactionMs! ? "a" : "tie";
    return a.redLight ? "b" : "a";
  }
  const fa = offsets[0] + a.elapsedMs;
  const fb = offsets[1] + b.elapsedMs;
  if (!Number.isFinite(fa) && !Number.isFinite(fb)) return "tie";
  if (Math.abs(fa - fb) < 0.0005) return "tie";
  return fa < fb ? "a" : "b";
}
