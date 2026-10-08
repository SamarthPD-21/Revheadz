"use client";

import { useEngineState } from "../hooks/useEngineState";
import type { LowFreqStore } from "../lib/sim/LowFreqStore";

interface Props {
  store: LowFreqStore;
  /** Must run synchronously in the tap handler: it creates/resumes the AudioContext. */
  onPress: () => void;
  pending: boolean;
}

/** Push-button start, like a modern car. */
export function IgnitionButton({ store, onPress, pending }: Props) {
  const { ignition } = useEngineState(store);
  const running = ignition === "running";
  const busy = pending || ignition === "cranking";
  const label = running ? "Stop engine" : busy ? "Starting engine" : "Start engine";
  return (
    <button
      type="button"
      onClick={onPress}
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
