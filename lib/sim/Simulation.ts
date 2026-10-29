import type { GearboxType, VehicleConfig } from "../vehicles/types";
import { Engine } from "./Engine";
import { Gearbox } from "./Gearbox";
import { LowFreqStore } from "./LowFreqStore";
import { pexp } from "./portableMath";
import type { SimEvent, SimInput, SimListener, SimState } from "./types";

/** Fixed simulation step: identical behaviour on 60 Hz phones and 144 Hz monitors. */
export const STEP = 1 / 120;

const THROTTLE_TAU = 0.06;
const LOAD_TAU = 0.08;
const CRANK_S = 0.8;
const CRANK_RPM = 250;
/**
 * Soft-cut rev limiter, like a modern ECU: at the limiter most of the fuel is cut until the
 * revs fall back a little (or a maximum time passes), then it's restored and the engine climbs
 * back into the limiter again. That cycle is the familiar irregular "bounce".
 */
const CUT_MIN_S = 0.02;
const CUT_MAX_S = 0.075; // plus up to 30 ms of random variation per cut
const CUT_POWER = 0.15; // share of throttle that still fires during a cut
const cutDrop = (limiterRpm: number) => Math.max(120, limiterRpm * 0.018);
const BACKFIRE_WINDOW_S = 0.6;
/** A lift only counts as "coasting" (and may pop) if the throttle stays shut this long without a gear change. */
const LIFT_CONFIRM_S = 0.25;
const AIR_DENSITY = 1.2;
const ROLLING_RESISTANCE = 0.015;
const G = 9.81;
const MAX_FRAME_S = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (x: number) => x * x * (3 - 2 * x);

/**
 * How each kind of gearbox changes gear: the torque-cut (or clutch handover) phase, then the
 * engagement. `carry` is the share of drive that keeps reaching the wheels during the first phase:
 * nothing through an open clutch or a dog-box cut; most of it through a dual-clutch handover or a
 * torque converter's overlap. `selfShift`: the box changes down on its own when the revs sag
 * (and an automatic kicks down when you floor it).
 */
const SHIFT_STYLE = {
  manual: { cutScale: 1, engageS: 0.16, crack: false, pullDown: 0, carry: 0, selfShift: false },
  dct: { cutScale: 1, engageS: 0.05, crack: true, pullDown: 1, carry: 0.6, selfShift: true },
  amt: { cutScale: 1, engageS: 0.07, crack: true, pullDown: 0.6, carry: 0, selfShift: true },
  sequential: { cutScale: 0.6, engageS: 0.035, crack: true, pullDown: 1, carry: 0, selfShift: false },
  auto: { cutScale: 1, engageS: 0.14, crack: false, pullDown: 1, carry: 0.45, selfShift: true },
} as const;
/** Torque converter: torque multiplication at stall, and the speed ratio where it couples (1:1). */
const TC_STALL_GAIN = 2;
const TC_COUPLING = 0.85;

interface ShiftPlan {
  direction: "up" | "down";
  /** Seconds left with drive torque cut / clutch open. */
  cut: number;
  cutTotal: number;
  /** Seconds left of clutch engagement (rpm blends to the wheels, torque ramps back). */
  engage: number;
  engageTotal: number;
  /** DCT/quickshifter: clutches drag the engine to the new gear speed during the cut. */
  pullDown: number;
  /** Rpm at the start of engagement, blended towards the wheel speed. */
  engageFrom: number;
}

export class Simulation {
  readonly state: SimState = {
    rpm: 0,
    throttle: 0,
    load: 0,
    gear: 0,
    speedKmh: 0,
    ignition: "off",
    limiterActive: false,
    shifting: false,
    boost: 0,
  };
  readonly input: SimInput = { throttle: 0, brake: 0 };
  /**
   * Drag launch: while set, pulling away slips the clutch at this rpm (instead of a gentle
   * part-throttle slip) until the wheels catch up. Off (null) for normal driving.
   */
  launchSlipRpm: number | null = null;
  readonly store = new LowFreqStore();

