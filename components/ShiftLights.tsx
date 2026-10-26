"use client";

import { useRef } from "react";
import type { SimState } from "../lib/sim/types";
import { useCanvasLoop } from "./useCanvasLoop";

const COUNT = 15;
const colorAt = (i: number) => (i < 6 ? "#22c55e" : i < 11 ? "#facc15" : "#ef4444");

/**
 * Race-style shift light strip: fills as the revs rise, flashes when it's time to shift (at
 * `shiftRpm` when given, the drag race's shift light; otherwise just short of the redline).
 */
export function ShiftLights({ state, redlineRpm, shiftRpm }: { state: SimState; redlineRpm: number; shiftRpm?: number }) {
  const clock = useRef(0);
  const ref = useCanvasLoop((ctx, w, h, dt) => {
    clock.current += dt;
    const full = shiftRpm ?? redlineRpm * 0.97;
    const start = full * 0.62;
    const fill = state.ignition === "running" ? (state.rpm - start) / (full - start) : 0;
    const lit = Math.round(Math.min(1, Math.max(0, fill)) * COUNT);
    const flash = fill >= 1 && Math.sin(clock.current * 30) > 0;
    const gap = Math.max(2, w * 0.008);
    const size = Math.min(h, (w - gap * (COUNT - 1)) / COUNT);
    const total = size * COUNT + gap * (COUNT - 1);
    let x = (w - total) / 2;
    for (let i = 0; i < COUNT; i++) {
      const on = fill >= 1 ? flash : i < lit;
      const c = fill >= 1 ? "#60a5fa" : colorAt(i);
      ctx.beginPath();
      ctx.arc(x + size / 2, h / 2, size * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = on ? c : "rgba(255,255,255,0.06)";
      ctx.shadowColor = c;
      ctx.shadowBlur = on ? size * 0.6 : 0;
      ctx.fill();
      x += size + gap;
    }
    ctx.shadowBlur = 0;
  });
  return <canvas ref={ref} className="h-full w-full" aria-hidden="true" />;
}
