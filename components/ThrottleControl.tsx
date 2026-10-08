"use client";

import { useRef } from "react";
import type { InputManager } from "../lib/input/InputManager";

/** Vertical touch/mouse throttle pedal that springs back to zero. Position maps straight to throttle 0-1. */
export function ThrottleControl({ input, accent }: { input: InputManager; accent: string }) {
  const track = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const pointerId = useRef<number | null>(null);

  const set = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    input.setTouchThrottle(c);
    if (fill.current) fill.current.style.transform = `scaleY(${c})`;
    if (readout.current) readout.current.textContent = `${Math.round(c * 100)}%`;
    track.current?.setAttribute("aria-valuenow", String(Math.round(c * 100)));
  };

  const fromEvent = (e: React.PointerEvent) => {
    const rect = track.current!.getBoundingClientRect();
    set(1 - (e.clientY - rect.top) / rect.height);
  };

  const release = (e: React.PointerEvent) => {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    set(0);
  };

  return (
    <div
      ref={track}
      role="slider"
      aria-label="Throttle (hold W or Up arrow)"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      tabIndex={0}
      className="relative h-full min-h-16 w-full touch-none select-none overflow-hidden rounded-2xl border border-white/15 bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.04)_0_2px,transparent_2px_10px)] bg-zinc-900"
      onPointerDown={(e) => {
        if (pointerId.current !== null) return;
        pointerId.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        fromEvent(e);
      }}
      onPointerMove={(e) => {
        if (pointerId.current === e.pointerId) fromEvent(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={() => {
        pointerId.current = null;
        set(0);
      }}
    >
      <div
        ref={fill}
        className="absolute inset-0 origin-bottom scale-y-0"
        style={{ background: `linear-gradient(to top, ${accent}, ${accent}99)`, boxShadow: `0 0 24px ${accent}` }}
      />
      <span className="pointer-events-none absolute inset-x-0 top-2 text-center text-[10px] font-bold uppercase tracking-[0.2em] text-white/80">
        Gas
      </span>
      <span ref={readout} className="pointer-events-none absolute inset-x-0 bottom-2 text-center font-mono text-xs font-bold text-white/90">
        0%
      </span>
    </div>
  );
}
