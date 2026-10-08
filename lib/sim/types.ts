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
}

export type SimEvent =
  | { type: "start" }
  | { type: "stop" }
  | { type: "shift"; direction: "up" | "down" }
  | { type: "backfire" }
  | { type: "limiter" }
  | { type: "blowoff" }
  /** Ignition-cut crack on a fast loaded upshift (DCT / quickshifter). */
  | { type: "shiftCrack" };

export interface SimInput {
  /** Raw throttle target, 0-1 */
  throttle: number;
  /** Brake, 0-1 */
  brake: number;
}

export type SimListener = (event: SimEvent) => void;
