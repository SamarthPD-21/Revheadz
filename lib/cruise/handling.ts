import type { VehicleConfig } from "../vehicles/types";
import { roadModel, specOf } from "./specs";

const G = 9.81;

export interface Aids {
  /** Anti-lock brakes. */
  abs: boolean;
  /** Traction control: eases the power off as the driven wheels start to spin. */
  tc: boolean;
  /** Stability control: brakes single wheels to stop the car rotating more than it's steered. */
  esc: boolean;
}

export interface Chassis {
  /** With the driver, kg. */
  massKg: number;
  /** Front to rear axle, m. */
  wheelbase: number;
  /** Share of the weight on the front axle. */
  front: number;
  /** Share of the drive at the rear wheels (1 rear-drive, ~0.6 all-wheel drive). */
  rearDrive: number;
  bike: boolean;
  /** The tyres' grip on dry tarmac, as a friction coefficient (about the car's skidpad g). */
  tyre: number;
  /** How well those tyres do on loose ground (grass, dirt): a rally car's best, slicks are hopeless. */
  offRoad: number;
  /** Aerodynamic downforce, N per (m/s)²: grip that grows with speed (wings, floors). */
  downforce: number;
  /** Height of the centre of mass, m: how much weight shifts back under power, forward on the brakes. */
  cgHeight: number;
  /** The driver aids the car was built with. */
  aids: Aids;
}

/** Tyres by body: [off-road, downforce]. */
const BODY: Record<string, [number, number]> = {
  formula: [0.45, 3.4],
  gtcar: [0.6, 1.0],
  supercar: [0.7, 0.2],
  gt: [0.75, 0.1],
  sport: [0.8, 0.05],
  coupe: [0.85, 0],
  hatch: [0.95, 0],
  muscle: [0.85, 0],
  rally: [1.45, 0.05],
  superbike: [0.7, 0],
  cruiser: [0.9, 0],
};

export function chassisOf(cfg: VehicleConfig, lengthM: number): Chassis {
  const bike = cfg.type === "bike";
  const spec = specOf(cfg);
  const [offRoad, downforce] = BODY[cfg.ui.silhouette] ?? [0.85, 0];
  return {
    massKg: roadModel(cfg).massKg,
    wheelbase: bike ? 1.45 : Math.min(3.0, Math.max(2.3, lengthM * 0.6)),
    front: spec.front,
    rearDrive: spec.drive === "awd" ? 0.6 : 1,
    bike,
    // (the skidpad figure includes a little downforce on the cars that have it)
    tyre: spec.g - downforce * 0.03,
    offRoad,
    downforce,
    cgHeight: bike ? 0.72 : cfg.ui.silhouette === "formula" ? 0.3 : 0.5,
    aids: { abs: spec.abs, tc: spec.tc, esc: spec.esc },
  };
}

/**
 * The most force the driven wheels can put down before they spin, N: grip times the weight on
 * them. Weight moves onto the rear under power and up a hill (good for a rear-drive car); an
 * all-wheel-drive car has all four. Downforce adds to it at speed. A bike can't pull harder
 * than the point where its front wheel lifts.
 */
/**
 * Tyres grip harder along the way they roll than a car can corner on them (a skidpad never has
 * all four at their best at once): a car that corners at 1 g stops at about 1.15 g, and pulls
 * away harder still on its wider driven tyres.
 */
const ALONG_DRIVE = 1.3;
const ALONG_BRAKE = 1.15;

export function tractionLimit(c: Chassis, mu: number, accel: number, grade: number, v: number): number {
  const transfer = ((accel / G + grade) * c.cgHeight) / c.wheelbase; // share of the weight that moves back
  const share = c.rearDrive < 1 ? 1 : Math.min(c.bike ? 1 : 0.9, Math.max(0.25, 1 - c.front + transfer));
  const load = (c.massKg * G) / Math.sqrt(1 + grade * grade) + c.downforce * v * v;
  const grip = mu * ALONG_DRIVE * load * share;
  return c.bike ? Math.min(grip, (c.massKg * G * c.wheelbase * c.front) / c.cgHeight) : grip;
}

/** The most braking force the tyres can take before they lock, N (a bike's rear lifts first). */
export function brakeLimit(c: Chassis, mu: number, v: number): number {
  const grip = mu * ALONG_BRAKE * (c.massKg * G + c.downforce * v * v);
  return c.bike ? Math.min(grip, (c.massKg * G * c.wheelbase * (1 - c.front)) / c.cgHeight) : grip;
}

/** The car's motion in its own frame, carried from frame to frame. */
export interface Motion {
  /** Sideways speed at the centre of mass, m/s (+ right). */
  vy: number;
  /** Yaw rate, rad/s (+ turning right). */
  r: number;
  /** Front wheels' steering angle, rad (+ right). */
  delta: number;
  /**
   * Out: the force the tyres are taking out of the car's speed, N. Cornering hard costs speed
   * (the front tyres' grip leans back against the motion), a slide much more, and so does the
   * stability control braking wheels to straighten the car.
   */
  scrub?: number;
  /** Out: stability control stepped in this step. */
  esc?: boolean;
}

