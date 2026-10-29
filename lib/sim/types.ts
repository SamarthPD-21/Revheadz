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
}

export type SimListener = (event: SimEvent) => void;
