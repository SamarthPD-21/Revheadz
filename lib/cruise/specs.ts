import type { RoadModel } from "../sim/types";
import type { VehicleConfig } from "../vehicles/types";

/**
 * The real cars, as their makers and road tests have them, for driving them on the open road:
 * the engine's power and torque curve, the weight, the aero, which wheels are driven, the grip
 * their tyres give on a skidpad and the driver aids they left the factory with. (The drag strip
 * keeps its own tuning; this is only for Cruise.)
 */
export interface Spec {
  /** Share of the weight on the front wheels (a 911's engine hangs out the back: 0.39). */
  front: number;
  /** Peak power, hp, and the rpm it comes at. */
  hp: number;
  hpRpm: number;
  /** Peak torque, Nm, and the rpm it arrives at (a turbo holds it on a plateau up to where power takes over). */
  nm: number;
  nmRpm: number;
  /** Kerb weight, kg (the driver is added). */
  kg: number;
  /** Drag coefficient times frontal area, m². */
  cdA: number;
  drive: "rwd" | "awd";
  /** Steady cornering grip on its own tyres, g (a skidpad figure). */
  g: number;
  /** Driver aids it was built with: anti-lock brakes, traction control, stability control. */
  abs: boolean;
  tc: boolean;
  esc: boolean;
  /** Road-test figures to hold the model to: 0-100 km/h, s, and top speed, km/h (unrestricted). */
  t100: number;
  vmax: number;
  /** An electronic top-speed limiter, km/h. */
  limitKmh?: number;
  /** Crank, flywheel and clutch inertia, kg·m² (light for race and bike engines). */
  crankI?: number;
}

const ALL = { abs: true, tc: true, esc: true };
const NONE = { abs: false, tc: false, esc: false };
const ABS = { abs: true, tc: false, esc: false };
const ABS_TC = { abs: true, tc: true, esc: false };
const TC = { abs: false, tc: true, esc: false };

