"use client";

import { useEffect, useRef, useState } from "react";
import type { Simulation } from "../lib/sim/Simulation";
import { DISTANCE_SPLITS, RunTimer, SPEED_SPLITS, type SplitResult } from "../lib/track/runTimer";
import type { VehicleConfig } from "../lib/vehicles/types";
import type { SceneCar } from "./drag/scene";
import { DragScene25D } from "./drag/scene25d";

type Bests = Record<string, SplitResult> & { top?: { ms: 0; kmh: number } };

const LIGHTS_OFF: SceneCar["lights"] = { stage: false, ambers: [false, false, false, false], green: false, red: false, win: false };
/** The splits a phone shows without expanding the panel. */
const HEADLINE = new Set(["0-100", "1/4"]);
const GATES = DISTANCE_SPLITS.map((d) => ({ m: d.m, label: d.label.toUpperCase() }));

const loadBests = (id: string): Bests => {
  try {
    return JSON.parse(localStorage.getItem(`revheadz:pb:${id}`) ?? "{}") as Bests;
  } catch {
    return {};
  }
};
const saveBests = (id: string, b: Bests) => {
  try {
    localStorage.setItem(`revheadz:pb:${id}`, JSON.stringify(b));
  } catch {
    /* private mode */
  }
};
const secs = (ms: number | undefined) => (ms === undefined ? "–" : (ms / 1000).toFixed(ms < 10000 ? 3 : 2));

interface Panel {
  results: Record<string, SplitResult>;
  top: number;
  running: boolean;
  armed: boolean;
  fresh: string[];
}

/**
 * The proving ground: your car on an endless test road, drawn with the drag strip's 2.5D scene,
 * and every launch from a standstill timed like a road test. Best times are kept per car.
 */
