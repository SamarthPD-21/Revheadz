"use client";

import { useRef } from "react";
import type { SimState } from "../lib/sim/types";
import { COLORS, smooth } from "./gaugeDraw";
import { useCanvasLoop } from "./useCanvasLoop";

/**
 * Vertical bars for throttle, brake and (if fitted) turbo boost. They light up and glow
 * with the input, whether it comes from the keyboard or a touch control.
 */
const PAD = 36;

/** "#rrggbb" + alpha -> rgba() */
function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

export function Telemetry({ state, brake, turbo, accent }: { state: SimState; brake: () => number; turbo: boolean; accent: string }) {
  const shown = useRef({ thr: 0, brk: 0, boost: 0 });
  const ref = useCanvasLoop((ctx, w, h, dt) => {
    const s = shown.current;
    s.thr = smooth(s.thr, state.throttle, dt, 30);
    s.brk = smooth(s.brk, brake(), dt, 30);
    s.boost = smooth(s.boost, state.boost, dt, 15);
    const bars: [string, number, string][] = [
      ["THR", s.thr, "#22c55e"],
      ["BRK", s.brk, "#ef4444"],
    ];
    if (turbo) bars.push(["BST", s.boost, accent]);
    // the canvas bleeds PAD px past its slot on every side, so the aura can fade out fully
    const innerW = w - PAD * 2;
    const innerH = h - PAD * 2;
    const labelH = Math.min(14, innerH * 0.12);
    const spacing = innerW / bars.length;
    const barW = Math.min(18, spacing * 0.45);
    const top = PAD + 6;
    const bottom = PAD + innerH - labelH - 6;
    const fontPx = Math.max(7, Math.round(Math.min(labelH * 0.75, spacing * 0.28)));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    bars.forEach(([label, v, color], i) => {
      const x = PAD + spacing * i + spacing / 2 - barW / 2;
      const on = Math.min(1, Math.max(0, v));
      const lit = on > 0.02;

      // aura: a soft, feathered halo of light behind the bar (no outlines), stronger as you press
      if (lit) {
        const midY = bottom - ((bottom - top) * on) / 2;
        const halfH = Math.min(((bottom - top) * on) / 2 + barW * 1.6, (bottom - top) / 2 + PAD - 2);
        const radius = barW * 2.8;
        ctx.save();
        ctx.translate(x + barW / 2, midY);
        ctx.scale(1, halfH / radius);
        const aura = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        aura.addColorStop(0, withAlpha(color, 0.6 * (0.4 + 0.6 * on)));
        aura.addColorStop(0.4, withAlpha(color, 0.26 * (0.4 + 0.6 * on)));
        aura.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // track
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.roundRect(x, top, barW, bottom - top, barW / 2);
      ctx.fill();

      const fillH = (bottom - top) * on;
      if (fillH > 1) {
        const g = ctx.createLinearGradient(0, bottom - fillH, 0, bottom);
        g.addColorStop(0, withAlpha("#ffffff", 0.95));
        g.addColorStop(0.1, color);
        g.addColorStop(1, withAlpha(color, 0.85));
        ctx.save();
        ctx.fillStyle = g;
        ctx.shadowColor = withAlpha(color, 0.9);
        ctx.shadowBlur = 14 + 16 * on; // soft bloom, no hard edge
        ctx.beginPath();
        ctx.roundRect(x, bottom - fillH, barW, fillH, barW / 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.font = `${lit ? 800 : 700} ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = lit ? color : COLORS.dim;
      if (lit) {
        ctx.shadowColor = withAlpha(color, 0.8);
        ctx.shadowBlur = 10;
      }
      ctx.fillText(label, x + barW / 2, PAD + innerH - labelH / 2 - 2);
      ctx.restore();
    });
  });
  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute"
      style={{ inset: -PAD, width: `calc(100% + ${PAD * 2}px)`, height: `calc(100% + ${PAD * 2}px)` }}
      aria-hidden="true"
    />
  );
}
