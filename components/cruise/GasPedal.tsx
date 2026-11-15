"use client";

import { useRef } from "react";
import type { InputManager } from "../../lib/input/InputManager";
import { useFrame } from "../useFrame";

/** Phone accelerator: a pedal you hold down for full throttle, like the brake beside it. Lights up for W too. */
export function GasPedal({ input, accent }: { input: InputManager; accent: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useFrame(() => {
    const on = input.levels().throttle > 0.01 ? "1" : "0";
    if (ref.current && ref.current.dataset.on !== on) ref.current.dataset.on = on;
  });
  const release = () => input.setTouchThrottle(0);
  return (
    <button
      ref={ref}
      type="button"
      data-on="0"
      aria-label="Accelerator (hold W or Up arrow)"
      className="gas-pedal touch-none select-none"
      style={{ "--accent": accent } as React.CSSProperties}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        input.setTouchThrottle(1);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e) => {
        if (e.code === "Enter") input.setTouchThrottle(1);
      }}
      onKeyUp={(e) => {
        if (e.code === "Enter") release();
      }}
    >
      <span className="gas-pedal-ribs" aria-hidden />
      <span className="gas-pedal-label">Gas</span>
    </button>
  );
}
