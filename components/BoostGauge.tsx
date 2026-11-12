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

/**
 * "0.5" → ".5": short labels for a small dial. The vacuum side reads as an amount of vacuum,
 * the way a real gauge marks it, so no number on the dial is negative.
 */
const short = (v: number) => (v === 0 ? "0" : String(+Math.abs(v).toFixed(2)).replace(/^0\./, "."));

/**
 * Manifold pressure, like a real boost gauge: the needle sits left of zero in vacuum with the
 * throttle shut (the engine sucking the manifold below the air outside), and swings right into
 * boost once the turbo or supercharger builds. Without one it's a vacuum gauge, reading near zero
 * at full throttle. The reading says which it is (VACUUM or BOOST) and how much, rather than
 * showing vacuum as negative boost.
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
    if (r <= 0) return; // hidden (Cruise drops it on phones)
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
    const reading = Math.abs(v) < 0.005 ? "0.00" : Math.abs(v).toFixed(2);
    ctx.font = `800 ${Math.round(r * 0.25)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(reading, cx, cy + r * 0.4);
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.dim;
    ctx.font = `700 ${Math.round(r * 0.11)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(v > 0.005 ? "BOOST" : "VACUUM", cx, cy + r * 0.62);
    ctx.font = `600 ${Math.round(r * 0.09)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText("BAR", cx, cy - r * 0.3);
    // which side of zero is which, as a real gauge marks them
    ctx.font = `700 ${Math.round(r * 0.085)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(148,163,184,0.7)";
    const at = (value: number, rr: number) => {
      const a = angleFor(value - lo, hi - lo);
      return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr] as const;
    };
    const [vx, vy] = at(lo + (0 - lo) * 0.45, r * 0.5);
    ctx.fillText("VAC", vx, vy);
    if (turbo) {
      const [bx, by] = at(hi * 0.55, r * 0.5);
      ctx.fillText("BOOST", bx, by);
    }
    // a hub over the needle's root
    ctx.fillStyle = "#2a2a34";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.07, 0, Math.PI * 2);
    ctx.fill();
  });

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" role="img" aria-label={turbo ? "Boost gauge" : "Vacuum gauge"} />;
}
