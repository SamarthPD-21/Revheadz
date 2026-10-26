"use client";

import { useEffect, useRef, useState } from "react";
import type { AudioEngine } from "../../lib/audio/AudioEngine";
import { driveWithCpu, type CpuSkill } from "../../lib/drag/cpu";
import { rateLaunch, rateShift, type Tone } from "../../lib/drag/rating";
import { decide, DragRun, QUARTER_MILE_M, STAGE_MS, TREE_MS, type DriveKey, type DriveLog, type RunResult } from "../../lib/drag/race";
import type { SimListener, SimState } from "../../lib/sim/types";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { Silhouette } from "../Silhouette";
import { Tachometer } from "../Tachometer";
import type { SceneCar, SceneFrame } from "./scene";
import { FrameBudget } from "./frameBudget";
import { DragScene25D } from "./scene25d";
import type { Sfx } from "./sfx";

export interface Lane {
  name: string;
  cfg: VehicleConfig;
  /** Delay of this lane's green, ms (0 in heads-up racing). */
  offsetMs: number;
  /** Simple controls (gas held for you). */
  assist: boolean;
  /** A shared run replayed, not a live driver: the car is drawn as a ghost. */
  ghost?: boolean;
}

export type Opponent =
  | { kind: "cpu"; skill: CpuSkill }
  | { kind: "remote"; events: { current: [number, DriveKey][] }; log: { current: DriveLog | null } };

export interface RaceOutcome {
  myLog: DriveLog;
  myResult: RunResult;
  oppResult: RunResult | null;
}

interface Props {
  me: Lane;
  opp: Lane;
  /** performance.now() at which both lanes start staging (the VS intro plays before it). */
  startAt: number;
  opponent: Opponent;
  audio: AudioEngine;
  /** The other car's engine (quieter), if loaded. */
  oppAudio?: AudioEngine | null;
  sfx: Sfx;
  onInput?: (ms: number, key: DriveKey) => void;
  /** My run is over: send the log to the opponent. */
  onFinish?: (log: DriveLog) => void;
  onDone: (outcome: RaceOutcome) => void;
}

type Action = "gas" | "brake" | "up" | "down";
type Popup = { id: number; title: string; sub: string; tone: Tone; at: number };

const ROLL_IN_M = 7;
const STAGE_TOTAL = (offset: number) => STAGE_MS + TREE_MS + offset;
const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/** Tree state for one lane at `t` ms since that lane's green. */
function treeLights(t: number, launchMs: number | null, stageT: number, win: boolean) {
  const red = launchMs !== null && launchMs < 0 && t >= launchMs;
  return {
    stage: t >= stageT,
    // four ambers cascade through the countdown, then green (the last amber doubles as the red light)
    ambers: [0, 1, 2, 3].map((k) => t >= -TREE_MS + (k * TREE_MS) / 4 && t < 0 && !red),
    green: t >= 0 && !red,
    red,
    win,
  };
}

const keyAction = (code: string): Action | null =>
  code === "KeyW" || code === "ArrowUp"
    ? "gas"
    : code === "KeyS" || code === "ArrowDown"
      ? "brake"
      : code === "KeyE" || code === "Space" || code === "Enter" || code === "NumpadEnter" || code === "ArrowRight"
        ? "up"
        : code === "KeyQ" || code === "ArrowLeft"
          ? "down"
          : null;

