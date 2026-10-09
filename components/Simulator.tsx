"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "../lib/analytics";
import { AudioEngine } from "../lib/audio/AudioEngine";
import { InputManager } from "../lib/input/InputManager";
import { Simulation } from "../lib/sim/Simulation";
import type { SimListener } from "../lib/sim/types";
import type { VehicleConfig } from "../lib/vehicles/types";
import { BrakePad } from "./BrakePad";
import { GearIndicator } from "./GearIndicator";
import { ShiftLights } from "./ShiftLights";
import { Telemetry } from "./Telemetry";
import { IgnitionButton } from "./IgnitionButton";
import { ShiftButtons } from "./ShiftButtons";
import { Speedometer } from "./Speedometer";
import { Tachometer } from "./Tachometer";
import { ThrottleControl } from "./ThrottleControl";
import { pressHandlers } from "./press";
import { KeyLegend } from "./KeyLegend";

export type SoundSet = "recorded" | "generated";

interface Rig {
  sim: Simulation;
  input: InputManager;
  /** The live audio engine; replaced when the sound set is switched. */
  audio: { current: AudioEngine };
  press: () => void;
  shiftUp: () => void;
  shiftDown: () => void;
  neutral: () => void;
  subscribe: (fn: SimListener) => () => void;
  gear: () => number;
  /** Switches between real-recording and engine-model sound. Call from a tap (it may unlock audio). */
  setSound: (set: SoundSet) => void;
  setVolume: (v: number) => void;
  /** Reports the current (and every future) engine's load status; returns an unsubscribe. */
  bindStatus: (fn: (s: LoadState) => void) => () => void;
}

type LoadState = "idle" | "loading" | "ready" | "error";

/** Builds the (side-effect free) objects for one vehicle; wiring happens in the effect. */
function createRig(vehicle: VehicleConfig, onFirstPress: () => void, onPending: (p: boolean) => void): Rig {
  const sim = new Simulation(vehicle);
  const audio = { current: new AudioEngine(vehicle) };
  let volume = 0.8;
  let onStatus: (s: LoadState) => void = () => undefined;
  let offStatus = () => {};
  let starting = false;

  const press = () => {
    const engine = audio.current;
    engine.unlock(); // must happen synchronously inside the tap/key handler
    if (sim.state.ignition !== "off") {
      sim.toggleIgnition();
      return;
    }
    if (starting) return;
    trackEvent("ignition_pressed", { vehicle: vehicle.id });
    onFirstPress();
    starting = true;
    onPending(true);
    // Give the recordings a moment to decode so the first start-up isn't silent.
    void engine.whenReady(2500).then(() => {
      starting = false;
      onPending(false);
      if (sim.state.ignition === "off") sim.toggleIgnition();
    });
  };

  const setSound = (set: SoundSet) => {
    const prevEngine = audio.current;
    const next = new AudioEngine(vehicle, set === "generated" && vehicle.audioGenerated ? vehicle.audioGenerated : vehicle.audio);
    next.attach();
    next.setVolume(volume);
    offStatus();
    offStatus = next.onStatus(onStatus);
    if (prevEngine.unlocked) next.unlock(); // still inside the tap: keep sound going
    prevEngine.dispose();
    audio.current = next;
    trackEvent("sound_set", { vehicle: vehicle.id, set });
  };

  const input = new InputManager({
    ignition: press,
    shiftUp: () => sim.shiftUp(),
    shiftDown: () => sim.shiftDown(),
    neutral: () => sim.neutral(),
  });
  const setVolume = (v: number) => {
    volume = v;
    audio.current.setVolume(v);
  };
  const bindStatus = (fn: (s: LoadState) => void) => {
    onStatus = fn;
    offStatus = audio.current.onStatus(fn);
    return () => {
      offStatus();
      onStatus = () => undefined;
    };
  };
  return {
    sim,
    audio,
    input,
    press,
    setSound,
    setVolume,
    bindStatus,
    shiftUp: () => sim.shiftUp(),
    shiftDown: () => sim.shiftDown(),
    neutral: () => sim.neutral(),
    subscribe: (fn: SimListener) => sim.subscribe(fn),
    gear: () => sim.state.gear,
  };
}

export interface Neighbour {
  id: string;
  name: string;
}

interface Props {
  vehicle: VehicleConfig;
  prev: Neighbour;
  next: Neighbour;
  maxKmh: number;
}