export function TrackView({ sim, vehicle, subscribe }: { sim: Simulation; vehicle: VehicleConfig; subscribe: Simulation["subscribe"] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<{ speed: HTMLSpanElement | null; gear: HTMLSpanElement | null }>({ speed: null, gear: null });
  const [panel, setPanel] = useState<Panel>({ results: {}, top: 0, running: false, armed: true, fresh: [] });
  const [bests, setBests] = useState<Bests>({});
  // phones show the headline splits; the rest on request
  const [all, setAll] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from storage
    setBests(loadBests(vehicle.id));
  }, [vehicle.id]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    const scene = new DragScene25D(ctx, "proving");
    const timer = new RunTimer();
    let odo = 0;
    let flame = 0;
    let raf = 0;
    let last = performance.now();
    let maxDpr = window.matchMedia("(pointer: coarse)").matches ? 1.25 : 1.5;
    let frames = 0;
    let since = performance.now();
    let wasRunning = false;
    let wasArmed = true;
    let fresh: string[] = [];

    const off = subscribe((e) => {
      if (e.type === "shift" || e.type === "shiftCrack" || e.type === "backfire") flame = 1;
      else if (e.type === "crackle") flame = Math.max(flame, 0.6);
      else if (e.type === "limiter") flame = Math.max(flame, 0.45);
    });

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = sim.state;
      odo += (s.speedKmh / 3.6) * dt;
      flame = Math.max(0, flame - dt * 7);

      const done = timer.update(now / 1000, odo, s.speedKmh);
      if (done.length || timer.running !== wasRunning || timer.armed !== wasArmed) {
        if (timer.running && !wasRunning) fresh = [];
        // the run just ended: its top speed is settled now
        if (wasRunning && !timer.running) {
          const top = timer.topKmh;
          setBests((b) => {
            if ((b.top?.kmh ?? 0) >= top) return b;
            const next: Bests = { ...b, top: { ms: 0, kmh: top } };
            saveBests(vehicle.id, next);
            return next;
          });
        }
        fresh = [...fresh, ...done];
        wasRunning = timer.running;
        wasArmed = timer.armed;
        setPanel({ results: { ...timer.results }, top: timer.topKmh, running: timer.running, armed: timer.armed, fresh });
        // a finished split may be a personal best
        if (done.length) {
          setBests((b) => {
            const next: Bests = { ...b };
            let changed = false;
            for (const id of done) {
              const r = timer.results[id];
              if (!next[id] || r.ms < next[id].ms) {
                next[id] = r;
                changed = true;
              }
            }
            if (changed) saveBests(vehicle.id, next);
            return changed ? next : b;
          });
        }
      }
      // HUD numbers straight to the DOM (no React work per frame)
      const h = hudRef.current;
      if (h.speed) h.speed.textContent = String(Math.round(s.speedKmh));
      if (h.gear) h.gear.textContent = s.gear === 0 ? "N" : String(s.gear);

      const w = canvas.clientWidth;
      const ht = canvas.clientHeight;
      if (w > 10 && ht > 10) {
        frames++;
        if (now - since > 1000) {
          if (frames / ((now - since) / 1000) < 45 && maxDpr > 0.75) maxDpr = Math.max(0.75, maxDpr - 0.25);
          frames = 0;
          since = now;
        }
        const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(ht * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(ht * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        try {
          scene.draw(
            {
              me: { cfg: vehicle, distM: odo, speedKmh: s.speedKmh, rollBackM: 0, flame, et: null, trapKmh: null, lights: LIGHTS_OFF },
              opp: null,
              time: now / 1000,
              shake: Math.min(0.5, flame * 0.4),
              proving: { startX: timer.startX, gates: GATES },
            },
            w,
            ht,
          );
        } catch (err) {
          console.error(err);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
  }, [sim, vehicle, subscribe]);

  const row = (id: string, label: string, r: SplitResult | undefined, best: SplitResult | undefined, withSpeed = false) => {
    const isPb = Boolean(r && best && r.ms <= best.ms && panel.fresh.includes(id));
    return (
      <tr key={id} data-pb={isPb ? "1" : undefined} data-key={HEADLINE.has(id) ? "1" : undefined}>
        <th scope="row">{label}</th>
        <td>
          {secs(r?.ms)}
          {withSpeed && r?.kmh !== undefined && <small> {Math.round(r.kmh)}</small>}
        </td>
        <td className="track-best">
          {secs(best?.ms)}
          {withSpeed && best?.kmh !== undefined && <small> {Math.round(best.kmh)}</small>}
        </td>
      </tr>
    );
  };

  return (
    <div className="track-view">
      <canvas ref={canvasRef} className="track-canvas" aria-label="Proving ground" />
      <div className="track-hud" aria-hidden>
        <span className="track-speed" ref={(el) => void (hudRef.current.speed = el)}>
          0
        </span>
        <span className="track-unit">km/h</span>
        <span className="track-gear" ref={(el) => void (hudRef.current.gear = el)}>
          N
        </span>
      </div>
      <div className="track-panel" data-all={all ? "1" : undefined}>
        <p className="track-status">{panel.running ? "Timing" : panel.armed ? "Launch to start a timed run" : "Come to a stop to time a run"}</p>
        <table>
          <thead>
            <tr>
              <th />
              <th scope="col">Run</th>
              <th scope="col">Best</th>
            </tr>
          </thead>
          <tbody>
            {/* 0-300 only once this car has actually got there */}
            {SPEED_SPLITS.filter((s) => s.to < 300 || panel.results[s.id] || bests[s.id]).map((s) => row(s.id, s.label, panel.results[s.id], bests[s.id]))}
            {DISTANCE_SPLITS.map((d) => row(d.id, d.label, panel.results[d.id], bests[d.id], true))}
            <tr data-key="1">
              <th scope="row">Top speed</th>
              <td>{panel.top > 0 ? Math.round(panel.top) : "–"}</td>
              <td className="track-best">{bests.top ? Math.round(bests.top.kmh) : "–"}</td>
            </tr>
          </tbody>
        </table>
        <button type="button" className="track-more" onClick={() => setAll(!all)}>
          {all ? "Fewer splits" : "All splits"}
        </button>
      </div>
    </div>
  );
}
