"use client";

import { useEffect, useRef } from "react";
import { loadTrackTime } from "../lib/ui/trackTime";
import type { VehicleConfig } from "../lib/vehicles/types";
import type { SceneCar } from "./drag/scene";
import { DragScene25D } from "./drag/scene25d";

const STAGED: SceneCar["lights"] = { stage: true, ambers: [false, false, false, false], green: false, red: false, win: false };
/** The backdrop is scenery, not a game: half the frame rate is plenty, and kinder to batteries. */
const FRAME_MS = 1000 / 30;

/**
 * The drag strip as a living backdrop: two cars staged at the line, engines idling, the odd pop
 * from an exhaust, the crowd in the stands. Pauses when it's off screen or the tab is hidden,
 * and holds still for people who prefer reduced motion.
 */
export function StripBackdrop({ cars }: { cars: [VehicleConfig, VehicleConfig] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    const scene = new DragScene25D(ctx);
    scene.timeOfDay = loadTrackTime();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const flames = [0, 0];
    let raf = 0;
    let last = 0;
    let visible = true;

    const frame = (now: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 10 || h < 10) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      // now and then one of them blips its throttle and pops
      for (let i = 0; i < 2; i++) {
        flames[i] = Math.max(0, flames[i] - 0.06);
        if (!still && Math.random() < 0.006) flames[i] = 0.7 + Math.random() * 0.3;
      }
      const car = (cfg: VehicleConfig, i: number): SceneCar => ({ cfg, distM: 0, speedKmh: 0, rollBackM: 0, flame: flames[i], et: null, trapKmh: null, lights: STAGED });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.draw({ me: car(cars[0], 0), opp: car(cars[1], 1), time: now / 1000, shake: 0, crowd: 0.25 }, w, h);
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || now - last < FRAME_MS) return;
      last = now;
      try {
        frame(now);
      } catch (err) {
        console.error(err);
      }
    };
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);
    if (still) requestAnimationFrame((t) => frame(t));
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [cars]);

  return <canvas ref={ref} className="home-strip" aria-hidden />;
}
