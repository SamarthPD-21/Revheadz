"use client";

import { useEffect, useRef } from "react";

/** Runs `fn` every animation frame (for direct DOM updates that must not re-render React). */
export function useFrame(fn: (now: number) => void) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      ref.current(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}

/** Briefly marks an element as pressed (works for keyboard-triggered actions too). */
export function flash(el: HTMLElement | null, ms = 160) {
  if (!el) return;
  el.dataset.flash = "1";
  window.setTimeout(() => {
    if (el.dataset.flash === "1") delete el.dataset.flash;
  }, ms);
}
