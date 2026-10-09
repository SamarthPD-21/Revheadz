"use client";

import { useEffect, useRef } from "react";
import type { SimListener, SimState } from "../lib/sim/types";
import { COLORS, angleFor, drawDial, drawNeedle, smooth } from "./gaugeDraw";
import { useCanvasLoop } from "./useCanvasLoop";

interface Props {
  /** Live simulation state, read every frame (never via React state). */
  state: SimState;
  redlineRpm: number;
  limiterRpm: number;
  accent: string;
  /** Simulation events: every limiter fuel cut flicks the needle. */
  subscribe: (fn: SimListener) => () => void;
}

/** Needle spring: natural frequency and damping of a real tacho needle (a quick flick with a small settle). */
const NEEDLE_HZ = 11;
const NEEDLE_DAMPING = 0.45;
const MAX_DIP = 500;

export function Tachometer({ state, redlineRpm, limiterRpm, accent, subscribe }: Props) {
  const shown = useRef(0);
  const clock = useRef(0);
  /** Needle offset below the engine rpm (o) and its velocity (v), driven by limiter cuts. */
  const spring = useRef({ o: 0, v: 0 });
  useEffect(
    () =>
      subscribe((e) => {
        // each fuel cut kicks the needle down; strength varies a little cut to cut
        if (e.type === "limiter") spring.current.v += 12000 * (0.75 + Math.random() * 0.5);
      }),
    [subscribe],
  );
  const max = Math.ceil((limiterRpm + 1) / 1000) * 1000;
  const majorStep = max > 12000 ? 2000 : 1000;

  const ref = useCanvasLoop((ctx, w, h, dt) => {
    clock.current += dt;
    const atLimiter = state.limiterActive || state.rpm >= limiterRpm - 300;
    // the needle follows the engine snappily near the limiter, so the real rev dips show
    shown.current = smooth(shown.current, state.rpm, dt, atLimiter ? 80 : 30);
    // spring-damper needle flick: o'' = -w^2 o - 2 z w o'
    const sp = spring.current;
    const w0 = 2 * Math.PI * NEEDLE_HZ;
    const steps = Math.max(1, Math.ceil(dt / 0.004));
    for (let i = 0; i < steps; i++) {
      const h = dt / steps;
      sp.v += (-w0 * w0 * sp.o - 2 * NEEDLE_DAMPING * w0 * sp.v) * h;
      sp.o += sp.v * h;
    }
    if (sp.o < -40) sp.o = -40; // a hair of overshoot past the limiter, like a real needle
    const raw = shown.current - sp.o;
    const needleRpm = Math.max(0, atLimiter ? Math.min(limiterRpm + 40, Math.max(limiterRpm - MAX_DIP, raw)) : raw);
    const r = Math.min(w, h) / 2 - 2;
    const cx = w / 2;
    const cy = h / 2;
    const pulse = state.limiterActive ? 1 : state.rpm > redlineRpm ? 0.5 + 0.5 * Math.sin(clock.current * 30) : 0;
    drawDial(ctx, cx, cy, r, {
      max,
      value: needleRpm,
      majorStep,
      labelDivisor: 1000,
      minorPerMajor: majorStep === 2000 ? 4 : 5,
      redFrom: redlineRpm,
      redPulse: pulse,
      accent,
    });
    drawNeedle(ctx, cx, cy, r, angleFor(needleRpm, max));

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
    ctx.fillText(String(Math.round(needleRpm)).padStart(4, " "), cx, cy + r * 0.42);
    ctx.fillStyle = COLORS.dim;
    ctx.font = `600 ${Math.round(r * 0.075)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText("RPM", cx, cy + r * 0.56);
  });

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" role="img" aria-label="Tachometer" />;
}
