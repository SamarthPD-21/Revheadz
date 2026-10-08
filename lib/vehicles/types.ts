export interface SampleRef {
  file: string;
  rpm: number;
}

export interface EngineConfig {
  cylinders: number;
  idleRpm: number;
  redlineRpm: number;
  limiterRpm: number;
  /** Seconds-ish: higher = slower to rev up and fall. */
  inertia: number;
  /** 0-1, how strongly the engine slows the car off-throttle. */
  engineBraking: number;
  peakTorqueNm: number;
  /** 0-1: how much the exhaust crackles and pops on the overrun. */
  crackle?: number;
}

/**
 * manual: clutch in, lift, clutch out (slow, long engagement slip).
 * dct: dual-clutch, near-seamless; ignition-cut "crack" on loaded upshifts.
 * sequential: motorcycle with quickshifter (upshift) and auto-blipper (downshift).
 */
export type GearboxType = "manual" | "dct" | "sequential";

export interface GearboxConfig {
  type?: GearboxType;
  ratios: number[];
  finalDrive: number;
  wheelRadiusM: number;
  shiftTimeMs: number;
}

export interface TurboConfig {
  /** RPM where boost starts building. */
  spoolRpm: number;
  /** Seconds for boost to build/decay (lag). */
  lagS: number;
}

export type Silhouette = "muscle" | "coupe" | "supercar" | "gt" | "hatch" | "rally" | "sport" | "superbike" | "cruiser";

export interface UiConfig {
  accent: string;
  silhouette: Silhouette;
  category: string;
  layout: string;
  displacement: string;
  powerHp: number;
  /** Engine sounds come from real recordings (scripts/build-real-sounds.mjs). */
  recorded?: boolean;
}

export interface DynamicsConfig {
  massKg: number;
  /** Drag area (Cd * frontal area), m^2. */
  cdA: number;
  /** Peak braking deceleration, m/s^2. */
  brakeDecel: number;
}

export interface SynthTone {
  /** Exhaust band-pass centre, Hz. */
  exhaustHz: number;
  /** Low-pass cutoff at full load, Hz. */
  cutoffHz: number;
  /** 0-1 random timing/amplitude jitter between firings. */
  roughness: number;
  /** 0-1 firing-order unevenness (cross-plane burble). */
  unevenness: number;
}

export interface OneShotsConfig {
  start?: string;
  stop?: string;
  shift?: string[];
  backfire?: string[];
  blowoff?: string[];
}

export interface AudioConfig {
  mode: "samples" | "synth";
  onLoad?: SampleRef[];
  offLoad?: SampleRef[];
  idle?: SampleRef;
  oneShots?: OneShotsConfig;
  synth?: SynthTone;
  masterGainDb: number;
}

export interface VehicleConfig {
  id: string;
  name: string;
  type: "car" | "bike";
  description: string;
  engineType: string;
  engine: EngineConfig;
  gearbox: GearboxConfig;
  dynamics: DynamicsConfig;
  turbo?: TurboConfig;
  ui: UiConfig;
  audio: AudioConfig;
  credits: string[];
}
