import type { GearboxConfig } from "../vehicles/types";

const MS_PER_KMH = 1 / 3.6;

export class Gearbox {
  constructor(private readonly cfg: GearboxConfig) {}

  get maxGear(): number {
    return this.cfg.ratios.length;
  }

  get shiftTimeS(): number {
    return this.cfg.shiftTimeMs / 1000;
  }

  /** Overall engine-to-wheel ratio for a gear (0 for neutral). */
  totalRatio(gear: number): number {
    if (gear < 1 || gear > this.maxGear) return 0;
    return this.cfg.ratios[gear - 1] * this.cfg.finalDrive;
  }

  /** RPM = speed x gear ratio x final drive / wheel circumference (per minute). */
  rpmFromSpeed(speedKmh: number, gear: number): number {
    const ratio = this.totalRatio(gear);
    if (ratio === 0) return 0;
    const wheelRevPerMin = (speedKmh * MS_PER_KMH * 60) / (2 * Math.PI * this.cfg.wheelRadiusM);
    return wheelRevPerMin * ratio;
  }

  speedFromRpm(rpm: number, gear: number): number {
    const ratio = this.totalRatio(gear);
    if (ratio === 0) return 0;
    const wheelRevPerMin = rpm / ratio;
    return (wheelRevPerMin * 2 * Math.PI * this.cfg.wheelRadiusM) / 60 / MS_PER_KMH;
  }

  /** Force at the tyre contact patch (N) for a given engine torque. */
  wheelForce(engineTorqueNm: number, gear: number): number {
    return (engineTorqueNm * this.totalRatio(gear) * 0.9) / this.cfg.wheelRadiusM;
  }
}
