import type { CameraMode, Graphics, Weather } from "./scene";
import { RANGES } from "./world";

/** Everything the cruise screen remembers between visits. */
export interface Settings {
  hour: number;
  /** Let the day go by: an hour every minute. */
  cycle: boolean;
  weather: Weather;
  camera: CameraMode;
  autopilot: boolean;
  /** Who changes gear: you (E / Q), or the car. */
  gears: "manual" | "auto";
  /** Off the road and anywhere on the map. */
  free: boolean;
  /** Frames a second to aim for ("max": as fast as the screen refreshes). */
  fps: "60" | "90" | "120" | "max";
  /** Driver aids: "as built" uses the car's own factory ABS / TC / ESC; otherwise the three are set separately below. */
  aidsAsBuilt: boolean;
  aids: { abs: boolean; tc: boolean; esc: boolean };

  // display and graphics
  /** Resolution: adapt to hold the frame rate, or a fixed share of the screen's (in %). */
  scale: "auto" | "50" | "75" | "100" | "150";
  /** How far out the world is built. */
  distance: keyof typeof RANGES;
  /** How thickly the land is planted. */
  vegetation: "low" | "medium" | "high";
  shadows: "off" | "on" | "high";
  /** Glow round lights at night and in the rain. */
  bloom: boolean;
  clouds: boolean;
  /** Field of view, degrees. */
  fov: number;
  /** Frames a second in the corner. */
  showFps: boolean;

  // sound, 0-1
  engineVolume: number;
  worldVolume: number;
}

export const DEFAULTS: Settings = {
  hour: 18.85,
  cycle: true,
  weather: "clear",
  camera: "chase",
  autopilot: false,
  gears: "auto",
  free: false,
  fps: "90",
  aidsAsBuilt: true,
  aids: { abs: true, tc: true, esc: true },
  scale: "auto",
  distance: "medium",
  vegetation: "high",
  shadows: "on",
  bloom: true,
  clouds: true,
  fov: 58,
  showFps: false,
  engineVolume: 0.8,
  worldVolume: 0.8,
};

type Quality = Pick<Settings, "distance" | "vegetation" | "shadows" | "bloom" | "clouds">;

/** One click for the lot, from easy on a laptop to everything out to the horizon. */
export const PRESETS: { id: string; label: string; title: string; q: Quality }[] = [
  { id: "low", label: "Low", title: "Near view, fewer trees, no shadows or glow: for older or battery-powered machines", q: { distance: "near", vegetation: "low", shadows: "off", bloom: false, clouds: true } },
  { id: "medium", label: "Medium", title: "The standard view", q: { distance: "medium", vegetation: "high", shadows: "on", bloom: true, clouds: true } },
  { id: "high", label: "High", title: "Further view and more trees out to it", q: { distance: "far", vegetation: "high", shadows: "on", bloom: true, clouds: true } },
  { id: "ultra", label: "Ultra", title: "Everything out to the horizon, with finer shadows: for a strong graphics card", q: { distance: "extreme", vegetation: "high", shadows: "high", bloom: true, clouds: true } },
];

/** The preset these settings match, if any. */
export function presetOf(s: Settings): string | null {
  const hit = PRESETS.find((p) => (Object.keys(p.q) as (keyof Quality)[]).every((k) => p.q[k] === s[k]));
  return hit?.id ?? null;
}

const DENSITY = { low: 0.45, medium: 0.7, high: 1 };

/** What the scene needs from the settings. */
export function graphicsOf(s: Settings): Graphics {
  return {
    scale: s.scale === "auto" ? "auto" : Number(s.scale) / 100,
    range: { ...RANGES[s.distance], density: DENSITY[s.vegetation] },
    shadows: s.shadows,
    bloom: s.bloom,
    clouds: s.clouds,
    fov: s.fov,
  };
}
