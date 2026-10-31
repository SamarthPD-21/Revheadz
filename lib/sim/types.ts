export type IgnitionState = "off" | "cranking" | "running";

export interface SimState {
  rpm: number;
  throttle: number;
  load: number;
  /** 0 = neutral, 1..n */
  gear: number;
  speedKmh: number;
  ignition: IgnitionState;
  limiterActive: boolean;
  shifting: boolean;
  /** 0-1 turbo boost (always 0 without a turbo). */
  boost: number;
  /** 0-1: how hard the driven wheels are spinning on the road (only where traction is limited). */
  wheelspin?: number;
  /** The brakes have locked the wheels (more pedal than the tyres can take, and no ABS to stop it). */
  locked?: boolean;
  /** ABS is working the brakes at the edge of grip. */
  abs?: boolean;
}

export type SimEvent =
  | { type: "start" }
  | { type: "stop" }
  | { type: "shift"; direction: "up" | "down" }
  | { type: "backfire" }
  | { type: "limiter" }
  | { type: "blowoff" }
  /** Ignition-cut crack on a fast loaded upshift (DCT / quickshifter). */
  | { type: "shiftCrack" }
  /** A small overrun pop while coasting at high revs. */
  | { type: "crackle" }
  /** The engine was dragged below idle with the clutch in and died (followed by a stop). */
  | { type: "stall" };

export interface SimInput {
  /** Raw throttle target, 0-1 */
  throttle: number;
  /** Brake, 0-1 */
  brake: number;
  /** Slope of the ground along the car, rise per metre (+ uphill). Absent on the flat (the strip). */
  grade?: number;
  /**
   * The most force the driven tyres can put down before they spin, N. Absent on the strip
   * (its launches are modelled their own way); any more drive than this becomes wheelspin.
   */
  traction?: number;
  /** Traction control: power trimmed to the grip rather than spinning the wheels (default on). */
  tc?: boolean;
  /** The most braking force the tyres can take before the wheels lock, N (absent: no limit). */
  brakeGrip?: number;
  /** Anti-lock brakes: held at the grip limit instead of locking (default on). */
  abs?: boolean;
  /** Any other force holding the car back, N: soft ground, the tyres scrubbing through a bend. */
  resist?: number;
  /** The parking brake: pulls hard on the rear wheels, locking them and breaking the back end loose. */
  handbrake?: boolean;
}

/**
 * The car as it really is, for driving it on the open road (Cruise): when set, the simulation
 * uses this engine, weight, aero and drivetrain instead of the drag strip's own tuning.
 */
export interface RoadModel {
  /** Everything moving, with the driver, kg. */
  massKg: number;
  /** Drag coefficient times frontal area, m². */
  cdA: number;
  /** Engine torque at full throttle, Nm, by rpm. */
  torque(rpm: number): number;
  /** Share of the engine's torque that reaches the tyres. */
  efficiency: number;
  /** Crank, flywheel and clutch, kg·m²: in gear it has to be spun up too (most in the low gears). */
  engineInertia: number;
  /** All the wheels and what turns with them, kg·m². */
  wheelInertia: number;
  /** Revs a driver holds pulling away flat out, slipping the clutch until the car catches up. */
  launchRpm: number;
  /** What the brakes alone could do, m/s²: more than tyres can take, so grip sets the stop. */
  brakeDecel: number;
  /** An electronic limiter: no more drive past this speed, km/h. */
  topKmh?: number;
}

export type SimListener = (event: SimEvent) => void;