export const SPECS: Record<string, Spec> = {
  supra_mk4: { front: 0.53, hp: 320, hpRpm: 5600, nm: 427, nmRpm: 4000, kg: 1570, cdA: 0.6, drive: "rwd", g: 0.95, ...ABS_TC, t100: 5.1, vmax: 285 },
  skyline_r34: { front: 0.55, hp: 276, hpRpm: 6800, nm: 392, nmRpm: 4400, kg: 1560, cdA: 0.68, drive: "awd", g: 0.97, ...ABS, t100: 5.0, vmax: 265 },
  twin_turbo_v6: { front: 0.54, hp: 545, hpRpm: 6400, nm: 632, nmRpm: 3200, kg: 1740, cdA: 0.6, drive: "awd", g: 1.0, ...ALL, t100: 3.2, vmax: 315 },
  rx7_fd: { front: 0.5, hp: 255, hpRpm: 6500, nm: 294, nmRpm: 5000, kg: 1280, cdA: 0.64, drive: "rwd", g: 0.92, ...ABS, t100: 5.3, vmax: 255 },
  honda_s2000: { front: 0.5, hp: 240, hpRpm: 8300, nm: 208, nmRpm: 7500, kg: 1250, cdA: 0.76, drive: "rwd", g: 0.92, ...ABS, t100: 5.9, vmax: 241 },
  subaru_sti: { front: 0.6, hp: 300, hpRpm: 6000, nm: 407, nmRpm: 4000, kg: 1500, cdA: 0.74, drive: "awd", g: 0.93, ...ABS, t100: 5.0, vmax: 255 },
  jdm_i6_turbo: { front: 0.53, hp: 276, hpRpm: 6200, nm: 378, nmRpm: 2400, kg: 1470, cdA: 0.76, drive: "rwd", g: 0.85, ...ABS, t100: 6.0, vmax: 245 },
  synth_v6: { front: 0.53, hp: 332, hpRpm: 7000, nm: 363, nmRpm: 5200, kg: 1500, cdA: 0.66, drive: "rwd", g: 0.97, ...ALL, t100: 5.3, vmax: 270 },
  ferrari_f40: { front: 0.42, hp: 471, hpRpm: 7000, nm: 577, nmRpm: 4000, kg: 1250, cdA: 0.61, drive: "rwd", g: 1.0, ...NONE, t100: 4.0, vmax: 324 },
  lexus_lfa: { front: 0.48, hp: 553, hpRpm: 8700, nm: 480, nmRpm: 6800, kg: 1580, cdA: 0.61, drive: "rwd", g: 1.02, ...ALL, t100: 3.7, vmax: 325, crankI: 0.12 },
  porsche_gt3rs: { front: 0.39, hp: 513, hpRpm: 8250, nm: 470, nmRpm: 6000, kg: 1430, cdA: 0.72, drive: "rwd", g: 1.18, ...ALL, t100: 3.2, vmax: 312, crankI: 0.13 },
  v10_supercar: { front: 0.42, hp: 603, hpRpm: 8000, nm: 590, nmRpm: 5750, kg: 1472, cdA: 0.74, drive: "rwd", g: 1.0, ...ABS_TC, t100: 3.9, vmax: 330, crankI: 0.12 },
  aventador_svj: { front: 0.43, hp: 759, hpRpm: 8500, nm: 720, nmRpm: 6750, kg: 1750, cdA: 0.78, drive: "awd", g: 1.25, ...ALL, t100: 2.8, vmax: 350 },
  pagani_zonda: { front: 0.47, hp: 594, hpRpm: 6150, nm: 760, nmRpm: 4000, kg: 1230, cdA: 0.7, drive: "rwd", g: 1.1, ...ABS_TC, t100: 3.6, vmax: 345 },
  bugatti_chiron: { front: 0.43, hp: 1479, hpRpm: 6700, nm: 1600, nmRpm: 2000, kg: 1995, cdA: 0.72, drive: "awd", g: 1.2, ...ALL, t100: 2.4, vmax: 420, limitKmh: 420 },
  gt_racer: { front: 0.42, hp: 562, hpRpm: 9000, nm: 540, nmRpm: 6000, kg: 1485, cdA: 0.66, drive: "rwd", g: 1.05, ...ALL, t100: 3.4, vmax: 325, crankI: 0.12 },
  audi_r8_v10: { front: 0.42, hp: 602, hpRpm: 8250, nm: 560, nmRpm: 6500, kg: 1555, cdA: 0.7, drive: "awd", g: 1.05, ...ALL, t100: 3.2, vmax: 330 },
  corvette_z06: { front: 0.4, hp: 670, hpRpm: 8400, nm: 623, nmRpm: 6300, kg: 1660, cdA: 0.9, drive: "rwd", g: 1.12, ...ALL, t100: 3.2, vmax: 312, crankI: 0.13 },
  mustang_gt: { front: 0.53, hp: 460, hpRpm: 7000, nm: 569, nmRpm: 4600, kg: 1750, cdA: 0.94, drive: "rwd", g: 0.97, ...ALL, t100: 4.6, vmax: 275 },
  hellcat: { front: 0.57, hp: 707, hpRpm: 6000, nm: 881, nmRpm: 4000, kg: 2000, cdA: 0.86, drive: "rwd", g: 0.97, ...ALL, t100: 4.2, vmax: 320 },
  // 1971: the period's gross figure is ~425 hp; on its bias-ply tyres it ran 0-100 in about 6 s
  muscle_v8: { front: 0.57, hp: 375, hpRpm: 5000, nm: 640, nmRpm: 4000, kg: 1700, cdA: 0.9, drive: "rwd", g: 0.75, ...NONE, t100: 6.0, vmax: 205 },
  twin_turbo_i6: { front: 0.52, hp: 431, hpRpm: 6250, nm: 550, nmRpm: 1850, kg: 1570, cdA: 0.75, drive: "rwd", g: 0.98, ...ALL, t100: 4.1, vmax: 285 },
  bmw_m3_e46: { front: 0.51, hp: 333, hpRpm: 7900, nm: 365, nmRpm: 4900, kg: 1570, cdA: 0.66, drive: "rwd", g: 0.9, ...ALL, t100: 5.2, vmax: 285 },
  amg_c63: { front: 0.54, hp: 457, hpRpm: 6800, nm: 600, nmRpm: 5000, kg: 1730, cdA: 0.7, drive: "rwd", g: 0.93, ...ALL, t100: 4.5, vmax: 300 },
  flat6_sports: { front: 0.4, hp: 201, hpRpm: 5900, nm: 267, nmRpm: 4300, kg: 1160, cdA: 0.69, drive: "rwd", g: 0.85, ...NONE, t100: 6.8, vmax: 235 },
  v12_gt: { front: 0.51, hp: 540, hpRpm: 6750, nm: 620, nmRpm: 5500, kg: 1785, cdA: 0.75, drive: "rwd", g: 0.95, ...ALL, t100: 4.5, vmax: 295 },
  hot_hatch: { front: 0.59, hp: 350, hpRpm: 6000, nm: 440, nmRpm: 2000, kg: 1550, cdA: 0.78, drive: "awd", g: 1.0, ...ALL, t100: 4.7, vmax: 266 },
  // the race cars: their weights already include the driver
  ferrari_f2004: { front: 0.45, hp: 900, hpRpm: 18300, nm: 360, nmRpm: 15500, kg: 530, cdA: 1.25, drive: "rwd", g: 1.4, ...TC, t100: 2.5, vmax: 315, crankI: 0.03 },
  gp_racer: { front: 0.45, hp: 750, hpRpm: 18500, nm: 300, nmRpm: 15500, kg: 530, cdA: 1.3, drive: "rwd", g: 1.4, ...TC, t100: 2.6, vmax: 300, crankI: 0.03 },
  rotary_twin: { front: 0.42, hp: 700, hpRpm: 9000, nm: 608, nmRpm: 6500, kg: 770, cdA: 0.85, drive: "rwd", g: 1.3, ...NONE, t100: 2.6, vmax: 338, crankI: 0.08 },
  boxer4_rally: { front: 0.52, hp: 300, hpRpm: 5500, nm: 600, nmRpm: 4000, kg: 1155, cdA: 0.9, drive: "awd", g: 1.0, ...NONE, t100: 3.2, vmax: 200, crankI: 0.08 },
  // the bikes: on full throttle they're held back by the front wheel lifting, not by grip
  panigale_v4: { front: 0.52, hp: 218, hpRpm: 15250, nm: 112, nmRpm: 11500, kg: 200, cdA: 0.32, drive: "rwd", g: 1.1, ...ALL, t100: 2.8, vmax: 315, crankI: 0.025 },
  ninja_h2: { front: 0.52, hp: 228, hpRpm: 11000, nm: 141, nmRpm: 10500, kg: 238, cdA: 0.35, drive: "rwd", g: 1.05, ...ALL, t100: 2.7, vmax: 320, crankI: 0.03 },
  superbike_i4: { front: 0.52, hp: 199, hpRpm: 13500, nm: 113, nmRpm: 10500, kg: 204, cdA: 0.33, drive: "rwd", g: 1.1, ...ALL, t100: 2.9, vmax: 300, crankI: 0.025 },
  vtwin_cruiser: { front: 0.45, hp: 95, hpRpm: 5000, nm: 155, nmRpm: 3000, kg: 370, cdA: 0.7, drive: "rwd", g: 0.85, ...ABS, t100: 5.2, vmax: 180, crankI: 0.06 },
};