export interface Controls {
  /** Forward speed, m/s (the engine simulation's). */
  vx: number;
  /** Driver's steering, -1 full left .. 1 full right. */
  steer: number;
  /** How hard the car is speeding up (+) or slowing (-), m/s²: weight moves with it, and it spends grip. */
  accel: number;
  /** Grip under the tyres (surface and tyres together): about 1 for a road car on dry tarmac. */
  mu: number;
  /** Driver aids in use (default: the car's own). */
  aids?: Aids;
  /** The brakes have locked the wheels: a sliding tyre barely steers. */
  locked?: boolean;
  /** The driven wheels are spinning, 0-1. */
  wheelspin?: number;
}

/** How far the wheel can be turned at a speed: lots when parking, a little at speed (like a real rack's feel). */
export const steerLock = (vx: number) => Math.min(0.55, Math.max(0.055, 0.55 / (1 + Math.max(0, vx) / 6)));

/** Cornering stiffness per unit of load, 1/rad: how quickly a tyre builds force as it slips. */
const STIFFNESS = 24;
/** Shape of the tyre curve past its peak: a sliding tyre keeps ~80% of its peak grip. */
const SHAPE = 1.4;
/** B·α at the peak of that curve. */
const PEAK_BA = Math.tan(Math.PI / (2 * SHAPE));

/**
 * A tyre's sideways force at a slip angle (the "magic formula"): it rises steeply, peaks at
 * a few degrees of slip, then falls away as the tyre slides. So there's a best slip angle,
 * and a car pushed past it slides with less grip than it had: understeer if it's the front,
 * a spin starting if it's the rear.
 */
export function tyreForce(alpha: number, load: number, peak: number): number {
  if (peak < 1) return 0;
  const B = (STIFFNESS * load) / (SHAPE * peak);
  return -peak * Math.sin(SHAPE * Math.atan(B * alpha));
}

/**
 * One step of a dynamic bicycle model, on the real car's tyres and weight.
 *
 * Each axle's grip comes from the weight on it, and weight moves: forward on the brakes (the
 * nose bites, the tail goes light: lift off or brake into a bend and the car tightens its line),
 * back under power. Accelerating spends the driven wheels' grip, so a rear-drive car can be
 * powered sideways, and spinning wheels spend nearly all of it. Let go of the wheel and it
 * self-centres the way the front is travelling (caster), which is how a slide is caught.
 *
 * The aids are the car's own: stability control reins in a car rotating more than it's
 * steered (and costs some speed doing it); traction control eases the power as the rear slips.
 * Without them, as in an F40 or a '71 'Cuda, too much power or a lift mid-bend can spin it.
 *
 * Returns how hard the tyres are sliding, 0-1 (for smoke and sound).
 */
