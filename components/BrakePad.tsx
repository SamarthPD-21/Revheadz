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
      className="brake-pad h-full min-h-10 w-full touch-none select-none rounded-2xl border border-red-400/25 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.05)_0_3px,transparent_3px_12px)] bg-red-950/40 text-xs font-bold uppercase tracking-[0.25em] text-red-200/90"
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
      Brake
    </button>
  );
}
