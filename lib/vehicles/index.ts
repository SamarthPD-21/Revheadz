import boxer4Rally from "../../public/vehicles/boxer4_rally/config.json";
import flat6Sports from "../../public/vehicles/flat6_sports/config.json";
import gpRacer from "../../public/vehicles/gp_racer/config.json";
import gtRacer from "../../public/vehicles/gt_racer/config.json";
import hotHatch from "../../public/vehicles/hot_hatch/config.json";
import jdmI6Turbo from "../../public/vehicles/jdm_i6_turbo/config.json";
import muscleV8 from "../../public/vehicles/muscle_v8/config.json";
import rotaryTwin from "../../public/vehicles/rotary_twin/config.json";
import twinTurboI6 from "../../public/vehicles/twin_turbo_i6/config.json";
import twinTurboV6 from "../../public/vehicles/twin_turbo_v6/config.json";
import superbikeI4 from "../../public/vehicles/superbike_i4/config.json";
import synthV6 from "../../public/vehicles/synth_v6/config.json";
import v10Supercar from "../../public/vehicles/v10_supercar/config.json";
import v12Gt from "../../public/vehicles/v12_gt/config.json";
import vtwinCruiser from "../../public/vehicles/vtwin_cruiser/config.json";
import type { AudioConfig, VehicleConfig } from "./types";
import { validateVehicle } from "./validate";

/** Garage order. Adding a vehicle = a new folder + one line here. */
const RAW = [
  gpRacer,
  gtRacer,
  muscleV8,
  jdmI6Turbo,
  twinTurboV6,
  twinTurboI6,
  flat6Sports,
  v10Supercar,
  v12Gt,
  hotHatch,
  boxer4Rally,
  rotaryTwin,
  superbikeI4,
  vtwinCruiser,
  synthV6,
] as unknown as VehicleConfig[];

export const vehicles: readonly VehicleConfig[] = RAW.map((v) => {
  const problems = validateVehicle(v);
  if (problems.length) throw new Error(`Invalid vehicle config "${v.id}":\n - ${problems.join("\n - ")}`);
  return v;
});

export function getVehicle(id: string): VehicleConfig | undefined {
  return vehicles.find((v) => v.id === id);
}

/** Folder (URL) the vehicle's files are served from. */
export function vehicleBaseUrl(id: string): string {
  return `/vehicles/${id}`;
}

/** Every sound file a config references (relative to its sounds/ folder). */
export function referencedSoundFiles(v: VehicleConfig, a: AudioConfig = v.audio): string[] {
  if (a.mode !== "samples") return [];
  const one = a.oneShots ?? {};
  return [
    ...(a.onLoad ?? []).map((s) => s.file),
    ...(a.offLoad ?? []).map((s) => s.file),
    ...(a.idle ? [a.idle.file] : []),
    ...(one.start ? [one.start] : []),
    ...(one.stop ? [one.stop] : []),
    ...(one.shift ?? []),
    ...(one.backfire ?? []),
    ...(one.blowoff ?? []),
  ];
}

/** A sensible full-scale value for the speedometer, from power vs drag and gearing. */
export function gaugeMaxKmh(v: VehicleConfig): number {
  const e = v.engine;
  const powerW = e.peakTorqueNm * e.redlineRpm * ((2 * Math.PI) / 60) * 0.75;
  const dragTop = Math.cbrt(powerW / (0.5 * 1.2 * v.dynamics.cdA)) * 3.6;
  const g = v.gearbox;
  const topRatio = g.ratios[g.ratios.length - 1] * g.finalDrive;
  const gearTop = ((e.redlineRpm / topRatio) * 2 * Math.PI * g.wheelRadiusM * 60) / 1000;
  const top = Math.min(dragTop * 0.95, gearTop);
  const step = top > 200 ? 40 : 20;
  return Math.ceil(top / step) * step;
}

/** Every sound file a vehicle ships, across its real and generated sets. */
export function allSoundFiles(v: VehicleConfig): string[] {
  return [...new Set([...referencedSoundFiles(v), ...(v.audioGenerated ? referencedSoundFiles(v, v.audioGenerated) : [])])];
}
