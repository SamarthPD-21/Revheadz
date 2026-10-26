"use client";

import { useEffect, useRef } from "react";
import { useEngineState } from "../hooks/useEngineState";
import type { SimListener } from "../lib/sim/types";
import { flash } from "./useFrame";
import { pressHandlers } from "./press";
import type { LowFreqStore } from "../lib/sim/LowFreqStore";

interface Props {
  store: LowFreqStore;
  /** Must run synchronously in the tap handler: it creates/resumes the AudioContext. */
  onPress: () => void;
  pending: boolean;
  /** Simulation events, so the button reacts to the I key as well as taps. */
  subscribe: (fn: SimListener) => () => void;
  /** A small power button for the toolbar instead of the big push-button. */
  compact?: boolean;
}

/** Push-button start, like a modern car. */
export function IgnitionButton({ store, onPress, pending, subscribe, compact = false }: Props) {
  const { ignition } = useEngineState(store);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => subscribe((e) => (e.type === "start" || e.type === "stop") && flash(ref.current, 200)), [subscribe]);
  const running = ignition === "running";
  const busy = pending || ignition === "cranking";
  const label = running ? "Stop engine" : busy ? "Starting engine" : "Start engine";
  if (compact) {
    return (
      <button
        ref={ref}
        type="button"
        {...pressHandlers(onPress)}
        aria-label={`${label} (I)`}
        aria-pressed={running}
        title={`${label} (I)`}
        data-on={running ? "1" : busy ? "busy" : "0"}
        className="ignition ignition-mini grid h-9 w-9 shrink-0 touch-none select-none place-items-center rounded-full border transition active:scale-90"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
          <path d="M10 2.5v6.5M6 5.2a6 6 0 108 0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </button>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      {...pressHandlers(onPress)}
      aria-label={`${label} (I)`}
      aria-pressed={running}
      className={`ignition ${!running && !busy ? "ignition-idle" : ""} group relative grid aspect-square w-24 shrink-0 touch-none select-none place-items-center rounded-full border-4 outline-offset-4 transition sm:w-28 ${
        running
          ? "border-red-500/70 bg-gradient-to-b from-red-500 to-red-700 shadow-[0_0_30px_-4px_rgba(239,68,68,0.8)]"
          : "border-zinc-600 bg-gradient-to-b from-zinc-700 to-zinc-900 shadow-[0_0_24px_-8px_rgba(249,115,22,0.6)] hover:border-orange-400/70"
      } active:scale-95`}
    >
      <span className="flex flex-col items-center leading-none">
        <span className={`text-[10px] font-semibold tracking-[0.2em] ${running ? "text-red-100" : "text-zinc-400"}`}>ENGINE</span>
        <span className={`mt-1 text-sm font-black tracking-wider ${running ? "text-white" : busy ? "text-orange-300" : "text-orange-400"}`}>
          {running ? "STOP" : busy ? "…" : "START"}
        </span>
      </span>
    </button>
  );
}
