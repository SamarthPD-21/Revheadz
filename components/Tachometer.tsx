"use client";

import { useRef } from "react";
import type { SimState } from "../lib/sim/types";
import { COLORS, angleFor, drawDial, drawNeedle, smooth } from "./gaugeDraw";
import { useCanvasLoop } from "./useCanvasLoop";

interface Props {
  /** Live simulation state, read every frame (never via React state). */
  state: SimState;
  redlineRpm: number;
  limiterRpm: number;
  accent: string;
}

export function Tachometer({ state, redlineRpm, limiterRpm, accent }: Props) {
  const shown = useRef(0);
  const clock = useRef(0);
  const max = Math.ceil((limiterRpm + 1) / 1000) * 1000;
  const majorStep = max > 12000 ? 2000 : 1000;

  const ref = useCanvasLoop((ctx, w, h, dt) => {
    clock.current += dt;
    shown.current = smooth(shown.current, state.rpm, dt, 30);
    const r = Math.min(w, h) / 2 - 2;
    const cx = w / 2;
    const cy = h / 2;
    const pulse = state.limiterActive || state.rpm > redlineRpm ? 0.5 + 0.5 * Math.sin(clock.current * 38) : 0;
    drawDial(ctx, cx, cy, r, {
      max,
      value: shown.current,
      majorStep,
      labelDivisor: 1000,
      minorPerMajor: majorStep === 2000 ? 4 : 5,
      redFrom: redlineRpm,
      redPulse: pulse,
      accent,
    });
    drawNeedle(ctx, cx, cy, r, angleFor(shown.current, max));

    // cluster centre: gear, rpm readout
    const s = state;
    const gear = s.gear === 0 ? "N" : String(s.gear);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = s.ignition === "running" ? accent : COLORS.dim;
    ctx.shadowColor = accent;
    ctx.shadowBlur = s.ignition === "running" ? r * 0.12 : 0;
    ctx.font = `800 ${Math.round(r * 0.42)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(gear, cx, cy - r * 0.02);
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.label;
    ctx.font = `700 ${Math.round(r * 0.13)}px ui-monospace, monospace`;
    ctx.fillText(String(Math.round(shown.current / 10) * 10).padStart(4, " "), cx, cy + r * 0.42);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 ${Math.round(r * 0.075)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText("RPM", cx, cy + r * 0.56);
  });

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" role="img" aria-label="Tachometer" />;
}
