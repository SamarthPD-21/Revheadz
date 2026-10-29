import type { VehicleConfig } from "../vehicles/types";

const G = 9.81;

/** Cars that drive all four wheels (the rest of the garage's cars drive the rear). */
const AWD = new Set(["skyline_r34", "subaru_sti", "boxer4_rally", "bugatti_chiron", "audi_r8_v10", "aventador_svj", "twin_turbo_v6", "hot_hatch"]);

export interface Chassis {
  massKg: number;
  /** Front to rear axle, m. */
  wheelbase: number;
  /** Share of the weight on the front axle. */
  front: number;
  /** Share of the drive at the rear wheels (1 rear-drive, ~0.6 all-wheel drive). */
  rearDrive: number;
  bike: boolean;
}

export function chassisOf(cfg: VehicleConfig, lengthM: number): Chassis {
  const bike = cfg.type === "bike";
  const mid = /mid|rear/i.test(cfg.ui.layout ?? "") || ["formula"].includes(cfg.ui.silhouette);
  return {
    massKg: cfg.dynamics.massKg + (bike ? 80 : 75), // and the driver
    wheelbase: bike ? 1.45 : Math.min(3.0, Math.max(2.3, lengthM * 0.6)),
    front: bike ? 0.5 : mid ? 0.43 : 0.53,
    rearDrive: AWD.has(cfg.id) ? 0.6 : 1,
    bike,
  };
}

/** The car's motion in its own frame, carried from frame to frame. */
export interface Motion {
  /** Sideways speed at the centre of mass, m/s (+ right). */
  vy: number;
  /** Yaw rate, rad/s (+ turning right). */
  r: number;
  /** Front wheels' steering angle, rad (+ right). */
  delta: number;
}

export interface Controls {
  /** Forward speed, m/s (the engine simulation's). */
  vx: number;
  /** Driver's steering, -1 full left .. 1 full right. */
  steer: number;
  /** How hard the car is speeding up (+) or slowing (-), m/s²: what the tyres are spending grip on. */
  accel: number;
  /** Grip of the surface: about 1 on dry tarmac, less wet, on grass, dirt or in water. */
  mu: number;
}

/** How far the wheel can be turned at a speed: lots when parking, a little at speed (like a real rack's feel). */
export const steerLock = (vx: number) => Math.min(0.55, Math.max(0.055, 0.55 / (1 + Math.max(0, vx) / 6)));

/**
 * One step of a dynamic bicycle model. Each axle's tyres make sideways force from their slip
 * angle, rising steeply then levelling off at the grip limit (so too much steering just
 * scrubs: understeer). Accelerating spends some of the driven wheels' grip, so a rear-drive
 * car can step out under power in a low gear; braking does the same at both ends (more at the
 * front). The slide is kept within what a car can actually do, so even a spin stays a big,
 * catchable slide. At walking pace it blends into plain geometric steering.
 *
 * Returns how hard the tyres are sliding, 0-1 (for scrub, smoke and sound).
 */
export function stepHandling(m: Motion, c: Chassis, u: Controls, dt: number): number {
  const vx = Math.max(0, u.vx);
  // the wheel turns at a hand's pace, and comes back faster than it goes out
  const target = u.steer * steerLock(vx);
  const rate = Math.abs(target) < Math.abs(m.delta) || Math.sign(target) !== Math.sign(m.delta) ? 4.5 : 2.4;
  m.delta += Math.max(-rate * dt, Math.min(rate * dt, target - m.delta));

  const L = c.wheelbase;
  const a = L * (1 - c.front); // centre of mass to front axle
  const b = L * c.front; // to rear axle
  const mass = c.massKg;
  const Iz = mass * a * b;
  const fzF = (mass * G * b) / L;
  const fzR = (mass * G * a) / L;
  const grip = u.mu * (c.bike ? 1.15 : 1);
  // the force each axle is putting down along the road leaves it less for cornering (the friction circle)
  const drive = Math.max(0, u.accel) * mass;
  const brake = Math.max(0, -u.accel) * mass;
  // (a spinning tyre still holds some of its sideways grip, so it never goes to nothing)
  const pushR = Math.min(0.78, (drive * c.rearDrive + brake * 0.4) / Math.max(1, grip * fzR));
  const pushF = Math.min(0.78, (drive * (1 - c.rearDrive) + brake * 0.6) / Math.max(1, grip * fzF));
  // a little more grip at the back than the front, like a real car set up to push wide at the
  // limit rather than spin (power can still break the rear loose)
  const maxF = grip * 0.96 * fzF * Math.sqrt(1 - pushF * pushF);
  const kF = fzF * 17; // cornering stiffness, N/rad
  const kR = fzR * 19;
  const tyre = (alpha: number, k: number, max: number) => -max * Math.tanh((k * alpha) / Math.max(1, max));

  let sliding = 0;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const v = Math.max(vx, 0.5);
    const aF = Math.atan2(m.vy + a * m.r, v) - m.delta;
    const aR = Math.atan2(m.vy - b * m.r, v);
    // traction control: as the driven rear starts to slide, the drive is eased off it
    const tc = 1 - Math.min(1, Math.max(0, (Math.abs(aR) - 0.045) / 0.08));
    const pr = pushR * tc;
    const maxR = grip * 1.12 * fzR * Math.sqrt(1 - pr * pr);
    const fF = tyre(aF, kF, maxF);
    const fR = tyre(aR, kR, maxR);
    const cosD = Math.cos(m.delta);
    m.vy += ((fF * cosD + fR) / mass - vx * m.r) * h;
    m.r += ((a * fF * cosD - b * fR) / Iz) * h;
    // stability control. It never fights a car that turns less than asked (that's just grip
    // running out); it reins in one rotating more than the wheel asks (oversteer), and when you
    // let go of the wheel in a real slide it catches it the way a driver would, countersteering
    // the nose back towards where the car is actually going.
    const asked = Math.max(-grip * G / v, Math.min(grip * G / v, (vx * Math.tan(m.delta)) / L));
    const slip = Math.atan2(m.vy, v); // + travelling to the right of the nose
    if (vx > 4) {
      const over = Math.sign(m.r) !== Math.sign(asked) ? Math.abs(m.r - asked) : Math.abs(m.r) - Math.abs(asked);
      if (over > 0.05) m.r += (asked - m.r) * Math.min(1, Math.min(1, (over - 0.05) / 0.2) * 3 * h);
      if (Math.abs(u.steer) < 0.1 && Math.abs(slip) > 0.1) m.r += (slip * 2.2 - m.r) * Math.min(1, 3 * h);
    }
    // the engine sets the speed along the car, so a slide can't build without end: keep the
    // slip angle within ~30 degrees and the yaw within what the grip could ever turn
    const maxVy = 0.58 * vx + 0.3;
    if (Math.abs(m.vy) > maxVy) m.vy = Math.sign(m.vy) * maxVy;
    const rLimit = (grip * G * 1.8) / Math.max(v, 3) + 0.4;
    if (Math.abs(m.r) > rLimit) m.r = Math.sign(m.r) * rLimit;
    sliding = Math.max(Math.abs(kF * aF) / Math.max(1, maxF), Math.abs(kR * aR) / Math.max(1, maxR));
  }
  // slow: plain geometry, and nothing to slide on
  const w = Math.min(1, Math.max(0, (vx - 1) / 3));
  if (w < 1) {
    const rKin = (vx * Math.tan(m.delta)) / L;
    m.r = rKin + (m.r - rKin) * w;
    m.vy *= w;
  }
  return Math.min(1, Math.max(0, (sliding - 1) / 3));
}