/** The real car behind a garage vehicle, or a stand-in built from its own config. */
export function specOf(cfg: VehicleConfig): Spec {
  const known = SPECS[cfg.id];
  if (known) return known;
  const e = cfg.engine;
  return {
    front: 0.53,
    hp: cfg.ui.powerHp,
    hpRpm: e.redlineRpm * 0.92,
    nm: e.peakTorqueNm,
    nmRpm: e.redlineRpm * 0.62,
    kg: cfg.dynamics.massKg,
    cdA: cfg.dynamics.cdA,
    drive: "rwd",
    g: 0.95,
    ...ALL,
    t100: NaN,
    vmax: NaN,
  };
}

/**
 * The full-throttle torque curve through the spec's figures, Nm by rpm: from what it pulls
 * just off idle, up to peak torque (held flat on boost), over to the torque that gives peak
 * power, then tailing off to the limiter. A monotone cubic between those points, so it never
 * bulges past the figures it was drawn through.
 */
export function torqueCurve(spec: Spec, cfg: VehicleConfig): (rpm: number) => number {
  const { idleRpm, limiterRpm } = cfg.engine;
  const boosted = Boolean(cfg.turbo);
  const peakW = spec.hp * 745.7;
  const omega = (rpm: number) => (rpm * Math.PI) / 30;
  const nmRpm = Math.min(spec.nmRpm, spec.hpRpm - 200);
  // torque where power peaks: what gives that power at that rpm (never more than peak torque)
  const atPower = Math.min(spec.nm, peakW / omega(spec.hpRpm));
  const pts: [number, number][] = [[idleRpm, spec.nm * (boosted ? 0.42 : 0.6)]];
  if (nmRpm > idleRpm + 100) pts.push([nmRpm, spec.nm]);
  // a turbo (or a big engine) holds its peak torque until the power curve takes over
  const plateauEnd = peakW / omega(1) / spec.nm; // rpm where peak torque would reach peak power
  if (boosted && plateauEnd > nmRpm + 300 && plateauEnd < spec.hpRpm - 300) pts.push([plateauEnd * 0.94, spec.nm]);
  pts.push([spec.hpRpm, atPower]);
  // past peak power it tails off: about 9/10 of the power left at the limiter
  if (limiterRpm > spec.hpRpm + 100) pts.push([limiterRpm, Math.min(atPower, (0.9 * peakW) / omega(limiterRpm))]);
  const curve = monotone(pts);
  // and never more than the rated power anywhere
  return (rpm: number) => Math.min(curve(rpm), peakW / omega(Math.max(rpm, 1)));
}

