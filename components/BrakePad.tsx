"use client";

import { useRef } from "react";
import type { InputManager } from "../lib/input/InputManager";
import { useFrame } from "./useFrame";

/** Brake pad: hold to brake. Lights up whenever the brake is on, from touch or the keyboard (S / Down). */
export function BrakePad({ input }: { input: InputManager }) {
  const ref = useRef<HTMLButtonElement>(null);
  useFrame(() => {
    const on = input.levels().brake > 0 ? "1" : "0";
    if (ref.current && ref.current.dataset.on !== on) ref.current.dataset.on = on;
  });
  const release = () => input.setTouchBrake(false);
  return (
    <button
      ref={ref}
      type="button"
      data-on="0"
      aria-label="Brake (hold S or Down arrow)"
      className="brake-pad flex h-full min-h-10 w-full touch-none select-none flex-col items-center justify-center gap-1.5 rounded-2xl text-xs font-bold uppercase tracking-[0.25em] text-red-200/90"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        input.setTouchBrake(true);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e) => {
        if (e.code === "Enter") input.setTouchBrake(true);
      }}
      onKeyUp={(e) => {
        if (e.code === "Enter") release();
      }}
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6 opacity-70" aria-hidden>
        <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M5 5.5a9.5 9.5 0 000 13M19 5.5a9.5 9.5 0 010 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Brake
    </button>
  );
}
