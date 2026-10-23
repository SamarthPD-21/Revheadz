import type { GarageVehicle } from "../../components/GarageGrid";
import { vehicleBaseUrl, vehicles } from "./index";
import type { VehicleConfig } from "./types";

/** Idle loop plus the on-load loop nearest 75% of redline: enough for a quick rev on the card. */
function previewSounds(v: VehicleConfig): GarageVehicle["preview"] {
  const a = v.audio;
  if (a.mode !== "samples" || !a.idle || !a.onLoad?.length) return null;
  const want = v.engine.redlineRpm * 0.75;
  const rev = a.onLoad.reduce((best, l) => (Math.abs(l.rpm - want) < Math.abs(best.rpm - want) ? l : best));
  return { idle: `sounds/${a.idle.file}`, idleRpm: a.idle.rpm, rev: `sounds/${rev.file}`, revRpm: rev.rpm };
}

/** The serialisable card data for every vehicle, in garage order. */
export function garageList(): GarageVehicle[] {
  return vehicles.map((v) => ({
    id: v.id,
    name: v.name,
    type: v.type,
    description: v.description,
    engineType: v.engineType,
    category: v.ui.category,
    layout: v.ui.layout,
    displacement: v.ui.displacement,
    powerHp: v.ui.powerHp,
    redlineRpm: v.engine.redlineRpm,
    accent: v.ui.accent,
    silhouette: v.ui.silhouette,
    turbo: Boolean(v.turbo),
    recorded: Boolean(v.ui.recorded),
    make: v.ui.make,
    year: v.ui.year,
    base: vehicleBaseUrl(v.id),
    preview: previewSounds(v),
  }));
}