/** Monotone cubic interpolation (Fritsch-Carlson) through points sorted by x; flat outside them. */
function monotone(pts: [number, number][]): (x: number) => number {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (n === 1) return () => ys[0];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** The road model the simulation drives with in Cruise: the real engine, weight, aero and drivetrain. */
export function roadModel(cfg: VehicleConfig): RoadModel {
  const spec = specOf(cfg);
  const bike = cfg.type === "bike";
  const race = ["ferrari_f2004", "gp_racer"].includes(cfg.id);
  const auto = cfg.gearbox.type === "auto";
  return {
    massKg: spec.kg + (race ? 0 : bike ? 80 : 75),
    cdA: spec.cdA,
    torque: torqueCurve(spec, cfg),
    // chain or short race drivetrains lose least; four driven wheels and a converter, most
    efficiency: bike ? 0.92 : race ? 0.92 : (spec.drive === "awd" ? 0.86 : 0.9) - (auto ? 0.03 : 0),
    engineInertia: spec.crankI ?? (bike ? 0.03 : 0.15),
    // all the wheels, tyres, brake discs and axles
    wheelInertia: bike ? 1.4 : race ? 3.2 : 5.5,
    // where it pulls: on boost for a turbo, well into the torque for the rest (never past 60% of the revs)
    // (strong enough to lock the wheels: the tyres set the stopping distance)
    brakeDecel: Math.max(cfg.dynamics.brakeDecel, (spec.g + 0.5) * 9.81),
    topKmh: spec.limitKmh,
    launchRpm: Math.min(cfg.engine.redlineRpm * 0.6, Math.max(cfg.engine.idleRpm * 2.5, spec.nmRpm * (cfg.turbo ? 1.1 : 0.75))),
  };
}
