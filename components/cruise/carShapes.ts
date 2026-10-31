import { specOf } from "../../lib/cruise/specs";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { carShape, type CarShape, type XY } from "../drag/scene25d";

/** The details that tell one car from another of the same shape: its wings, scoops, lamps, intakes,
 * exhausts, stripes, and the grille, splitter, diffuser and trim that give it its face. */
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
  /** The nose's grille: slats, mesh, a Ferrari horse, BMW kidneys, a big mouth, an eggcrate, or an open intake. */
  grille: "none" | "slat" | "mesh" | "horse" | "kidney" | "big" | "eggcrate" | "intake";
  /** A lip under the nose, or a full front splitter wing. */
  splitter: "none" | "lip" | "wing";
  /** The rear diffuser: none, a single panel, or one with vertical fins. */
  diffuser: "none" | "single" | "fins";
  /** Small dive planes ahead of the front wheels (GT and race cars). */
  canards: boolean;
  /** An air scoop on the roof. */
  roofVent: boolean;
  /** Air strakes behind the doors (mid-engined and some turbo cars). */
  sideStrakes: boolean;
  /** Windscreen wipers across the glass. */
  wipers: boolean;
  /** Door handles on the flanks. */
  doorHandles: boolean;
  /** The fuel filler cap on a rear quarter panel. */
  fuelCap: boolean;
  /** Small side marker lights fore and aft on the flanks. */
  sideMarker: boolean;
  /** A thin aerial on the roof. */
  aerial: boolean;
  /** Make-and-model lettering on the tail. */
  badges: boolean;
  /** A roll cage visible through the glass (race cars). */
  rollCage: boolean;
  /** Darker, tinted glass (carbon and exotic cars). */
  tinted: boolean;
  /** Carbon fibre on the wing, splitter, diffuser and mirror caps (exotics and race cars). */
  carbon: boolean;
}

const BASE: Features = {
  wing: "none",
  bonnet: "none",
  lamps: "slim",
  tail: "bar",
  intakes: false,
  exhaust: "twin",
  stripes: false,
  grille: "slat",
  splitter: "none",
  diffuser: "none",
  canards: false,
  roofVent: false,
  sideStrakes: false,
  wipers: true,
  doorHandles: true,
  fuelCap: true,
  sideMarker: true,
  aerial: false,
  badges: true,
  rollCage: false,
  tinted: false,
  carbon: false,
};

const FEATURES: Record<string, Partial<Features>> = {
  supra_mk4: { wing: "tall", tail: "quad", exhaust: "twin", grille: "mesh", sideStrakes: true, badges: true },
  skyline_r34: { wing: "tall", tail: "quad", bonnet: "vents", grille: "big", sideStrakes: true, badges: true },
  twin_turbo_v6: { wing: "lip", tail: "quad", exhaust: "quad", bonnet: "vents", grille: "mesh", splitter: "lip", sideStrakes: true, roofVent: true, badges: true },
  rx7_fd: { wing: "lip", lamps: "popup", tail: "bar", grille: "intake", badges: true },
  honda_s2000: { exhaust: "twin", grille: "big", badges: true },
  subaru_sti: { wing: "tall", bonnet: "scoop", grille: "big", splitter: "lip", badges: true, aerial: true },
  jdm_i6_turbo: { wing: "lip", grille: "slat", badges: true },
  synth_v6: { exhaust: "twin", grille: "slat", badges: true },
  ferrari_f40: { wing: "gt", lamps: "popup", tail: "quad", intakes: true, exhaust: "centre", grille: "intake", splitter: "wing", diffuser: "fins", canards: true, tinted: true, carbon: true, badges: false },
  lexus_lfa: { wing: "lip", intakes: false, exhaust: "centre", grille: "intake", splitter: "wing", diffuser: "fins", roofVent: true, carbon: true, tinted: true, badges: true },
  porsche_gt3rs: { wing: "gt", lamps: "round", bonnet: "vents", exhaust: "centre", grille: "intake", splitter: "wing", diffuser: "fins", canards: true, sideStrakes: true, roofVent: true, carbon: true, tinted: true },
  v10_supercar: { wing: "duck", intakes: true, exhaust: "centre", grille: "slat", splitter: "lip", diffuser: "fins", carbon: true },
  aventador_svj: { wing: "gt", intakes: true, exhaust: "centre", bonnet: "vents", grille: "intake", splitter: "wing", diffuser: "fins", canards: true, sideStrakes: true, carbon: true, tinted: true },
  pagani_zonda: { wing: "duck", intakes: true, exhaust: "centre", lamps: "round", grille: "intake", splitter: "wing", diffuser: "fins", carbon: true },
  bugatti_chiron: { wing: "duck", intakes: true, exhaust: "quad", grille: "horse", splitter: "wing", diffuser: "fins", carbon: true },
  gt_racer: { wing: "lip", intakes: true, exhaust: "centre", tail: "quad", grille: "intake", splitter: "wing", diffuser: "fins", canards: true, roofVent: true, sideStrakes: true, rollCage: true, carbon: true, wipers: false, doorHandles: false, badges: false },
  audi_r8_v10: { wing: "lip", intakes: true, exhaust: "quad", grille: "slat", splitter: "lip", sideStrakes: true, carbon: true, tinted: true },
  corvette_z06: { wing: "duck", intakes: true, exhaust: "quad", grille: "big", splitter: "wing", diffuser: "fins", badges: true },
  mustang_gt: { wing: "lip", exhaust: "quad", stripes: true, bonnet: "vents", grille: "slat", splitter: "lip", badges: true },
  hellcat: { wing: "lip", bonnet: "vents", exhaust: "twin", stripes: true, grille: "eggcrate", splitter: "wing", badges: true, aerial: true },
  muscle_v8: { wing: "duck", bonnet: "scoop", lamps: "round", stripes: true, grille: "big", splitter: "lip", badges: true },
  twin_turbo_i6: { wing: "lip", exhaust: "quad", bonnet: "vents", grille: "kidney", splitter: "lip", sideStrakes: true, badges: true },
  bmw_m3_e46: { wing: "lip", exhaust: "quad", grille: "kidney", sideStrakes: true, badges: true },
  amg_c63: { wing: "lip", exhaust: "quad", bonnet: "vents", grille: "big", splitter: "lip", badges: true },
  flat6_sports: { wing: "duck", lamps: "round", exhaust: "twin", grille: "slat", badges: true },
  v12_gt: { wing: "lip", exhaust: "quad", grille: "slat", badges: true },
  hot_hatch: { wing: "tall", exhaust: "centre", grille: "slat", splitter: "lip", badges: true },
  boxer4_rally: { wing: "tall", bonnet: "scoop", grille: "intake", splitter: "wing", diffuser: "fins", rollCage: true, carbon: true, aerial: true, badges: true },
  rotary_twin: { wing: "gt", intakes: true, exhaust: "centre", grille: "intake", splitter: "wing", diffuser: "fins", canards: true, rollCage: true, carbon: true, wipers: false, doorHandles: false, badges: false },
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
