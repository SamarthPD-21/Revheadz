"use client";

import { useRef } from "react";
import type { SimState } from "../lib/sim/types";
import { COLORS, angleFor, drawDial, drawNeedle, smooth } from "./gaugeDraw";
import { useCanvasLoop } from "./useCanvasLoop";

/** Boost at full spool, bar. */
const PEAK_BAR = 1;
/** Manifold vacuum with the throttle shut: idle, and deeper on the overrun at high revs, bar. */
const IDLE_VAC = -0.65;
const OVERRUN_VAC = -0.85;

/** "-0.5" → "-.5", "0.5" → ".5": short labels for a small dial. */
const short = (v: number) => (v === 0 ? "0" : String(+v.toFixed(2)).replace(/^(-?)0\./, "$1.").replace("-", "−"));

/**
 * Manifold pressure, like a real boost gauge: vacuum below zero with the throttle shut, boost
 * above it once the turbo or supercharger builds. Without one it's a vacuum gauge, reading near
 * zero at full throttle.
 */
export function BoostGauge({ state, redlineRpm, turbo, accent }: { state: SimState; redlineRpm: number; turbo: boolean; accent: string }) {
  const shown = useRef(0);
  const lo = -1;
  const hi = turbo ? 1.5 : 0;

  const ref = useCanvasLoop((ctx, w, h, dt) => {
    const s = state;
    const shut = 1 - Math.min(1, Math.max(0, s.throttle));
    const vac = IDLE_VAC + (OVERRUN_VAC - IDLE_VAC) * Math.min(1, s.rpm / redlineRpm);
    const bar = s.ignition === "running" ? vac * shut ** 1.4 + s.boost * PEAK_BAR : 0;
    shown.current = smooth(shown.current, bar, dt, 14);
    const v = shown.current;

    const r = Math.min(w, h) / 2 - Math.max(3, Math.min(w, h) * 0.04);
    const cx = w / 2;
    const cy = h / 2;
    const boosting = v > 0.02;
    drawDial(ctx, cx, cy, r, {
      min: lo,
      max: hi,
      value: v,
      arcFrom: 0,
      majorStep: turbo ? 0.5 : 0.25,
      labelDivisor: 1,
      minorPerMajor: 5,
      // the scale's two ends go unlabelled: the reading sits between them
      label: (t) => (t <= lo + 1e-6 || t >= hi - 1e-6 ? null : short(t)),
      accent: boosting ? accent : "rgba(148,163,184,0.75)",
    });
    drawNeedle(ctx, cx, cy, r, angleFor(v - lo, hi - lo));

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = boosting ? accent : COLORS.label;
    ctx.shadowColor = accent;
    ctx.shadowBlur = boosting ? r * 0.14 : 0;
    // the reading sits under the needle's pivot, clear of the scale (like the rev counter's rpm)
    const reading = Math.abs(v) < 0.005 ? "0.00" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
    ctx.font = `800 ${Math.round(r * 0.25)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(reading, cx, cy + r * 0.4);
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.dim;
    ctx.font = `700 ${Math.round(r * 0.11)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(turbo ? "BOOST" : "VACUUM", cx, cy + r * 0.62);
    ctx.font = `600 ${Math.round(r * 0.09)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText("BAR", cx, cy - r * 0.3);
    // a hub over the needle's root
    ctx.fillStyle = "#2a2a34";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.07, 0, Math.PI * 2);
    ctx.fill();
  });

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" role="img" aria-label={turbo ? "Boost gauge" : "Vacuum gauge"} />;
}
