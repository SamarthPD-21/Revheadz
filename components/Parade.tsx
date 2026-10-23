"use client";

import { useEffect, useRef } from "react";

/** Speed multiplier while the pointer is over the card, and how quickly the speed eases (seconds). */
const HOVER_SPEED = 2.4;
const EASE_S = 0.45;

/**
 * The silhouettes drifting across the Playground card. The CSS animation runs at a constant
 * speed; hovering the card eases its playbackRate up (and back down on leave) so it speeds up
 * smoothly, instead of jumping as a changed animation-duration would.
 */
export function Parade({ children }: { children: React.ReactNode }) {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const card = track?.closest<HTMLElement>(".mode-card");
    const anim = track?.getAnimations?.()[0];
    if (!track || !card || !anim) return; // reduced motion: no animation to drive

    let target = 1;
    let rate = 1;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      rate += (target - rate) * (1 - Math.exp(-dt / (EASE_S / 3)));
      if (Math.abs(target - rate) < 0.005) rate = target;
      anim.playbackRate = rate;
      raf = rate === target ? 0 : requestAnimationFrame(tick);
    };
    const go = (to: number) => () => {
      target = to;
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(tick);
      }
    };
    const enter = go(HOVER_SPEED);
    const leave = go(1);
    card.addEventListener("pointerenter", enter);
    card.addEventListener("pointerleave", leave);
    card.addEventListener("focusin", enter);
    card.addEventListener("focusout", leave);
    return () => {
      cancelAnimationFrame(raf);
      card.removeEventListener("pointerenter", enter);
      card.removeEventListener("pointerleave", leave);
      card.removeEventListener("focusin", enter);
      card.removeEventListener("focusout", leave);
    };
  }, []);

  return (
    <div ref={trackRef} className="mode-parade-track">
      {children}
    </div>
  );
}
