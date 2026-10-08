"use client";

import { useEngineState } from "../hooks/useEngineState";
import type { LowFreqStore } from "../lib/sim/LowFreqStore";

/** Screen-reader announcement of gear changes (the gear is drawn visually in the tachometer). */
export function GearIndicator({ store }: { store: LowFreqStore }) {
  const { gear } = useEngineState(store);
  return (
    <span className="sr-only" aria-live="polite">
      {gear === 0 ? "Neutral" : `Gear ${gear}`}
    </span>
  );
}
