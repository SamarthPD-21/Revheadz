import type { VehicleConfig } from "../../lib/vehicles/types";

/** What the scene needs to know about one car this frame. */
export interface SceneCar {
  cfg: VehicleConfig;
  distM: number;
  speedKmh: number;
  /** Staging roll-in: metres behind the start line (0 = staged). */
  rollBackM: number;
  /** 0-1 exhaust flame (shift crack / limiter). */
  flame: number;
  /** Finish time to show on the timing tower, s. */
  et: number | null;
  trapKmh: number | null;
  /** Lane tree. */
  lights: { stage: boolean; ambers: boolean[]; green: boolean; red: boolean; win: boolean };
}

export interface SceneFrame {
  me: SceneCar;
  opp: SceneCar;
  /** Seconds, for animation. */
  time: number;
  /** 0-1 camera shake this frame. */
  shake: number;
}
