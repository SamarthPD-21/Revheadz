"use client";

import dynamic from "next/dynamic";
import type { VehicleConfig } from "../../lib/vehicles/types";
import type { PickerVehicle } from "../VehiclePicker";
import type { Neighbour } from "./CruiseView";

// WebGL, Web Audio and requestAnimationFrame: client-only, no SSR. three.js loads only here.
const CruiseView = dynamic(() => import("./CruiseView"), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-zinc-400">Loading…</div>,
});

export function CruiseLoader(props: { vehicle: VehicleConfig; prev: Neighbour; next: Neighbour; maxKmh: number; garage: PickerVehicle[] }) {
  return <CruiseView key={props.vehicle.id} {...props} />;
}
