"use client";

import dynamic from "next/dynamic";
import type { VehicleConfig } from "../lib/vehicles/types";
import type { Neighbour } from "./Simulator";

// The simulator touches AudioContext, canvas and requestAnimationFrame: client-only, no SSR.
const Simulator = dynamic(() => import("./Simulator"), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-zinc-400">Loading…</div>,
});

export function SimulatorLoader(props: { vehicle: VehicleConfig; prev: Neighbour; next: Neighbour; maxKmh: number }) {
  return <Simulator key={props.vehicle.id} {...props} />;
}
