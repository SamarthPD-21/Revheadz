"use client";

import { useRef } from "react";
import type { SimState } from "../../lib/sim/types";
import { gearLabel } from "../gaugeDraw";
import { useFrame } from "../useFrame";

/** Phones: speed, gear and a thin rev bar instead of the dials. */
export function PhoneDash({ state, redlineRpm, accent }: { state: SimState; redlineRpm: number; accent: string }) {
  const speed = useRef<HTMLElement>(null);
  const gear = useRef<HTMLElement>(null);
  const revs = useRef<HTMLSpanElement>(null);
  const last = useRef({ kmh: -1, gear: "", rev: -1 });
  useFrame(() => {
    const kmh = Math.round(state.speedKmh);
    const g = gearLabel(state.gear);
    const rev = Math.round(Math.min(1, state.rpm / redlineRpm) * 100);
    const was = last.current;
    if (kmh !== was.kmh && speed.current) speed.current.textContent = String(kmh);
    if (g !== was.gear && gear.current) gear.current.textContent = g;
    if (rev !== was.rev && revs.current) {
      revs.current.style.transform = `scaleX(${rev / 100})`;
      revs.current.dataset.red = rev >= 92 ? "1" : "0";
    }
    last.current = { kmh, gear: g, rev };
  });
  return (
    <div className="phone-dash" style={{ "--accent": accent } as React.CSSProperties} aria-hidden>
      <b ref={gear} className="phone-dash-gear">
        N
      </b>
      <div className="phone-dash-speed">
        <b ref={speed}>0</b>
        <small>km/h</small>
      </div>
      <span className="phone-dash-revs">
        <span ref={revs} />
      </span>
    </div>
  );
}