/** Owns the simulation loop, input and audio for one vehicle. Client-only. */
export default function Simulator({ vehicle, prev, next, maxKmh }: Props) {
  const [volume, setVolume] = useState(0.8);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [everStarted, setEverStarted] = useState(false);
  const [pending, setPending] = useState(false);
  const [soundSet, setSoundSet] = useState<SoundSet>("recorded");
  const volumeRef = useRef(0.8);
  const [rig] = useState(() => createRig(vehicle, () => setEverStarted(true), setPending));

  useEffect(() => {
    const { sim, audio, input } = rig;
    audio.current.attach();
    rig.setVolume(volumeRef.current);
    input.attach();

    const offSim = sim.subscribe((e) => {
      audio.current.handleEvent(e);
      if (e.type === "shift") navigator.vibrate?.(12);
    });
    const unbindStatus = rig.bindStatus(setLoadState);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      input.apply(sim.input, now);
      sim.advance((now - last) / 1000);
      last = now;
      audio.current.update(sim.state);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const startedAt = performance.now();
    // Leaving the page must fully stop the sound.
    return () => {
      cancelAnimationFrame(raf);
      input.detach();
      offSim();
      unbindStatus();
      audio.current.dispose();
      trackEvent("drive_seconds", { vehicle: vehicle.id, seconds: Math.round((performance.now() - startedAt) / 1000) });
    };
  }, [rig, vehicle.id]);

  const { sim, input, press, setSound } = rig;
  const canSwitch = Boolean(vehicle.ui.recorded && vehicle.audioGenerated);

  const accent = vehicle.ui.accent;
  const navLink =
    "grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition hover:border-white/30 hover:text-white";

  return (
    <main className="drive" style={{ "--accent": accent } as React.CSSProperties}>
      <div className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-2/3 bg-[radial-gradient(ellipse_at_top,var(--accent),transparent_60%)] opacity-[0.12]" />
      <header className="drive-header flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" className="rounded-lg px-2 py-1 text-sm text-zinc-300 hover:bg-white/10" aria-label="Back to garage">
            ← <span className="hidden sm:inline">Garage</span>
          </Link>
          <Link href={`/drive/${prev.id}`} className={navLink} aria-label={`Previous vehicle: ${prev.name}`}>
            ‹
          </Link>
          <div className="min-w-0 text-center">
            <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: accent }}>
              {vehicle.ui.category} · {vehicle.ui.layout}
            </p>
            <h1 className="truncate text-sm font-bold text-zinc-100 sm:text-base">{vehicle.name}</h1>
          </div>
          <Link href={`/drive/${next.id}`} className={navLink} aria-label={`Next vehicle: ${next.name}`}>
            ›
          </Link>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
        {canSwitch && (
          <div className="flex rounded-full border border-white/15 bg-white/5 p-0.5 text-[11px] font-semibold" role="group" aria-label="Sound source">
            {(["recorded", "generated"] as const).map((set) => (
              <button
                key={set}
                type="button"
                aria-pressed={soundSet === set}
                title={set === "recorded" ? "Real engine recording" : "Engine-model (generated) sound"}
                {...pressHandlers(() => {
                  if (soundSet === set) return;
                  setSound(set);
                  setSoundSet(set);
                })}
                className={`rounded-full px-2.5 py-1 transition ${soundSet === set ? "text-black" : "text-zinc-300 hover:text-white"}`}
                style={soundSet === set ? { background: accent } : undefined}
              >
                {set === "recorded" ? "🎙 Real" : "⚙ Model"}
              </button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <span aria-hidden>🔊</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Master volume"
            className="w-20 sm:w-32"
            style={{ accentColor: accent }}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              volumeRef.current = v;
              rig.setVolume(v);
            }}
          />
        </label>
        </div>
      </header>

      <section className="drive-gauges grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2" aria-label="Gauges">
        <div className="mx-auto h-4 w-full max-w-md sm:h-5">
          <ShiftLights state={sim.state} redlineRpm={vehicle.engine.redlineRpm} />
        </div>
        <div className="cluster grid min-h-0 grid-cols-[minmax(0,1fr)_3.5rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)] sm:gap-6">
          <div className="gauge-tach relative h-full min-h-0 min-w-0">
            <Tachometer state={sim.state} redlineRpm={vehicle.engine.redlineRpm} limiterRpm={vehicle.engine.limiterRpm} accent={accent} subscribe={rig.subscribe} />
          </div>
          <div className="gauge-telemetry relative h-full max-h-56 min-h-24">
            <Telemetry state={sim.state} brake={() => input.brakeLevel()} turbo={Boolean(vehicle.turbo)} accent={accent} />
          </div>
          <div className="gauge-speedo relative h-full min-h-0 min-w-0">
            <Speedometer state={sim.state} accent={accent} maxKmh={maxKmh} />
          </div>
        </div>
        <GearIndicator store={sim.store} />
      </section>

      <div className="drive-left flex min-h-0 flex-col gap-2">
        <div className="min-h-0 flex-1">
          <BrakePad input={input} />
        </div>
        <ShiftButtons onUp={rig.shiftUp} onDown={rig.shiftDown} onNeutral={rig.neutral} subscribe={rig.subscribe} gear={rig.gear} />
      </div>

      <div className="drive-center flex min-w-0 flex-col items-center justify-center gap-2 text-center">
        {!everStarted && (
          <p className="drive-warning max-w-48 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-1.5 text-[11px] text-yellow-200" role="note">
            Turn your volume down first. Engines are loud.
          </p>
        )}
        <IgnitionButton store={sim.store} onPress={press} pending={pending} subscribe={rig.subscribe} />
        <p className="h-4 text-[11px] text-zinc-400" aria-live="polite">
          {loadState === "loading" ? "Loading sounds…" : loadState === "error" ? "Using synthesized sound" : ""}
        </p>
        <KeyLegend input={input} />
      </div>

      <div className="drive-right min-h-0">
        <ThrottleControl input={input} accent={accent} />
      </div>
    </main>
  );
}
