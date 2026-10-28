"use client";

import { useEffect, useRef, useState } from "react";
import { shiftLightRpm } from "../lib/drag/race";
import type { Tone } from "../lib/drag/rating";
import type { Simulation } from "../lib/sim/Simulation";
import { DISTANCE_SPLITS, RunTimer, SPEED_SPLITS, type SplitResult } from "../lib/track/runTimer";
import { ShiftLog, type LogEntry } from "../lib/track/shiftLog";
import type { VehicleConfig } from "../lib/vehicles/types";
import type { SceneCar } from "./drag/scene";
import { FrameBudget } from "./drag/frameBudget";
import { DragScene25D } from "./drag/scene25d";
import type { TimeOfDay } from "../lib/ui/trackTime";
import { BoostGauge } from "./BoostGauge";
import { ShiftLights } from "./ShiftLights";
import { Speedometer } from "./Speedometer";
import { Tachometer } from "./Tachometer";

type Bests = Record<string, SplitResult> & { top?: { ms: 0; kmh: number } };

const LIGHTS_OFF: SceneCar["lights"] = { stage: false, ambers: [false, false, false, false], green: false, red: false, win: false };
/** The splits a phone shows without expanding the panel. */
const HEADLINE = new Set(["0-100", "1/4"]);
const GATES = DISTANCE_SPLITS.map((d) => ({ m: d.m, label: d.label.toUpperCase() }));
/** Splits that go on the time slip (100-200 is a rolling split, not a step of the run). */
const SLIP_SPLITS = new Set(["0-100", "0-200", "0-300", ...DISTANCE_SPLITS.map((d) => d.id)]);
const LABELS: Record<string, string> = Object.fromEntries([...SPEED_SPLITS, ...DISTANCE_SPLITS].map((s) => [s.id, s.label]));
const LOG_KEY = "revheadz:shiftlog";

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

interface Pop {
  id: number;
  title: string;
  sub: string;
  tone: Tone;
}

/**
 * The playground's endless drag strip: your car drawn with the drag race's 2.5D scene, and every
 * launch from a standstill timed like a road test. Best times are kept per car, and the shift
 * log keeps a running time slip of the run with each upshift rated against the shift light.
 */
interface Props {
  sim: Simulation;
  vehicle: VehicleConfig;
  subscribe: Simulation["subscribe"];
  maxKmh: number;
  timeOfDay: TimeOfDay;
}