  private readonly engine: Engine;
  private readonly gearbox: Gearbox;
  private readonly listeners = new Set<SimListener>();
  private speedMs = 0;
  private freeRpm = 0;
  private shift: ShiftPlan | null = null;
  private crankTimer = 0;
  private fuelCutTimer = 0;
  private fuelCutElapsed = 0;
  private backfireArmed = false;
  private pops: number[] = [];
  /** Seconds left before a lift-off is confirmed as coasting; 0 = no lift pending. */
  private liftPending = 0;
  private liftRpm = 0;
  /** True while genuinely coasting (lift confirmed, no shift, throttle shut). */
  private coasting = false;
  /** Brake pedal after smoothing (a real pedal and brake system don't go 0 to 100% instantly). */
  private brake = 0;
  private accumulator = 0;
  private idleNoise = 0;
  private noiseSeed = 12345;
  /** Automatic throttle blip applied to the free engine during a downshift. */
  private blip = 0;
  /** 0-1 clutch engagement after a shift; scales drive torque. */
  private engageProgress = 1;
  private readonly style: (typeof SHIFT_STYLE)[GearboxType];
  /** Raw throttle input last step, to spot a stab to the floor (kickdown). */
  private prevPedal = 0;

  constructor(
    private readonly cfg: VehicleConfig,
    private readonly rng: () => number = Math.random,
  ) {
    this.engine = new Engine(cfg.engine);
    this.gearbox = new Gearbox(cfg.gearbox);
    this.style = SHIFT_STYLE[cfg.gearbox.type ?? "manual"];
  }

  subscribe(listener: SimListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SimEvent) {
    this.listeners.forEach((l) => l(event));
  }

  // ---- commands -----------------------------------------------------------

  toggleIgnition(): void {
    const s = this.state;
    if (s.ignition === "off") {
      s.ignition = "cranking";
      this.crankTimer = 0;
      this.emit({ type: "start" });
    } else {
      s.ignition = "off";
      this.pops.length = 0;
      this.emit({ type: "stop" });
    }
    this.publish();
  }

  shiftUp(): void {
    if (this.state.gear >= this.gearbox.maxGear) return;
    this.changeGear(this.state.gear + 1, "up");
  }

  shiftDown(): void {
    const next = this.state.gear - 1;
    if (next < 0) return;
    // Like a real ECU, refuse a downshift that would over-rev the engine.
    if (next > 0 && this.gearbox.rpmFromSpeed(this.speedKmh(), next) > this.cfg.engine.redlineRpm) return;
    this.changeGear(next, "down");
  }

  neutral(): void {
    if (this.state.gear === 0) return;
    this.changeGear(0, "down");
  }

  private changeGear(gear: number, direction: "up" | "down") {
    const s = this.state;
    if (this.shift && this.shift.cut > 0) return; // mid-shift: wait for the gear to go in
    const loaded = s.throttle > 0.6 && s.ignition === "running";
    this.liftPending = 0; // a shift means the lift was for the gear change, not a coast
    this.coasting = false;
    this.pops.length = 0;
    this.freeRpm = s.rpm;
    if (gear === 0 || s.ignition !== "running") {
      // neutral, or the engine isn't running: the lever just moves, there's nothing to cut or blend
      this.shift = null;
      s.shifting = false;
    } else {
      const style = this.style;
      const cut = this.gearbox.shiftTimeS * style.cutScale;
      this.shift = {
        direction,
        cut,
        cutTotal: cut,
        engage: style.engageS,
        engageTotal: style.engageS,
        pullDown: style.pullDown,
        engageFrom: s.rpm,
      };
      s.shifting = true;
      if (style.crack && direction === "up" && loaded && s.gear > 0) this.emit({ type: "shiftCrack" });
    }
    s.gear = gear;
    this.emit({ type: "shift", direction });
    this.publish();
  }

  // ---- stepping -----------------------------------------------------------

  /** Advances by a real frame time using fixed steps. */
  advance(frameDtS: number): void {
    this.accumulator += Math.min(frameDtS, MAX_FRAME_S);
    while (this.accumulator >= STEP) {
      this.step(STEP);
      this.accumulator -= STEP;
    }
  }

