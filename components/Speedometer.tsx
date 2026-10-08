"use client";

import { useRef } from "react";
import type { SimState } from "../lib/sim/types";
import { COLORS, angleFor, drawDial, drawNeedle, smooth } from "./gaugeDraw";
import { useCanvasLoop } from "./useCanvasLoop";

export function Speedometer({ state, accent, maxKmh }: { state: SimState; accent: string; maxKmh: number }) {
  const shown = useRef(0);
  const majorStep = maxKmh > 200 ? 40 : 20;

  const ref = useCanvasLoop((ctx, w, h, dt) => {
    shown.current = smooth(shown.current, state.speedKmh, dt, 20);
    const r = Math.min(w, h) / 2 - 2;
    const cx = w / 2;
    const cy = h / 2;
    drawDial(ctx, cx, cy, r, { max: maxKmh, value: shown.current, majorStep, labelDivisor: 1, minorPerMajor: 4, accent });
    drawNeedle(ctx, cx, cy, r, angleFor(shown.current, maxKmh));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLORS.label;
    ctx.font = `800 ${Math.round(r * 0.3)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(String(Math.round(shown.current)), cx, cy);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 ${Math.round(r * 0.085)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText("KM/H", cx, cy + r * 0.25);
  });

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" role="img" aria-label="Speedometer" />;
}