export function TrackView({ sim, vehicle, subscribe, maxKmh, timeOfDay }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // read by the draw loop every frame, so switching the time of day doesn't restart the scene
  const timeRef = useRef(timeOfDay);
  useEffect(() => {
    timeRef.current = timeOfDay;
  }, [timeOfDay]);
  const [panel, setPanel] = useState<Panel>({ results: {}, top: 0, running: false, armed: true, fresh: [] });
  const [bests, setBests] = useState<Bests>({});
  // the headline splits by default; the rest on request
  const [all, setAll] = useState(false);
  const [slip, setSlip] = useState<LogEntry[]>([]);
  const [pops, setPops] = useState<Pop[]>([]);
  const [logOn, setLogOn] = useState(true);
  const logOnRef = useRef(true);
  const [cue] = useState(() => shiftLightRpm(vehicle));

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time restore from storage */
    setBests(loadBests(vehicle.id));
    try {
      const on = localStorage.getItem(LOG_KEY) !== "0";
      setLogOn(on);
      logOnRef.current = on;
    } catch {
      /* private mode */
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [vehicle.id]);

  const toggleLog = () => {
    const on = !logOn;
    setLogOn(on);
    logOnRef.current = on;
    if (!on) setPops([]);
    try {
      localStorage.setItem(LOG_KEY, on ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    const scene = new DragScene25D(ctx, "proving");
    const timer = new RunTimer();
    const log = new ShiftLog(cue);
    let odo = 0;
    let flame = 0;
    let raf = 0;
    let last = performance.now();
    const budget = new FrameBudget();
    let wasRunning = false;
    let wasArmed = true;
    let fresh: string[] = [];
    let popId = 0;
    const timers = new Set<number>();

    const pop = (p: Omit<Pop, "id">) => {
      if (!logOnRef.current) return;
      const id = ++popId;
      setPops((ps) => [...ps.slice(-2), { ...p, id }]);
      timers.add(window.setTimeout(() => setPops((ps) => ps.filter((q) => q.id !== id)), 1700));
    };

    const off = subscribe((e) => {
      if (e.type === "shift" || e.type === "shiftCrack" || e.type === "backfire") flame = 1;
      else if (e.type === "crackle") flame = Math.max(flame, 0.6);
      else if (e.type === "limiter") flame = Math.max(flame, 0.45);
      if (e.type === "shift" && timer.running) {
        // the sim has already put the new gear in when it reports the shift
        const entry = log.shift(performance.now() / 1000, sim.state.gear);
        setSlip([...log.entries]);
        if (entry.rating && entry.tone) pop({ title: `${entry.rating} shift`, sub: entry.note ?? "", tone: entry.tone });
      }
    });

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = sim.state;
      odo += (s.speedKmh / 3.6) * dt;
      flame = Math.max(0, flame - dt * 7);

      const done = timer.update(now / 1000, odo, s.speedKmh);
      if (timer.running) {
        if (!wasRunning) log.start(timer.startT, s.gear);
        log.sample(now / 1000, s.rpm, s.gear);
      }
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
        for (const id of done) {
          if (!SLIP_SPLITS.has(id)) continue;
          const r = timer.results[id];
          log.split(r.ms, LABELS[id], r.kmh === undefined ? undefined : `${Math.round(r.kmh)} km/h`);
          if (id === "1/4") pop({ title: `${secs(r.ms)} s`, sub: `1/4 mile at ${Math.round(r.kmh ?? 0)} km/h`, tone: "good" });
        }
        fresh = [...fresh, ...done];
        wasRunning = timer.running;
        wasArmed = timer.armed;
        setPanel({ results: { ...timer.results }, top: timer.topKmh, running: timer.running, armed: timer.armed, fresh });
        if (timer.running) setSlip([...log.entries]);
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
      const w = canvas.clientWidth;
      const ht = canvas.clientHeight;
      if (w > 10 && ht > 10) {
        const dpr = budget.tick(now);
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(ht * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(ht * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        scene.timeOfDay = timeRef.current;
        try {
          scene.draw(
            {
              me: { cfg: vehicle, distM: odo, speedKmh: s.speedKmh, rollBackM: 0, flame, et: null, trapKmh: null, lights: LIGHTS_OFF },
              opp: null,
              time: now / 1000,
              shake: Math.min(0.5, flame * 0.4),
              proving: { startX: timer.startX, gates: GATES },
              // the stands come alive for a launch, then settle as the run goes on
              crowd: timer.running ? Math.max(0.15, 0.8 - (now / 1000 - timer.startT) / 4) : 0.15,
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
      for (const t of timers) clearTimeout(t);
    };
  }, [sim, vehicle, subscribe, cue]);

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
      <canvas ref={canvasRef} className="track-canvas" aria-label="Drag strip" />

      {logOn && slip.length > 0 && (
        <ol className="track-slip" aria-label="Time slip">
          {slip.slice(-12).map((e, i) => (
            <li key={`${e.ms}-${e.what}-${i}`} data-tone={e.tone}>
              <span className="track-slip-t">{(e.ms / 1000).toFixed(3)}</span>
              <span className="track-slip-what">{e.what}</span>
              {(e.rating || e.note) && <span className="track-slip-note">{[e.rating, e.note].filter(Boolean).join(" ")}</span>}
            </li>
          ))}
        </ol>
      )}

      <div className="drag-popups track-pops" aria-live="polite">
        {pops.map((p) => (
          <div key={p.id} className={`drag-popup drag-popup-${p.tone}`}>
            <b>{p.title}</b>
            <span>{p.sub}</span>
          </div>
        ))}
      </div>

      {/* the gauge cluster in the bottom corner: shift lights over the rev counter, a smaller boost gauge and the speedometer */}
      <div className="track-cluster">
        <div className="track-lights">
          <ShiftLights state={sim.state} redlineRpm={vehicle.engine.redlineRpm} shiftRpm={cue} />
        </div>
        <div className="track-dials">
          <div className="track-gauge">
            <Tachometer state={sim.state} redlineRpm={vehicle.engine.redlineRpm} limiterRpm={vehicle.engine.limiterRpm} accent={vehicle.ui.accent} subscribe={subscribe} />
          </div>
          <div className="track-gauge track-boost">
            <BoostGauge state={sim.state} redlineRpm={vehicle.engine.redlineRpm} turbo={Boolean(vehicle.turbo)} accent={vehicle.ui.accent} />
          </div>
          <div className="track-gauge">
            <Speedometer state={sim.state} accent={vehicle.ui.accent} maxKmh={maxKmh} />
          </div>
        </div>
      </div>

      <div className="track-panel" data-all={all ? "1" : undefined}>
        <p className="track-status" data-on={panel.running ? "1" : undefined}>
          {panel.running ? "Timing" : panel.armed ? "Launch to time a run" : "Stop to time a run"}
        </p>
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
        <div className="track-panel-foot">
          <button type="button" className="track-more" onClick={() => setAll(!all)}>
            {all ? "Fewer splits" : "All splits"}
          </button>
          <button type="button" className="track-toggle" aria-pressed={logOn} onClick={toggleLog} title="A time slip of every shift and split, with each shift rated against the shift light">
            Shift log
          </button>
        </div>
      </div>
    </div>
  );
}