  step(dt: number): void {
    const s = this.state;
    const eng = this.cfg.engine;

    // brake pressure builds over ~0.15 s and releases over ~0.08 s
    const brakeTarget = clamp(this.input.brake, 0, 1);
    this.brake += (brakeTarget - this.brake) * (1 - pexp(-dt / (brakeTarget > this.brake ? 0.15 : 0.08)));

    // 1. smooth raw input
    const target = s.ignition === "running" ? clamp(this.input.throttle, 0, 1) : 0;
    s.throttle += (target - s.throttle) * (1 - pexp(-dt / THROTTLE_TAU));

    // ignition sequence
    if (s.ignition === "cranking") {
      this.crankTimer += dt;
      this.freeRpm += (CRANK_RPM - this.freeRpm) * Math.min(1, dt * 12);
      if (this.crankTimer >= CRANK_S) {
        s.ignition = "running";
        this.freeRpm = eng.idleRpm * 1.35; // small overshoot, then settles
        this.publish();
      }
    }
    const running = s.ignition === "running";

    // Automated boxes change down on their own when the revs sag (rolling to a stop in 5th lands
    // in 1st), and a torque-converter automatic kicks down a gear when you stab the throttle.
    if (running && !this.shift && this.style.selfShift && s.gear > 1) {
      const now = this.gearbox.rpmFromSpeed(this.speedKmh(), s.gear);
      const below = this.gearbox.rpmFromSpeed(this.speedKmh(), s.gear - 1);
      const sagging = now < eng.idleRpm * 1.1;
      const kick = this.cfg.gearbox.type === "auto" && this.input.throttle > 0.9 && this.prevPedal < 0.5 && now < eng.redlineRpm * 0.5 && below < eng.redlineRpm * 0.85;
      if (sagging || kick) this.changeGear(s.gear - 1, "down");
    }
    this.prevPedal = this.input.throttle;

    // fuel cut / limiter: hold the cut until the revs have dropped back (or time runs out)
    if (this.fuelCutTimer > 0) {
      this.fuelCutTimer -= dt;
      this.fuelCutElapsed += dt;
      const droppedBack = this.engine.rpm <= eng.limiterRpm - cutDrop(eng.limiterRpm);
      if (this.fuelCutElapsed >= CUT_MIN_S && droppedBack) this.fuelCutTimer = 0;
    }
    const fuelCut = this.fuelCutTimer > 0;
    s.limiterActive = fuelCut;
    const inCut = Boolean(this.shift && this.shift.cut > 0);
    const effThrottle = running && !inCut ? s.throttle * (fuelCut ? CUT_POWER : 1) : 0;

    const gear = s.gear;
    const locked = gear > 0 ? this.gearbox.rpmFromSpeed(this.speedKmh(), gear) : 0;
    let rpm: number;
    let clutchLocked = false;
    // torque converter slipping: its torque multiplication, 1 when coupled
    let converterGain = 1;

    if (s.ignition === "cranking") {
      rpm = this.freeRpm;
    } else if (!running) {
      // engine off: decays in neutral, follows the wheels in gear
      this.freeRpm = Math.max(0, this.freeRpm - this.freeRpm * dt * 6);
      rpm = gear > 0 ? locked : this.freeRpm;
    } else if (this.shift && this.shift.cut > 0) {
      // Phase 1: torque cut / clutch open. The engine is free: it falls under its own
      // braking on an upshift, or gets an automatic rev-matching blip on a downshift.
      const sh = this.shift;
      sh.cut -= dt;
      const target = clamp(locked, eng.idleRpm, eng.limiterRpm);
      if (sh.direction === "down") {
        const err = (target * 1.03 - this.freeRpm) / (eng.redlineRpm - eng.idleRpm);
        this.blip = clamp(err * 6, 0, 1);
      } else {
        this.blip = 0;
      }
      this.freeRpm += this.engine.freeRpmRate(this.freeRpm, this.blip) * dt;
      if (sh.pullDown > 0) {
        // dual clutch / quickshifter: the oncoming clutch drags the engine to the new gear's speed
        this.freeRpm += (target - this.freeRpm) * Math.min(1, dt / Math.max(sh.cut, dt)) * sh.pullDown;
      }
      if (sh.cut <= 0) sh.engageFrom = this.freeRpm;
      rpm = this.freeRpm;
    } else if (this.shift) {
      // Phase 2: clutch engagement. Rpm blends onto the wheel speed; torque ramps back in.
      const sh = this.shift;
      sh.engage -= dt;
      this.blip = 0;
      const p = smoothstep(clamp(1 - sh.engage / sh.engageTotal, 0, 1));
      const target = Math.max(this.launchSlipRpm ?? eng.idleRpm, locked);
      rpm = sh.engageFrom + (target - sh.engageFrom) * p;
      this.freeRpm = rpm;
      this.engageProgress = p;
      if (sh.engage <= 0) {
        this.shift = null;
        s.shifting = false;
        this.engageProgress = 1;
      }
    } else if (gear === 0) {
      this.freeRpm += this.engine.freeRpmRate(this.freeRpm, effThrottle) * dt;
      rpm = this.freeRpm;
    } else if (this.cfg.gearbox.type === "auto") {
      // In gear through a torque converter. It lets the engine run up towards its stall speed
      // against a slow-turning gearbox, multiplying torque as it slips, and couples (its lock-up
      // clutch closes) once the gearbox catches up. A drag launch is a brake-torque launch: the
      // converter holds the revs at stall at most.
      const stall = this.cfg.gearbox.stallRpm ?? eng.idleRpm + 0.3 * (eng.redlineRpm - eng.idleRpm);
      const launch = this.launchSlipRpm;
      const want = launch !== null && effThrottle > 0.5 ? Math.min(launch, stall) : eng.idleRpm + effThrottle * (stall - eng.idleRpm);
      if (locked >= want) {
        clutchLocked = true;
        this.freeRpm = locked;
        rpm = locked;
      } else {
        this.freeRpm += (want - this.freeRpm) * Math.min(1, dt * 8);
        rpm = this.freeRpm;
        const ratio = rpm > 0 ? locked / rpm : 0;
        if (ratio < TC_COUPLING) converterGain = 1 + (TC_STALL_GAIN - 1) * (1 - ratio / TC_COUPLING);
      }
    } else {
      // In gear. Slip the clutch at crawling speed so the engine never stalls.
      const launch = this.launchSlipRpm;
      const desired = launch !== null && effThrottle > 0.5 ? launch : eng.idleRpm + effThrottle * 0.35 * (eng.redlineRpm - eng.idleRpm);
      const lockRpm = launch !== null ? Math.max(eng.idleRpm * 1.15, desired) : Math.max(eng.idleRpm * 1.15, Math.min(desired, eng.idleRpm * 2.2));
      if (locked >= lockRpm) {
        clutchLocked = true;
        this.freeRpm = locked;
        rpm = locked;
      } else {
        this.freeRpm += (desired - this.freeRpm) * Math.min(1, dt * 10);
        rpm = this.freeRpm;
      }
    }

    if (running) {
      rpm = clamp(rpm, eng.idleRpm, eng.limiterRpm);
      // a real idle never sits dead still: slow, small governor hunting near idle
      this.idleNoise += ((this.noiseSeed = (this.noiseSeed * 16807) % 2147483647) / 2147483647 * 2 - 1 - this.idleNoise) * Math.min(1, dt * 5);
      const nearIdle = Math.max(0, 1 - (rpm - eng.idleRpm) / (eng.idleRpm * 0.5));
      rpm += eng.idleRpm * 0.006 * (0.5 + 0.5 * this.idleNoise) * nearIdle;
      this.freeRpm = Math.min(this.freeRpm, eng.limiterRpm);
      if (effThrottle > 0.05 && rpm >= eng.limiterRpm - 1 && this.fuelCutTimer <= 0) {
        this.fuelCutTimer = CUT_MAX_S + this.rng() * 0.03;
        this.fuelCutElapsed = 0;
        s.limiterActive = true;
        this.emit({ type: "limiter" });
      }
    }

    // turbo: boost builds with rpm and throttle, with lag; it fattens the torque
    const turbo = this.cfg.turbo;
    if (turbo) {
      const spool = clamp((rpm - turbo.spoolRpm) / (eng.redlineRpm * 0.45), 0, 1);
      const target = running ? spool * effThrottle : 0;
      s.boost += (target - s.boost) * (1 - pexp(-dt / turbo.lagS));
    }
    const torqueScale = turbo ? 0.65 + 0.45 * s.boost : 1;

    // 2. road speed
    let force = 0;
    const engaging = Boolean(this.shift && this.shift.cut <= 0);
    if (gear > 0 && running && inCut && this.style.carry > 0 && this.shift?.direction === "up") {
      // a dual-clutch handover or a converter's overlap: most of the drive keeps flowing mid-shift
      const pedal = s.throttle * (fuelCut ? CUT_POWER : 1);
      force += this.gearbox.wheelForce(this.engine.torque(rpm, pedal) * torqueScale, gear) * this.style.carry;
    }
    if (gear > 0 && running && !inCut) {
      const clutch = engaging ? this.engageProgress : 1;
      force += this.gearbox.wheelForce(this.engine.torque(rpm, effThrottle) * torqueScale * converterGain, gear) * clutch;
      if (clutchLocked) {
        force -= this.gearbox.wheelForce(this.engine.brakingTorque(rpm), gear) * (1 - effThrottle);
      }
    }
    const v = this.speedMs;
    if (v > 0) {
      force -= 0.5 * AIR_DENSITY * this.cfg.dynamics.cdA * v * v;
      force -= ROLLING_RESISTANCE * this.cfg.dynamics.massKg * G;
      // progressive braking that eases off in the last metre per second, so stops aren't abrupt
      const ease = 0.35 + 0.65 * Math.min(1, v / 1.5);
      force -= this.brake * ease * this.cfg.dynamics.massKg * this.cfg.dynamics.brakeDecel;
    }
    // gravity along a slope (only off the flat strip: the drag races never set it)
    const grade = this.input.grade;
    // sin(atan(grade)), written with sqrt: exact in every browser, like the rest of the physics
    if (grade) force -= (this.cfg.dynamics.massKg * G * grade) / Math.sqrt(1 + grade * grade);
    const prevSpeed = this.speedMs;
    this.speedMs = Math.max(0, this.speedMs + (force / this.cfg.dynamics.massKg) * dt);
    // resistance can't push a stationary car backwards
    if (prevSpeed === 0 && force < 0) this.speedMs = 0;

    // re-derive rpm from the updated speed when the clutch is locked
    if (clutchLocked) rpm = clamp(this.gearbox.rpmFromSpeed(this.speedKmh(), gear), eng.idleRpm, eng.limiterRpm);

    // 3. load
    const rising = clamp((rpm - this.engine.rpm) / dt / 3000, 0, 1);
    // the downshift blip is audible: it drives the on-load layer like a real throttle stab
    // (through a handover the engine stays loaded, so it doesn't sound like a lift)
    const loadTarget = inCut ? Math.max(this.blip * 0.9, this.style.carry * s.throttle) : fuelCut ? 0.08 : effThrottle > 0.02 ? s.throttle * (0.4 + 0.6 * rising) : 0;
    s.load += (loadTarget - s.load) * (1 - pexp(-dt / LOAD_TAU));

    this.engine.rpm = rpm;
    s.rpm = rpm;
    s.speedKmh = this.speedKmh();

    // 4. events
    this.updateBackfire(dt, running);
    this.publish();
  }