export function stepHandling(m: Motion, c: Chassis, u: Controls, dt: number): number {
  const vx = Math.max(0, u.vx);
  const aids = u.aids ?? c.aids;
  const L = c.wheelbase;
  const a = L * (1 - c.front); // centre of mass to front axle
  const b = L * c.front; // to rear axle
  const mass = c.massKg;
  const Iz = mass * a * b;
  const v0 = Math.max(vx, 0.5);

  // the wheel turns at a hand's pace (quicker back than out); let go and it self-centres along
  // the way the front wheels are travelling, which countersteers a slide by itself
  const lock = steerLock(vx);
  let target = u.steer * lock;
  const released = u.steer === 0 && vx > 4;
  if (released) target = Math.max(-0.55, Math.min(0.55, Math.atan2(m.vy + a * m.r, v0)));
  const out = Math.max(0.5, lock * 5);
  // (a free wheel spins round on its own, quicker than any hand)
  const rate = released ? 3 : Math.abs(target) < Math.abs(m.delta) || Math.sign(target) !== Math.sign(m.delta) ? out * 1.8 : out;
  m.delta += Math.max(-rate * dt, Math.min(rate * dt, target - m.delta));

  // weight on each axle: shifted by braking and power, pressed down by any wings
  const aero = c.downforce * vx * vx;
  const shift = (mass * Math.max(-1.5 * G, Math.min(1.2 * G, u.accel)) * c.cgHeight) / L;
  const fzF = Math.max(0.15 * mass * G * c.front, (mass * G * b) / L - shift + aero * c.front);
  const fzR = Math.max(0.15 * mass * G * (1 - c.front), (mass * G * a) / L + shift + aero * (1 - c.front));
  // two-wheelers lean on a wider contact and a rider's balance
  const grip = u.mu * (c.bike ? 1.1 : 1);
  // what each axle spends pushing the car along leaves it less for cornering (the friction circle);
  // a spinning wheel has spent nearly all of it
  const drive = Math.max(0, u.accel) * mass;
  const brake = Math.max(0, -u.accel) * mass;
  const spin = u.wheelspin ?? 0;
  const pushCap = aids.tc ? 0.8 : 0.93;
  // the brakes share out by the weight on each axle (a touch more at the front, for stability)
  const brakeF = Math.min(1, fzF / (fzF + fzR) + 0.05);
  const pushR0 = Math.min(pushCap, (drive * c.rearDrive + brake * (1 - brakeF)) / Math.max(1, grip * fzR) + spin * (c.rearDrive === 1 ? 0.6 : 0.4));
  const pushF = Math.min(pushCap, (drive * (1 - c.rearDrive) + brake * brakeF) / Math.max(1, grip * fzF) + spin * (1 - c.rearDrive) * 0.6);
  // a locked wheel slides, and a sliding tyre hardly steers; road cars are set up to run wide
  // at the limit rather than spin, so the front gives up a little first
  const lockLoss = u.locked ? 0.3 : 1;
  const maxF = grip * 0.97 * fzF * Math.sqrt(1 - pushF * pushF) * lockLoss;
  const balanceR = c.bike ? 1.1 : 1.03;

  let sliding = 0;
  let scrub = 0;
  m.esc = false;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const v = Math.max(vx, 0.5);
    const aF = Math.atan2(m.vy + a * m.r, v) - m.delta;
    const aR = Math.atan2(m.vy - b * m.r, v);
    // traction control: as the driven rear starts to slide, the drive is eased off it
    const tcEase = aids.tc ? 1 - Math.min(1, Math.max(0, (Math.abs(aR) - 0.05) / 0.08)) : 1;
    const pr = pushR0 * tcEase;
    const maxR = grip * balanceR * fzR * Math.sqrt(1 - pr * pr) * lockLoss;
    const fF = tyreForce(aF, fzF, maxF);
    const fR = tyreForce(aR, fzR, maxR);
    const cosD = Math.cos(m.delta);
    m.vy += ((fF * cosD + fR) / mass - vx * m.r) * h;
    m.r += ((a * fF * cosD - b * fR) / Iz) * h;
    // the front tyres' force leans back against the motion when they're turned, and a car
    // travelling sideways turns its speed into the slide
    let lost = fF * Math.sin(m.delta) - mass * m.vy * m.r;
    // stability control (or, on a bike, the rider): it never fights a car that turns less than
    // asked (that's just grip running out), only one rotating more than the wheel asks, by
    // braking a wheel or two, which costs speed
    if ((aids.esc || c.bike) && vx > 4) {
      const asked = Math.max(-grip * G / v, Math.min(grip * G / v, (vx * Math.tan(m.delta)) / L));
      const over = Math.sign(m.r) !== Math.sign(asked) ? Math.abs(m.r - asked) : Math.abs(m.r) - Math.abs(asked);
      if (over > 0.04) {
        const k = Math.min(1, (over - 0.04) / 0.15);
        m.r += (asked - m.r) * Math.min(1, k * 3.5 * h);
        lost += k * mass * G * 0.25;
        if (!c.bike && k > 0.15) m.esc = true;
      }
    }
    // the engine sets the speed along the car, so keep the slide within ~45 degrees and the yaw
    // within what grip could ever turn (a real spin stays a huge slide here, never a blow-up)
    const maxVy = vx + 0.3;
    if (Math.abs(m.vy) > maxVy) m.vy = Math.sign(m.vy) * maxVy;
    const rLimit = (grip * G * 2.2) / Math.max(v, 3) + 0.6;
    if (Math.abs(m.r) > rLimit) m.r = Math.sign(m.r) * rLimit;
    scrub += lost / steps;
    // how far the tyres are towards (or past) the slip angle where they grip best
    const peakF = (PEAK_BA * SHAPE * Math.max(1, maxF)) / (STIFFNESS * fzF);
    const peakR = (PEAK_BA * SHAPE * Math.max(1, maxR)) / (STIFFNESS * fzR);
    // (a front tyre pushed wide squeals more than it smokes; the rear sliding is what smokes)
    sliding = Math.max((Math.abs(aF) / peakF) * 0.6, Math.abs(aR) / peakR);
  }
  // slow: plain geometry, and nothing to slide on
  const w = Math.min(1, Math.max(0, (vx - 1) / 3));
  if (w < 1) {
    const rKin = (vx * Math.tan(m.delta)) / L;
    m.r = rKin + (m.r - rKin) * w;
    m.vy *= w;
    scrub *= w;
  }
  m.scrub = Math.max(-0.3 * mass * G, Math.min(1.5 * mass * G, scrub));
  return Math.min(1, Math.max(0, (sliding - 0.8) / 1.2));
}
