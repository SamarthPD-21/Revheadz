"use client";

import { useRef } from "react";
import type { SimState } from "../lib/sim/types";
import { COLORS, smooth } from "./gaugeDraw";
import { useCanvasLoop } from "./useCanvasLoop";

/** Vertical bars for throttle, brake and (if fitted) turbo boost. */
export function Telemetry({ state, brake, turbo, accent }: { state: SimState; brake: () => number; turbo: boolean; accent: string }) {
  const shown = useRef({ thr: 0, brk: 0, boost: 0 });
  const ref = useCanvasLoop((ctx, w, h, dt) => {
    const s = shown.current;
    s.thr = smooth(s.thr, state.throttle, dt, 25);
    s.brk = smooth(s.brk, brake(), dt, 25);
    s.boost = smooth(s.boost, state.boost, dt, 15);
    const bars: [string, number, string][] = [
      ["THR", s.thr, "#22c55e"],
      ["BRK", s.brk, "#ef4444"],
    ];
    if (turbo) bars.push(["BST", s.boost, accent]);
    const labelH = Math.min(14, h * 0.12);
    const barW = Math.min(18, (w / bars.length) * 0.45);
    const spacing = w / bars.length;
    const top = 2;
    const bottom = h - labelH - 4;
    ctx.font = `700 ${Math.max(7, Math.round(Math.min(labelH * 0.75, spacing * 0.28)))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    bars.forEach(([label, v, color], i) => {
      const x = spacing * i + spacing / 2 - barW / 2;
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.roundRect(x, top, barW, bottom - top, barW / 2);
      ctx.fill();
      const fillH = (bottom - top) * Math.min(1, Math.max(0, v));
      if (fillH > 1) {
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.roundRect(x, bottom - fillH, barW, fillH, barW / 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(label, x + barW / 2, h - labelH / 2 - 1);
    });
  });
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
}