  private speedKmh(): number {
    return this.speedMs * 3.6;
  }

  private updateBackfire(dt: number, running: boolean) {
    const s = this.state;
    const eng = this.cfg.engine;
    if (s.throttle > 0.6) this.backfireArmed = true;
    if (this.backfireArmed && s.throttle < 0.1) {
      this.backfireArmed = false;
      if (running) {
        this.liftPending = LIFT_CONFIRM_S;
        this.liftRpm = s.rpm;
        // a turbo vents the moment you lift, shift or not
        if (s.boost > 0.4) this.emit({ type: "blowoff" });
      }
    }
    // Lifting to change gear is not coasting: lift sounds only happen if the throttle
    // stays shut with no shift (a shift clears liftPending).
    if (this.liftPending > 0) {
      if (s.throttle > 0.1 || !running) this.liftPending = 0;
      else if ((this.liftPending -= dt) <= 0) {
        this.liftPending = 0;
        this.coasting = true;
        if (this.liftRpm > 0.6 * eng.redlineRpm) {
          const count = 1 + Math.floor(this.rng() * 3);
          for (let i = 0; i < count; i++) this.pops.push(this.rng() * BACKFIRE_WINDOW_S);
        }
      }
    }
    if (s.throttle > 0.1 || !running || s.shifting) this.coasting = false;
    // overrun crackle: unburnt fuel popping in the exhaust while coasting at high revs
    const crackle = eng.crackle ?? 0;
    if (this.coasting && crackle > 0 && s.rpm > 0.45 * eng.redlineRpm) {
      const rate = crackle * 8 * ((s.rpm / eng.redlineRpm - 0.45) / 0.55); // pops per second, up to ~8 at redline
      if (this.rng() < rate * dt) this.emit({ type: "crackle" });
    }
    for (let i = this.pops.length - 1; i >= 0; i--) {
      this.pops[i] -= dt;
      if (this.pops[i] <= 0) {
        this.pops.splice(i, 1);
        if (running) this.emit({ type: "backfire" });
      }
    }
  }

  private publish() {
    this.store.set(this.state.gear, this.state.ignition);
  }
}
