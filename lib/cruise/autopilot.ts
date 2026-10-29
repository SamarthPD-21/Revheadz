import type { Simulation } from "../sim/Simulation";
import type { VehicleConfig } from "../vehicles/types";

/** Sideways grip a relaxed driver uses in a bend, m/s². */
const COMFY_LAT = 3.2;
/** How hard it's happy to slow down for a bend coming up, m/s². */
const COMFY_DECEL = 2.2;

/**
 * The speed to hold now so every bend ahead can be taken comfortably, given the tightest
 * curvature at each distance ahead and the speed the driver asked for (km/h).
 */
export function safeSpeedKmh(bends: { curvature: number; at: number }[], wantKmh: number): number {
  let v = wantKmh / 3.6;
  for (const b of bends) {
    if (b.curvature < 1e-5) continue;
    const vBend = Math.sqrt(COMFY_LAT / b.curvature);
    // the speed we can be doing now and still slow to vBend by the time we get there
    v = Math.min(v, Math.sqrt(vBend * vBend + 2 * COMFY_DECEL * b.at));
  }
  return v * 3.6;
}

/**
 * Cruise control: throttle and brake that close the gap to a target speed gently and then
 * hold it exactly (the integral term learns how much throttle this car needs to hold it).
 */
export class SpeedHold {
  private held = 0.25;

  update(speedKmh: number, targetKmh: number, dt: number): { throttle: number; brake: number } {
    const err = (targetKmh - speedKmh) / 3.6;
    if (err < -2.5) {
      this.held = Math.max(0, this.held - dt * 0.5);
      return { throttle: 0, brake: Math.min(0.8, (-err - 2.5) * 0.12 + 0.1) };
    }
    this.held = Math.min(1, Math.max(0, this.held + err * 0.06 * dt));
    return { throttle: Math.min(1, Math.max(0, this.held + err * 0.2)), brake: 0 };
  }
}

/**
 * Changes gear for the driver: up when the revs are high (early if cruising gently, late if
 * pressing on), down when they sag or when more power is asked for and the next gear down
 * has room. Call every frame; returns the new "last shift" time.
 */
export function autoShift(sim: Simulation, cfg: VehicleConfig, throttle: number, now: number, lastShift: number): number {
  const s = sim.state;
  if (s.ignition !== "running" || s.shifting || now - lastShift < 0.9) return lastShift;
  const ratios = cfg.gearbox.ratios;
  const top = ratios.length;
  const red = cfg.engine.redlineRpm;
  if (s.gear === 0) {
    if (throttle > 0.05) {
      sim.shiftUp();
      return now;
    }
    return lastShift;
  }
  const g = s.gear;
  // the revs below which it changes down; up-changes must land comfortably above it
  const floor = Math.max(cfg.engine.idleRpm * 1.5, red * 0.3);
  // gentle throttle: change up early and cruise low; flat out: use the revs
  const upAt = red * (0.45 + 0.43 * Math.pow(Math.min(1, throttle), 1.5));
  if (g < top && s.rpm > upAt) {
    const next = (s.rpm * ratios[g]) / ratios[g - 1];
    if (next > floor * 1.15) {
      sim.shiftUp();
      return now;
    }
  }
  if (g > 1) {
    const lower = (s.rpm * ratios[g - 2]) / ratios[g - 1];
    const lugging = s.rpm < floor;
    const kick = throttle > 0.85 && s.rpm < red * 0.55 && lower < red * 0.85;
    if ((lugging && s.speedKmh > 3) || kick) {
      sim.shiftDown();
      return now;
    }
  }
  return lastShift;
}
