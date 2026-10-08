import type { EngineConfig } from "../vehicles/types";

export class Engine {
  rpm = 0;

  constructor(readonly cfg: EngineConfig) {}

  /** Torque (Nm) at the current rpm for a given throttle: gentle bell curve. */
  torque(rpm: number, throttle: number): number {
    const x = rpm / this.cfg.redlineRpm;
    const shape = Math.max(0.35, 1 - 0.9 * (x - 0.62) * (x - 0.62) * 2.2);
    return this.cfg.peakTorqueNm * shape * throttle;
  }

  /**
   * Torque dragging on the wheels when off the throttle (Nm): pumping losses against a
   * closed throttle plus friction, rising with rpm. Gives a real "engine braking" feel in
   * low gears and a gentle coast in tall ones.
   */
  brakingTorque(rpm: number): number {
    const x = Math.max(0, rpm - this.cfg.idleRpm) / this.cfg.redlineRpm;
    return this.cfg.engineBraking * this.cfg.peakTorqueNm * (0.12 + 0.6 * x);
  }

  /** Free-revving rate of change (rpm/s) with no road load. */
  freeRpmRate(rpm: number, throttle: number): number {
    const { idleRpm, limiterRpm, inertia, engineBraking } = this.cfg;
    const accel = (1.15 * (limiterRpm - idleRpm) * engineBraking) / inertia;
    const drag = ((rpm - idleRpm) * engineBraking) / inertia;
    return throttle * accel - drag;
  }
}
