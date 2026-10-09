"use client";

import { useEffect, useRef } from "react";
import type { SimEvent, SimListener } from "../lib/sim/types";
import { pressHandlers } from "./press";
import { flash } from "./useFrame";

interface Props {
  onUp: () => void;
  onDown: () => void;
  onNeutral: () => void;
  /** Simulation events, so the paddles flash however the shift was made (touch or keyboard). */
  subscribe: (fn: SimListener) => () => void;
  gear: () => number;
}

const paddle =
  "ctl flex-1 touch-none select-none rounded-xl border border-white/15 bg-gradient-to-b from-zinc-700/80 to-zinc-900 py-3 text-lg font-black text-zinc-100 shadow-inner";

export function ShiftButtons({ onUp, onDown, onNeutral, subscribe, gear }: Props) {
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const neutral = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      subscribe((e: SimEvent) => {
        if (e.type !== "shift") return;
        flash(gear() === 0 ? neutral.current : e.direction === "up" ? up.current : down.current);
      }),
    [subscribe, gear],
  );

  return (
    <div className="flex gap-2" role="group" aria-label="Gear shift">
      <button ref={down} type="button" className={paddle} {...pressHandlers(onDown)} aria-label="Shift down (Q)">
        − <span className="text-[10px] font-semibold text-zinc-500 pointer-coarse:hidden">Q</span>
      </button>
      <button ref={neutral} type="button" className={`${paddle} max-w-14 text-base`} {...pressHandlers(onNeutral)} aria-label="Neutral (N)">
        N
      </button>
      <button ref={up} type="button" className={paddle} {...pressHandlers(onUp)} aria-label="Shift up (E)">
        + <span className="text-[10px] font-semibold text-zinc-500 pointer-coarse:hidden">E</span>
      </button>
    </div>
  );
}
