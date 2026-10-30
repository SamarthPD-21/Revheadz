import { specOf } from "../../lib/cruise/specs";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { carShape, type CarShape, type XY } from "../drag/scene25d";

/** The details that tell one car from another of the same shape. */
export interface Features {
  /** Rear wing: none, a ducktail lip, a swan-neck GT wing, or a tall rally/tuner wing. */
  wing: "none" | "lip" | "duck" | "gt" | "tall";
  /** On the bonnet: a scoop, a pair of vents, or nothing. */
  bonnet: "none" | "scoop" | "vents";
  /** Headlights: slim lenses, round lamps, or pop-ups folded flat. */
  lamps: "slim" | "round" | "popup";
  /** Taillights: a bar with clusters, or four round lamps. */
  tail: "bar" | "quad";
  /** Air intakes in the flanks ahead of the rear wheels (the mid-engined cars). */
  intakes: boolean;
  /** Where the pipes come out. */
  exhaust: "twin" | "centre" | "quad";
  /** Two racing stripes over the top. */
  stripes: boolean;
}

const BASE: Features = { wing: "none", bonnet: "none", lamps: "slim", tail: "bar", intakes: false, exhaust: "twin", stripes: false };

const FEATURES: Record<string, Partial<Features>> = {
  supra_mk4: { wing: "tall", tail: "quad", exhaust: "twin" },
  skyline_r34: { wing: "tall", tail: "quad", bonnet: "vents" },
  twin_turbo_v6: { wing: "lip", tail: "quad", exhaust: "quad", bonnet: "vents" },
  rx7_fd: { wing: "lip", lamps: "popup", tail: "bar" },
  honda_s2000: { exhaust: "twin" },
  subaru_sti: { wing: "tall", bonnet: "scoop" },
  jdm_i6_turbo: { wing: "lip" },
  synth_v6: { exhaust: "twin" },
  ferrari_f40: { wing: "gt", lamps: "popup", tail: "quad", intakes: true, exhaust: "centre" },
  lexus_lfa: { wing: "lip", intakes: false, exhaust: "centre" },
  porsche_gt3rs: { wing: "gt", lamps: "round", bonnet: "vents", exhaust: "centre" },
  v10_supercar: { wing: "duck", intakes: true, exhaust: "centre" },
  aventador_svj: { wing: "gt", intakes: true, exhaust: "centre", bonnet: "vents" },
  pagani_zonda: { wing: "duck", intakes: true, exhaust: "centre", lamps: "round" },
  bugatti_chiron: { wing: "duck", intakes: true, exhaust: "quad" },
  gt_racer: { wing: "lip", intakes: true, exhaust: "centre", tail: "quad" },
  audi_r8_v10: { wing: "lip", intakes: true, exhaust: "quad" },
  corvette_z06: { wing: "duck", intakes: true, exhaust: "quad" },
  mustang_gt: { wing: "lip", exhaust: "quad", stripes: true, bonnet: "vents" },
  hellcat: { wing: "lip", bonnet: "vents", exhaust: "twin", stripes: true },
  muscle_v8: { wing: "duck", bonnet: "scoop", lamps: "round", stripes: true },
  twin_turbo_i6: { wing: "lip", exhaust: "quad", bonnet: "vents" },
  bmw_m3_e46: { wing: "lip", exhaust: "quad" },
  amg_c63: { wing: "lip", exhaust: "quad", bonnet: "vents" },
  flat6_sports: { wing: "duck", lamps: "round", exhaust: "twin" },
  v12_gt: { wing: "lip", exhaust: "quad" },
  hot_hatch: { wing: "tall", exhaust: "centre" },
  boxer4_rally: { wing: "tall", bonnet: "scoop" },
  rotary_twin: { wing: "gt", intakes: true, exhaust: "centre" },
};

export const featuresOf = (cfg: VehicleConfig): Features => ({ ...BASE, ...FEATURES[cfg.id] });

/**
 * A car's own shape: its body style's profile stretched to the real car's length, height and
 * wheelbase (the overhangs keeping their share, the arches landing on the real wheel
 * centres), its real width, and its real wheel size.
 */
export function cruiseShape(cfg: VehicleConfig): CarShape {
  const base = carShape(cfg);
  const dims = specOf(cfg).dims;
  if (!dims || base.wheels.length < 2) return base;
  const [L, W, H, WB] = dims;
  const xs = base.wheels.map((w) => w.x);
  const rear = Math.min(...xs);
  const front = Math.max(...xs);
  const all = base.bodies.flat();
  const x0 = Math.min(...all.map((p) => p[0]));
  const x1 = Math.max(...all.map((p) => p[0]));
  // the overhangs share what's left of the length as they did on the base shape
  const overhang = Math.max(0.4, L - WB);
  const rearShare = (rear - x0) / Math.max(0.01, rear - x0 + (x1 - front));
  const newRear = overhang * rearShare;
  const newFront = newRear + WB;
  // piecewise linear along the car: tail, rear axle, front axle, nose
  const wx = (x: number) => {
    if (x <= rear) return ((x - x0) / Math.max(0.01, rear - x0)) * newRear;
    if (x <= front) return newRear + ((x - rear) / (front - rear)) * WB;
    return newFront + ((x - front) / Math.max(0.01, x1 - front)) * (L - newFront);
  };
  const r = cfg.gearbox.wheelRadiusM;
  const r0 = base.wheels[0].r;
  // heights: the wheel centres move to the real wheel's, the roof to the real height
  const wy = (y: number) => (y <= r0 ? (y / r0) * r : r + ((y - r0) / (base.height - r0)) * (H - r));
  const warp = (poly: XY[]): XY[] => poly.map(([x, y]) => [wx(x), wy(y)]);
  return {
    ...base,
    len: L,
    width: W,
    height: H,
    bodies: base.bodies.map(warp),
    windows: warp(base.windows),
    wings: base.wings.map(warp),
    wheels: base.wheels.map((w) => ({ x: wx(w.x), r })),
    wheelZ: [W / 2 - 0.27, W / 2 + 0.02],
    belt: wy(base.belt),
  };
}