export function RaceView({ me, opp, startAt, opponent, audio, oppAudio, sfx, onInput, onFinish, onDone }: Props) {
  const [, setFrame] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [touch] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);

  const myGreen = startAt + STAGE_TOTAL(me.offsetMs);
  const oppGreen = startAt + STAGE_TOTAL(opp.offsetMs);
  // the tree's stage bulbs come on once the car has rolled into the beams
  const stagedT = (offset: number) => -(STAGE_TOTAL(offset) - STAGE_MS * 0.75);

  // Mutable race objects, created once. The loop advances them; each render reads them.
  const [race] = useState(() => {
    const myRun = new DragRun(me.cfg, TREE_MS + me.offsetMs, { assist: me.assist });
    const tachListeners = new Set<SimListener>();
    const r = {
      myRun,
      oppRun: null as DragRun | null,
      oppEventCount: -1,
      log: { assist: me.assist, events: [] } as DriveLog,
      view: { ...myRun.sim.state } as SimState,
      tachListeners,
      held: new Set<Action>(),
      brakeHeld: false,
      flames: [0, 0] as [number, number],
      shake: 0,
      popups: [] as Popup[],
      popupId: 0,
      lastAmbers: 0,
      lastGreen: false,
      lastRed: false,
      lastStage: false,
      outcome: null as null | { word: string; text: string; sub: string; tone: "win" | "lose" | "tie"; at: number },
      done: false,
      skip: false,
      sentLog: false,
      now: startAt - 3000,
      subscribeTach: (fn: SimListener) => {
        tachListeners.add(fn);
        return () => {
          tachListeners.delete(fn);
        };
      },
      popup: (p: Omit<Popup, "id" | "at">) => {
        r.popups = [...r.popups.slice(-2), { ...p, id: ++r.popupId, at: performance.now() }];
      },
    };
    myRun.sim.subscribe((e) => {
      audio.handleEvent(e);
      tachListeners.forEach((l) => l(e));
      if (!myRun.launched) return;
      if (e.type === "shift") {
        r.flames[1] = 1;
        r.shake = Math.max(r.shake, 0.45);
        navigator.vibrate?.(14);
      }
      if (e.type === "shiftCrack" || e.type === "backfire") r.flames[1] = 1;
      if (e.type === "crackle") r.flames[1] = Math.max(r.flames[1], 0.6);
      if (e.type === "limiter") r.flames[1] = Math.max(r.flames[1], 0.45);
    });
    myRun.on((e) => {
      if (e.type === "launch") {
        const rt = myRun.launchMs ?? 0;
        r.shake = 1;
        r.popup({ ...rateLaunch(rt), sub: rt < 0 ? `${(-rt / 1000).toFixed(3)} s early` : `Reaction ${(rt / 1000).toFixed(3)} s` });
        navigator.vibrate?.(rt < 0 ? [60, 40, 60] : 25);
      } else if (e.type === "shift") {
        const ms = myRun.lastShiftMs;
        if (ms !== null) r.popup({ ...rateShift(ms), sub: ms < 0 ? "Before the light" : ms >= 900 ? "Missed: auto shift" : `+${Math.round(ms)} ms` });
      }
    });
    return r;
  });

  const latest = useRef({ onInput, onFinish, onDone, opponent, me, opp });
  useEffect(() => {
    latest.current = { onInput, onFinish, onDone, opponent, me, opp };
  });

  // the opponent's engine is only heard while racing,
  // and fires up during the VS intro, start sound and all
  useEffect(() => {
    oppAudio?.setVolume(0.38);
    oppAudio?.handleEvent({ type: "start" });
    return () => oppAudio?.setVolume(0);
  }, [oppAudio]);

  // ---- input: W gas, S brake (let go on green to launch), E / Space shift up, Q down ----
  useEffect(() => {
    const run = race.myRun;
    const emit = (at: number, key: DriveKey) => {
      if (run.finished) return;
      // launches and shifts only count once the cars are rolling into the beams
      if ((key === "launch" || key === "up" || key === "down") && at < startAt + STAGE_MS * 0.4) return;
      const ms = Math.max(at - myGreen, -STAGE_TOTAL(me.offsetMs));
      run.input(ms, key);
      race.log.events.push([ms, key]);
      latest.current.onInput?.(ms, key);
    };
    const act = (action: Action, down: boolean, at: number) => {
      if (me.assist) {
        // simple controls: one button launches and shifts; the gas is held for you
        if (down && (action === "up" || action === "gas")) emit(at, "up");
        if (down && action === "down") emit(at, "down");
        return;
      }
      if (action === "gas") emit(at, down ? "gas+" : "gas-");
      else if (action === "brake") {
        if (down) {
          race.brakeHeld = true;
          emit(at, "brake+");
        } else {
          emit(at, "brake-");
          // foot-brake launch: letting go of the brake is the launch
          if (race.brakeHeld && !run.launched && at >= startAt + STAGE_MS * 0.4) emit(at, "launch");
          race.brakeHeld = false;
        }
      } else if (down) emit(at, action);
    };
    const onKey = (e: KeyboardEvent) => {
      if (race.outcome && e.type === "keydown" && (e.code === "Space" || e.code === "Enter")) race.skip = true;
      const a = keyAction(e.code);
      if (!a) return;
      e.preventDefault();
      const down = e.type === "keydown";
      if (down && e.repeat) return;
      if (down) race.held.add(a);
      else race.held.delete(a);
      act(a, down, e.timeStamp);
    };
    const pads = new Map<number, Action>();
    const onPointerDown = (e: PointerEvent) => {
      if (race.outcome) race.skip = true;
      const el = (e.target as HTMLElement).closest?.("[data-pad]") as HTMLElement | null;
      if (!el) return;
      e.preventDefault();
      const a = el.dataset.pad as Action;
      pads.set(e.pointerId, a);
      race.held.add(a);
      act(a, true, e.timeStamp);
    };
    const onPointerUp = (e: PointerEvent) => {
      const a = pads.get(e.pointerId);
      if (!a) return;
      pads.delete(e.pointerId);
      race.held.delete(a);
      act(a, false, e.timeStamp);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("pointerdown", onPointerDown, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [race, startAt, myGreen, me.assist, me.offsetMs]);

  // ---- the frame loop: advance both runs, draw the strip, drive the sound ----
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    const s2 = new DragScene25D(ctx);
    const budget = new FrameBudget();
    const draw = (f: SceneFrame, w: number, h: number) => {
      const dpr = budget.tick(performance.now());
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      s2.draw(f, w, h);
    };
    const watchOpp = (r: DragRun) => {
      r.sim.subscribe((e) => {
        oppAudio?.handleEvent(e);
        if (!r.launched) return;
        if (e.type === "shift" || e.type === "shiftCrack" || e.type === "backfire") race.flames[0] = 1;
        if (e.type === "crackle") race.flames[0] = Math.max(race.flames[0], 0.6);
        if (e.type === "limiter") race.flames[0] = Math.max(race.flames[0], 0.45);
      });
    };
    let raf = 0;
    let frameNo = 0;
    let last = performance.now();
    const loop = () => {
      const { me, opp } = latest.current;
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      race.now = now;
      const run = race.myRun;
      run.advanceTo(now - myGreen);
      run.coastTo(now - myGreen);
      Object.assign(race.view, run.sim.state);
      audio.update(run.sim.state);

      // opponent: the CPU drives its own run; a remote player's run is rebuilt from their inputs
      const o = latest.current.opponent;
      if (o.kind === "cpu") {
        if (!race.oppRun) {
          race.oppRun = new DragRun(opp.cfg, TREE_MS + opp.offsetMs, { assist: true });
          driveWithCpu(race.oppRun, o.skill);
          watchOpp(race.oppRun);
        }
      } else {
        const events = o.log.current ? o.log.current.events : o.events.current;
        if (events.length !== race.oppEventCount || !race.oppRun) {
          race.oppEventCount = events.length;
          const r = new DragRun(opp.cfg, TREE_MS + opp.offsetMs, { assist: o.log.current?.assist ?? opp.assist });
          for (const [ms, k] of events) r.input(ms, k);
          r.advanceTo(now - oppGreen); // catch up silently, then listen (no burst of replayed shifts)
          race.oppRun = r;
          watchOpp(r);
        }
      }
      const or = race.oppRun!;
      or.advanceTo(now - oppGreen);
      // a remote car only cools down once its final log is in (until then it may still be racing)
      if (o.kind === "cpu" || o.log.current) or.coastTo(now - oppGreen);
      oppAudio?.update(or.sim.state);

      // tree sounds follow my lane
      const lights = treeLights(now - myGreen, run.launchMs, stagedT(me.offsetMs), false);
      const ambers = lights.ambers.filter(Boolean).length;
      if (lights.stage && !race.lastStage) sfx.stage();
      if (ambers > race.lastAmbers) sfx.amber();
      if (lights.green && !race.lastGreen) sfx.green();
      if (lights.red && !race.lastRed) {
        sfx.red();
        sfx.crowd(false);
      }
      race.lastStage = lights.stage;
      race.lastAmbers = ambers;
      race.lastGreen = lights.green;
      race.lastRed = lights.red;

      if (run.finished && !race.sentLog) {
        race.sentLog = true;
        latest.current.onFinish?.(race.log);
      }
      const oppDone = o.kind === "cpu" ? or.finished : Boolean(o.log.current) && or.finished;
      if (run.finished && oppDone && !race.outcome) {
        const w = decide(run.result!, or.result!, [me.offsetMs, opp.offsetMs]);
        const margin = Math.abs(me.offsetMs + run.result!.elapsedMs - (opp.offsetMs + or.result!.elapsedMs));
        const by = Number.isFinite(margin) ? ` by ${(margin / 1000).toFixed(3)} s` : "";
        const rt = (r: RunResult) => (r.reactionMs === null ? "–" : r.redLight ? "RED" : (r.reactionMs / 1000).toFixed(3));
        const sub = `Reaction ${rt(run.result!)} vs ${rt(or.result!)}`;
        race.outcome =
          w === "a"
            ? { word: "WIN", text: or.result!.redLight ? "They red-lit" : by ? by.trim() : "They didn't finish", sub, tone: "win", at: now }
            : w === "b"
              ? { word: run.result!.redLight ? "RED LIGHT" : "LOSE", text: run.result!.redLight ? "You jumped the green" : by ? by.trim() : "You didn't finish", sub, tone: "lose", at: now }
              : { word: "DEAD HEAT", text: "Nothing in it", sub, tone: "tie", at: now };
        if (w === "a") sfx.crowd(true);
        navigator.vibrate?.(w === "a" ? [30, 60, 30, 60, 90] : 80);
      }
      // results once the car has cooled down through the gears (or after a skip / time limit)
      const age = race.outcome ? now - race.outcome.at : 0;
      if (race.outcome && !race.done && ((age > 2500 && run.sim.state.speedKmh < 25) || age > 7000 || (race.skip && age > 900))) {
        race.done = true;
        latest.current.onDone({ myLog: race.log, myResult: run.result!, oppResult: or.result });
      }

      // effects decay
      race.flames = [Math.max(0, race.flames[0] - dt * 7), Math.max(0, race.flames[1] - dt * 7)];
      race.shake = Math.max(0, race.shake - dt * 3);

      // draw
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const rollBack = ROLL_IN_M * (1 - smooth((now - startAt) / (STAGE_MS * 0.75)));
      const tone = race.outcome?.tone;
      const car = (r: DragRun, lane: Lane, green: number, i: 0 | 1, win: boolean): SceneCar => ({
        cfg: lane.cfg,
        distM: r.viewDistM(now - green),
        speedKmh: r.sim.state.speedKmh,
        rollBackM: rollBack,
        flame: race.flames[i],
        et: r.result && !r.result.dnf && !r.result.redLight ? r.result.etMs / 1000 : null,
        trapKmh: r.result && !r.result.dnf && !r.result.redLight ? r.result.trapKmh : null,
        lights: treeLights(now - green, r.launchMs, stagedT(lane.offsetMs), win),
        ghost: lane.ghost,
      });
      // (a zero-size canvas mid-layout has nothing to draw; a drawing error must never stop the race)
      if (w > 10 && h > 10) {
        try {
          draw({ me: car(run, me, myGreen, 1, tone === "win"), opp: car(or, opp, oppGreen, 0, tone === "lose"), time: now / 1000, shake: race.shake }, w, h);
        } catch (err) {
          console.error(err);
        }
      }
      // the HUD (numbers, lights) re-renders every other frame: React work off the critical path
      if ((frameNo = (frameNo + 1) % 2) === 0) setFrame((f) => (f + 1) % 1e6);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [race, audio, oppAudio, sfx, startAt, myGreen, oppGreen]);

  // ---- HUD ----
  const now = race.now;
  const run = race.myRun;
  const or = race.oppRun;
  const s = race.view;
  const intro = now < startAt;
  const cue = run.launched && run.waitingForCue && !run.finished;
  const level = Math.min(1, Math.max(0, (s.rpm - run.cue * 0.55) / (run.cue * 0.45)));
  const leds = 15;
  const myP = Math.min(1, run.distM / QUARTER_MILE_M);
  const oppP = Math.min(1, (or?.distM ?? 0) / QUARTER_MILE_M);
  const myLights = treeLights(now - myGreen, run.launchMs, stagedT(me.offsetMs), race.outcome?.tone === "win");
  const oppLights = treeLights(now - oppGreen, or?.launchMs ?? null, stagedT(opp.offsetMs), race.outcome?.tone === "lose");
  const hint = me.assist
    ? touch
      ? "Tap on the green, then tap on every shift light"
      : "Space on the green, then Space on every shift light"
    : touch
      ? "Hold BRAKE and GAS. Let go of the brake on the green."
      : "Hold S and W to stage on the two-step. Let go of S on the green. E to shift.";
  const key = (k: string, label: string, held: Action) => (
    <span className="drag-key" data-on={race.held.has(held) ? "1" : "0"}>
      <kbd>{k}</kbd>
      {label}
    </span>
  );

  return (
    <div className="drag-race" data-cue={cue ? "1" : undefined} style={{ "--accent": me.cfg.ui.accent, "--opp": opp.cfg.ui.accent } as React.CSSProperties}>
      <canvas ref={canvasRef} className="drag-canvas" aria-label="Drag strip" />
      <div className="drag-vignette" aria-hidden />

      <div className="drag-hud">
        <div className="drag-top">
          <div className="drag-leds" aria-label="Shift light">
            {Array.from({ length: leds }, (_, i) => {
              const on = cue || level * leds > i;
              const color = cue ? "cue" : i < 6 ? "g" : i < 11 ? "y" : "r";
              return <span key={i} data-on={on ? "1" : "0"} data-c={color} />;
            })}
          </div>
          <div className="drag-progress" aria-label="Race progress">
            <span className="drag-progress-car" style={{ left: `${oppP * 100}%`, background: opp.cfg.ui.accent }} title={opp.name} />
            <span className="drag-progress-car drag-progress-me" style={{ left: `${myP * 100}%`, background: me.cfg.ui.accent }} title="You" />
          </div>
          <div className="drag-names">
            <span>
              <i style={{ background: opp.cfg.ui.accent }} />
              {opp.name} · {opp.cfg.name}
              {opp.offsetMs > 0 && !run.launched && <em>+{(opp.offsetMs / 1000).toFixed(3)} s</em>}
            </span>
            <span>
              <i style={{ background: me.cfg.ui.accent }} />
              You · {me.cfg.name}
              {me.offsetMs > 0 && !run.launched && <em>+{(me.offsetMs / 1000).toFixed(3)} s</em>}
            </span>
          </div>
        </div>

        <div className={`drag-hud-tree ${!run.launched && !intro ? "" : "drag-hud-tree-hidden"}`} aria-label="Christmas tree">
          <TreeColumn label={opp.name} lights={oppLights} accent="var(--opp)" />
          <TreeColumn label="You" lights={myLights} accent="var(--accent)" />
        </div>

        <div className="drag-popups" aria-live="polite">
          {race.popups
            .filter((p) => now - p.at < 1600)
            .map((p) => (
              <div key={p.id} className={`drag-popup drag-popup-${p.tone}`}>
                <b>{p.title}</b>
                <span>{p.sub}</span>
              </div>
            ))}
        </div>

        <div className="drag-bottom">
          <div className="drag-speedo">
            <span className="drag-speed">{Math.round(s.speedKmh)}</span>
            <span className="drag-unit">km/h</span>
            <span className="drag-gear-badge">{s.gear || "N"}</span>
          </div>
          {!touch && (
            <div className="drag-keys">
              <div className="flex flex-wrap justify-center gap-2">
                {me.assist ? (
                  <>
                    {key("Space", "launch / shift", "up")}
                    {key("Q", "down", "down")}
                  </>
                ) : (
                  <>
                    {key("W", "gas", "gas")}
                    {key("S", "brake / stage", "brake")}
                    {key("E", "shift up", "up")}
                    {key("Q", "down", "down")}
                  </>
                )}
              </div>
              <span className="drag-hint">{hint}</span>
            </div>
          )}
          <div className="drag-mini-tach">
            <Tachometer state={race.view} redlineRpm={me.cfg.engine.redlineRpm} limiterRpm={me.cfg.engine.limiterRpm} accent={me.cfg.ui.accent} subscribe={race.subscribeTach} />
          </div>
        </div>

        {touch && (
          <div className={`drag-pads ${me.assist ? "drag-pads-simple" : ""}`}>
            {me.assist ? (
              <button type="button" data-pad="up" className={`drag-pad ${cue ? "drag-pad-cue" : ""}`}>
                <b>{run.launched ? (cue ? "SHIFT!" : "Shift") : "Launch"}</b>
                <span>{hint}</span>
              </button>
            ) : (
              <>
                <button type="button" data-pad="brake" className="drag-pad drag-pad-brake" data-on={race.held.has("brake") ? "1" : "0"}>
                  <b>Brake</b>
                  <span>hold to stage</span>
                </button>
                <button type="button" data-pad="up" className={`drag-pad drag-pad-shift ${cue ? "drag-pad-cue" : ""}`}>
                  <b>{cue ? "SHIFT!" : "Shift"}</b>
                </button>
                <button type="button" data-pad="gas" className="drag-pad drag-pad-gas" data-on={race.held.has("gas") ? "1" : "0"}>
                  <b>Gas</b>
                  <span>hold</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {intro && (
        <div className="drag-intro" aria-live="polite">
          <div className="drag-intro-side drag-intro-opp" style={{ "--c": opp.cfg.ui.accent } as React.CSSProperties}>
            <Silhouette kind={opp.cfg.ui.silhouette} accent={opp.cfg.ui.accent} className="h-20 w-56 -scale-x-100" />
            <b>{opp.name}</b>
            <span>{opp.cfg.name}</span>
          </div>
          <div className="drag-intro-vs">VS</div>
          <div className="drag-intro-side drag-intro-me" style={{ "--c": me.cfg.ui.accent } as React.CSSProperties}>
            <Silhouette kind={me.cfg.ui.silhouette} accent={me.cfg.ui.accent} className="h-20 w-56 -scale-x-100" />
            <b>You</b>
            <span>{me.cfg.name}</span>
          </div>
          <p className="drag-intro-hint">{hint}</p>
        </div>
      )}

      {race.outcome && (
        <>
          <div className={`drag-outcome-flash drag-outcome-flash-${race.outcome.tone}`} aria-hidden />
          {race.outcome.tone === "win" && (
            <div className="confetti" aria-hidden>
              {CONFETTI.map((c, i) => (
                <i key={i} style={c} />
              ))}
            </div>
          )}
          <div className={`drag-banner drag-banner-${race.outcome.tone}`} role="status">
            <b>{race.outcome.word}</b>
            <em>{race.outcome.text}</em>
            <span className="drag-banner-sub">{race.outcome.sub}</span>
            <span className="drag-banner-skip">{touch ? "Tap" : "Space"} for the time slip</span>
          </div>
        </>
      )}
    </div>
  );
}

/** Confetti pieces: fixed pseudo-random layout so renders stay pure. */
const CONFETTI = Array.from({ length: 46 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin((i + 1) * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const colors = ["#a3e635", "#f97316", "#facc15", "#38bdf8", "#f472b6", "#fafafa"];
  return {
    left: `${r(1) * 100}%`,
    background: colors[i % colors.length],
    animationDelay: `${r(2) * 0.5}s`,
    animationDuration: `${1.6 + r(3) * 1.4}s`,
    "--drift": `${(r(4) - 0.5) * 220}px`,
    "--spin": `${(r(5) - 0.5) * 1440}deg`,
  } as React.CSSProperties;
});

function TreeColumn({ label, lights, accent }: { label: string; lights: ReturnType<typeof treeLights>; accent: string }) {
  return (
    <div className="tree-col">
      <span className="tree-label" style={{ color: accent }}>
        {label}
      </span>
      <span className="bulb bulb-stage" data-on={lights.stage ? "1" : "0"} />
      <span className="bulb bulb-stage" data-on={lights.stage ? "1" : "0"} />
      {lights.ambers.map((on, i) =>
        i === lights.ambers.length - 1 && lights.red ? (
          <span key={i} className="bulb bulb-red" data-on="1" />
        ) : (
          <span key={i} className="bulb bulb-amber" data-on={on ? "1" : "0"} />
        ),
      )}
      <span className="bulb bulb-green" data-on={lights.green || lights.win ? "1" : "0"} />
    </div>
  );
}
