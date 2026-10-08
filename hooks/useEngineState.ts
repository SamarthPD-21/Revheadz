"use client";

import { useSyncExternalStore } from "react";
import type { LowFreqState } from "../lib/sim/LowFreqStore";
import type { LowFreqStore } from "../lib/sim/LowFreqStore";

const SERVER_SNAPSHOT: LowFreqState = { gear: 0, ignition: "off" };

/** Subscribes React to slow state only (gear, ignition). RPM and speed never go through React. */
export function useEngineState(store: LowFreqStore): LowFreqState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => SERVER_SNAPSHOT);
}
