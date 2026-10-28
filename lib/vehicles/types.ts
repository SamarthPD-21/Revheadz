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
 * manual: H-pattern with a clutch pedal: clutch in, lift, clutch out (drive fully cut, long engagement slip).
 * dct: dual-clutch: the next gear's clutch takes over as the last lets go, so drive keeps flowing
 *   through the shift; ignition-cut "crack" on loaded upshifts.
 * amt: single-clutch automated manual (Lamborghini ISR, Lexus ASG, BMW SMG): an actuator does
 *   what your left foot would, fast but with a full cut and a firm bite as the clutch closes.
 * sequential: dog-box race gearbox or a motorcycle with a quickshifter: a very short cut, no clutch.
 * auto: torque-converter automatic: the converter slips and multiplies torque pulling away,
 *   shifts are soft overlaps rather than cuts, and it kicks down when you floor it.
 */
export type GearboxType = "manual" | "dct" | "amt" | "sequential" | "auto";

export interface GearboxConfig {
  type?: GearboxType;
  /** The real unit, for the record (e.g. "ZF 8HP90", "Getrag V160"). */
  unit?: string;
  ratios: number[];
  /** Final drive. For a motorcycle: primary reduction x sprocket ratio, so ratio x finalDrive = crank / wheel revs. */
  finalDrive: number;
  wheelRadiusM: number;
  shiftTimeMs: number;
  /** Torque-converter autos: the engine speed the converter lets the engine reach at full throttle against a held car. */
  stallRpm?: number;
}

export interface TurboConfig {
  /**
   * What makes the boost (default "turbo"). A turbo whistles with boost and vents when you lift;
   * a supercharger is driven by the crank, so it whines in step with the revs and never vents.
   */
  kind?: "turbo" | "twin-screw" | "centrifugal";
  /** RPM where boost starts building. */
  spoolRpm: number;
  /** Seconds for boost to build/decay (lag). */
  lagS: number;
  /** Release sound when lifting off boost: blow-off valve "pssh" or compressor-surge "flutter". */
  release?: "pssh" | "flutter";
}

export type Silhouette = "muscle" | "coupe" | "supercar" | "gt" | "hatch" | "rally" | "sport" | "superbike" | "cruiser" | "gtcar" | "formula";

export interface UiConfig {
  accent: string;
  silhouette: Silhouette;
  category: string;
  layout: string;
  displacement: string;
  powerHp: number;
  /** Engine sounds come from real recordings (scripts/build-real-sounds.mjs). */
  recorded?: boolean;
  /** Real-world make, for named ("famous") vehicles. */
  make?: string;
  /** Model year or era shown on the card, e.g. "1998" or "2015-2020". */
  year?: string;
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
  /** For vehicles with real recordings: the engine-model sound set, offered as an alternative in the drive screen. */
  audioGenerated?: AudioConfig;
  credits: string[];
  /** Engine-model voice to borrow from another vehicle (scripts/generate-sounds.mjs). */
  voice?: string;
}
