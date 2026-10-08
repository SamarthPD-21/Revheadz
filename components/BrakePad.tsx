"use client";

import type { InputManager } from "../lib/input/InputManager";

export function BrakePad({ input }: { input: InputManager }) {
  const release = () => input.setTouchBrake(false);
  return (
    <button
      type="button"
      aria-label="Brake (hold S or Down arrow)"
      className="h-full min-h-10 w-full touch-none select-none rounded-2xl border border-red-400/25 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.05)_0_3px,transparent_3px_12px)] bg-red-950/40 text-xs font-bold uppercase tracking-[0.25em] text-red-200/90 transition active:scale-[0.98] active:bg-red-600/40"
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
