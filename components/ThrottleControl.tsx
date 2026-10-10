"use client";

import { useRef } from "react";
import type { InputManager } from "../lib/input/InputManager";
import { useFrame } from "./useFrame";

/**
 * Vertical throttle pedal that springs back to zero. Touch position maps straight to
 * throttle 0-1, and the pedal also shows keyboard throttle (W / Up / Space), so it always
 * reflects what the engine is getting.
 */
export function ThrottleControl({ input, accent }: { input: InputManager; accent: string }) {
  const track = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const pointerId = useRef<number | null>(null);
  const shown = useRef(-1);

  useFrame(() => {
    const v = input.levels().throttle;
    if (Math.abs(v - shown.current) < 0.005) return;
    shown.current = v;
    if (fill.current) fill.current.style.transform = `scaleY(${v})`;
    if (readout.current) readout.current.textContent = `${Math.round(v * 100)}%`;
    if (track.current) {
      track.current.setAttribute("aria-valuenow", String(Math.round(v * 100)));
      track.current.dataset.on = v > 0.01 ? "1" : "0";
    }
  });

  const fromEvent = (e: React.PointerEvent) => {
    const rect = track.current!.getBoundingClientRect();
    input.setTouchThrottle(1 - (e.clientY - rect.top) / rect.height);
  };

  const release = (e: React.PointerEvent) => {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    input.setTouchThrottle(0);
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
      data-on="0"
      className="pedal relative h-full min-h-16 w-full touch-none select-none overflow-hidden rounded-2xl"
      style={{ "--accent": accent } as React.CSSProperties}
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
        input.setTouchThrottle(0);
      }}
    >
      <div
        ref={fill}
        className="absolute inset-0 origin-bottom transition-transform duration-75 ease-out"
        style={{ transform: "scaleY(0)", background: `linear-gradient(to top, ${accent}, ${accent}bb 85%, ${accent}66)` }}
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
