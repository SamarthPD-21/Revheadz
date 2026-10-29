"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useEngineState } from "../../hooks/useEngineState";
import { trackEvent } from "../../lib/analytics";
import { AudioEngine } from "../../lib/audio/AudioEngine";
import { SpeedHold, autoShift, safeSpeedKmh } from "../../lib/cruise/autopilot";
import { InputManager } from "../../lib/input/InputManager";
import { Simulation } from "../../lib/sim/Simulation";
import type { SimListener } from "../../lib/sim/types";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { BoostGauge } from "../BoostGauge";
import { BrakePad } from "../BrakePad";
import { IgnitionButton } from "../IgnitionButton";
import { LogoMark } from "../Logo";
import { ShiftButtons } from "../ShiftButtons";
import { ShiftLights } from "../ShiftLights";
import { Speedometer } from "../Speedometer";
import { Tachometer } from "../Tachometer";
import { ThrottleControl } from "../ThrottleControl";
import { VehiclePicker, type PickerVehicle } from "../VehiclePicker";
import { Ambience } from "./ambience";
import { CAMERA_MODES, CruiseScene, type CameraMode, type Weather } from "./scene";

export interface Neighbour {
  id: string;
  name: string;
}

interface Props {
  vehicle: VehicleConfig;
  prev: Neighbour;
  next: Neighbour;
  maxKmh: number;
  garage: PickerVehicle[];
}

interface Settings {
  hour: number;
  /** Let the day go by: an hour every minute. */
  cycle: boolean;
  weather: Weather;
  camera: CameraMode;
  autopilot: boolean;
  autoGears: boolean;
  /** Off the road and anywhere on the map. */
  free: boolean;
}

const STORE_KEY = "revheadz:cruise";
const DEFAULTS: Settings = { hour: 18.85, cycle: true, weather: "clear", camera: "chase", autopilot: false, autoGears: true, free: false };
const WEATHERS: { id: Weather; label: string }[] = [
  { id: "clear", label: "Clear" },
  { id: "haze", label: "Haze" },
  { id: "fog", label: "Fog" },
  { id: "rain", label: "Rain" },
];
const CAMERA_LABEL: Record<CameraMode, string> = { chase: "Chase", far: "Far", hood: "Bonnet", cinematic: "Cinematic" };
const MOMENTS = [
  { label: "Sunrise", hour: 6.5 },
  { label: "Day", hour: 12.5 },
  { label: "Golden", hour: 18.95 },
  { label: "Dusk", hour: 19.75 },
  { label: "Night", hour: 23 },
];
/** Game hours per real second when the day is going by (a day in 24 minutes). */
const HOURS_PER_S = 1 / 60;
const STEER_LEFT = ["KeyA", "ArrowLeft"];
const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));
const STEER_RIGHT = ["KeyD", "ArrowRight"];

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* private mode or blocked storage: defaults */
  }
  return DEFAULTS;
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* not saved, still works */
  }
}

const clock = (h: number) => {
  const m = Math.floor((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Sim, sound and controls for one vehicle; nothing runs until the effect wires it up. */
function createRig(vehicle: VehicleConfig, onPending: (p: boolean) => void) {
  const sim = new Simulation(vehicle);
  const audio = new AudioEngine(vehicle);
  const ambience = new Ambience();
  let starting = false;
  const press = () => {
    audio.unlock(); // inside the tap or key press (autoplay rules)
    ambience.unlock();
    if (sim.state.ignition !== "off") {
      sim.toggleIgnition();
      return;
    }
    if (starting) return;
    starting = true;
    onPending(true);
    trackEvent("ignition_pressed", { vehicle: vehicle.id, mode: "cruise" });
    void audio.whenReady(2500).then(() => {
      starting = false;
      onPending(false);
      if (sim.state.ignition === "off") sim.toggleIgnition();
    });
  };
  const input = new InputManager({ ignition: press, shiftUp: () => sim.shiftUp(), shiftDown: () => sim.shiftDown(), neutral: () => sim.neutral() });
  // stable functions for the gauges and buttons (a new one each render would re-subscribe them)
  const subscribe = (fn: SimListener) => sim.subscribe(fn);
  const shiftUp = () => sim.shiftUp();
  const shiftDown = () => sim.shiftDown();
  const neutral = () => sim.neutral();
  const gear = () => sim.state.gear;
  return { sim, audio, ambience, input, press, subscribe, shiftUp, shiftDown, neutral, gear };
}

/**
 * Cruise: drive one of the garage's machines down an endless road through changing country,
 * as the day goes by. Throttle, brakes and gears are the playground's; the scenery, the light,
 * the weather and the cameras are what this mode is about. Client-only (WebGL, Web Audio).
 */
export default function CruiseView({ vehicle, prev, next, maxKmh, garage }: Props) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const settingsRef = useRef(settings);
  const [hourShown, setHourShown] = useState(settings.hour);
  const hourRef = useRef(settings.hour);
  const [seed, setSeed] = useState(() => 1 + Math.floor(Math.random() * 9999));
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState(false);
  const [idle, setIdle] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [muted, setMuted] = useState(false);
  const [setKmh, setSetKmh] = useState(100);
  const setKmhRef = useRef(100);
  const [trip, setTrip] = useState(0);
  const [rig] = useState(() => createRig(vehicle, setPending));
  const sceneRef = useRef<CruiseScene | null>(null);
  const steerKeys = useRef(new Set<string>());
  /** Touch steering in free roam: -1, 0 or 1 from the on-screen arrows. */
  const touchSteer = useRef(0);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    if (patch.hour !== undefined) {
      hourRef.current = patch.hour;
      setHourShown(patch.hour);
    }
    settingsRef.current = next;
    setSettings(next);
    saveSettings({ ...next, hour: hourRef.current });
  };

  const toggleMute = () => {
    setMuted((m) => {
      const v = m ? 0.8 : 0;
      rig.audio.setVolume(v);
      rig.ambience.setVolume(v);
      return !m;
    });
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  // App keys (driving keys live in InputManager): steering, camera, autopilot, gears, HUD, sound, car.
  const keyActions = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyActions.current = (e: KeyboardEvent) => {
      const s = settingsRef.current;
      if (e.code === "KeyC") update({ camera: CAMERA_MODES[(CAMERA_MODES.indexOf(s.camera) + 1) % CAMERA_MODES.length] });
      else if (e.code === "KeyT") update({ autopilot: !s.autopilot });
      else if (e.code === "KeyG") update({ autoGears: !s.autoGears });
      else if (e.code === "KeyR") update({ free: !s.free });
      else if (e.code === "KeyH") setHidden((h) => !h);
      else if (e.code === "KeyM") toggleMute();
      else if (e.code === "KeyF") toggleFullscreen();
      else if (e.code === "BracketLeft") router.push(`/cruise/${prev.id}`);
      else if (e.code === "BracketRight") router.push(`/cruise/${next.id}`);
    };
  });
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
      if ([...STEER_LEFT, ...STEER_RIGHT].includes(e.code)) {
        steerKeys.current.add(e.code);
        e.preventDefault();
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      keyActions.current(e);
    };
    const up = (e: KeyboardEvent) => steerKeys.current.delete(e.code);
    const blur = () => steerKeys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // the HUD steps aside when nothing has moved for a few seconds
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 3500);
    };
    wake();
    const events = ["pointermove", "pointerdown", "keydown"] as const;
    events.forEach((ev) => window.addEventListener(ev, wake));
    return () => {
      clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, wake));
    };
  }, []);

  // the scene: built per car and per road, then driven every frame
  useEffect(() => {
    const canvas = canvasRef.current!;
    let scene: CruiseScene;
    try {
      scene = new CruiseScene(canvas, vehicle, seed);
    } catch (err) {
      // no WebGL (switched off, or a very old device): say so instead of a black screen
      console.error(err);
      const t = window.setTimeout(() => setFailed(true), 0);
      return () => clearTimeout(t);
    }
    sceneRef.current = scene;
    // dev only: lets a test drive measure the renderer from the console
    if (process.env.NODE_ENV !== "production") (window as unknown as { __cruise?: CruiseScene }).__cruise = scene;
    const { sim, audio, ambience, input } = rig;
    const resize = () => scene.resize(canvas.clientWidth || 1, canvas.clientHeight || 1, Math.min(window.devicePixelRatio || 1, 2));
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let last = 0;
    let lastShift = 0;
    let lastUi = 0;
    const hold = new SpeedHold();
    // let the loading screen paint before the (blocking) first build of the world
    const warm = window.setTimeout(() => {
      const s = settingsRef.current;
      scene.warmUp({ hour: hourRef.current, weather: s.weather, camera: s.camera });
      setLoading(false);
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }, 30);

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = settingsRef.current;
      input.apply(sim.input, now);
      const running = sim.state.ignition === "running";
      if (s.autopilot && running) {
        // W and S set the speed it holds; it slows for bends it can see coming
        const nudge = (input.levels(now).throttle > 0.5 ? 1 : 0) - (input.levels(now).brake > 0.5 ? 1 : 0);
        if (nudge) {
          setKmhRef.current = Math.min(Math.max(30, setKmhRef.current + nudge * 40 * dt), Math.min(320, maxKmh));
        }
        const target = safeSpeedKmh(scene.bendAhead(260), setKmhRef.current);
        const c = hold.update(sim.state.speedKmh, target, dt);
        sim.input.throttle = c.throttle;
        sim.input.brake = c.brake;
      }
      if (s.autopilot || s.autoGears) lastShift = autoShift(sim, vehicle, sim.input.throttle, now / 1000, lastShift);
      // free roam: grass and dirt drag at the wheels, water much more, and deep water stops you dead
      if (scene.freeRoam !== s.free) scene.setFreeRoam(s.free);
      const under = scene.surface;
      const drag = under.blocked ? 1 : under.depth > 0 ? 0.35 : under.offRoad ? 0.07 : 0;
      sim.input.grade = scene.grade;
      if (drag) sim.input.brake = Math.max(sim.input.brake, drag * Math.min(1, sim.state.speedKmh / 15 + (under.blocked ? 1 : 0)));
      sim.advance(dt);
      audio.update(sim.state);
      if (s.cycle) hourRef.current = (hourRef.current + dt * HOURS_PER_S) % 24;
      ambience.update(sim.state.speedKmh, s.weather === "rain");
      const keys = steerKeys.current;
      const steer = clampUnit((STEER_RIGHT.some((k) => keys.has(k)) ? 1 : 0) - (STEER_LEFT.some((k) => keys.has(k)) ? 1 : 0) + touchSteer.current);
      scene.frame(dt, { speedKmh: sim.state.speedKmh, brake: sim.input.brake, steer, ignition: running }, { hour: hourRef.current, weather: s.weather, camera: s.camera });
      // the slow-moving numbers on screen: a few times a second is plenty
      if (now - lastUi > 400) {
        lastUi = now;
        setHourShown(hourRef.current);
        setTrip(scene.trip);
        setSetKmh(Math.round(setKmhRef.current));
      }
    };

    // camera orbit: drag on the scene
    let drag: { x: number; y: number } | null = null;
    const pd = (e: PointerEvent) => {
      if (e.pointerType === "touch") return; // fingers are for the pedals
      drag = { x: e.clientX, y: e.clientY };
    };
    const pm = (e: PointerEvent) => {
      if (!drag) return;
      scene.nudgeOrbit(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    };
    const pu = () => (drag = null);
    canvas.addEventListener("pointerdown", pd);
    window.addEventListener("pointermove", pm);
    window.addEventListener("pointerup", pu);

    return () => {
      clearTimeout(warm);
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", pd);
      window.removeEventListener("pointermove", pm);
      window.removeEventListener("pointerup", pu);
      saveSettings({ ...settingsRef.current, hour: hourRef.current });
      scene.dispose();
      sceneRef.current = null;
    };
  }, [rig, vehicle, seed, maxKmh]);

  // sound, controls and the sim's lifetime follow the car
  useEffect(() => {
    const { sim, audio, ambience, input } = rig;
    audio.attach();
    input.attach();
    const off = sim.subscribe((e) => {
      audio.handleEvent(e);
      if (e.type === "shift") navigator.vibrate?.(12);
    });
    const onVis = () => ambience.suspend(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    const startedAt = performance.now();
    return () => {
      off();
      input.detach();
      audio.dispose();
      ambience.dispose();
      document.removeEventListener("visibilitychange", onVis);
      trackEvent("cruise_seconds", { vehicle: vehicle.id, seconds: Math.round((performance.now() - startedAt) / 1000) });
    };
  }, [rig, vehicle.id]);

  const { sim, input, press, subscribe } = rig;
  const { ignition } = useEngineState(sim.store);
  const accent = vehicle.ui.accent;
  const iconBtn =
    "grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition hover:border-white/25 hover:text-white active:scale-90";

  return (
    <main ref={mainRef} className="drive cruise" data-idle={idle && !panel ? "1" : undefined} data-hidden={hidden ? "1" : undefined} style={{ "--accent": accent } as React.CSSProperties}>
      <canvas ref={canvasRef} className="cruise-canvas" aria-label={`Driving the ${vehicle.name} down an endless road`} />

      {failed && (
        <div className="cruise-overlay">
          <p className="text-zinc-200">This browser can&apos;t draw the 3D road (WebGL is off or unavailable).</p>
          <Link href={`/drive/${vehicle.id}`} className="chip mt-3">
            Drive it on the strip instead
          </Link>
        </div>
      )}
      {loading && !failed && (
        <div className="cruise-overlay" aria-live="polite">
          <p className="cruise-loading">Laying the road…</p>
        </div>
      )}

      <header className="drive-header cruise-fade flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <Link href="/cruise" className="group mr-1 flex shrink-0 items-center gap-2 rounded-xl p-0.5 transition active:scale-95" aria-label="Back to the cruise garage" title="Cruise">
            <LogoMark className="h-9 w-9 transition group-hover:brightness-125" />
          </Link>
          <VehiclePicker
            base="/cruise"
            current={{ id: vehicle.id, name: vehicle.name, make: vehicle.ui.make, year: vehicle.ui.year, layout: vehicle.ui.layout, accent }}
            vehicles={garage}
            eyebrow={["Cruise", vehicle.ui.make ?? vehicle.ui.category, vehicle.ui.year].filter(Boolean).join(" · ")}
          />
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <IgnitionButton store={sim.store} onPress={press} pending={pending} subscribe={subscribe} compact />
          <button type="button" className={iconBtn} onClick={() => setPanel((p) => !p)} aria-expanded={panel} aria-label="Time, weather and camera" title="Time, weather and camera">
            <SunIcon />
          </button>
          <button type="button" className={iconBtn} onClick={toggleMute} aria-pressed={muted} aria-label={muted ? "Unmute (M)" : "Mute (M)"} title={muted ? "Unmute (M)" : "Mute (M)"}>
            <SpeakerIcon muted={muted} />
          </button>
          <button type="button" className={`drive-fs ${iconBtn}`} onClick={toggleFullscreen} aria-label="Fullscreen (F)" title="Fullscreen (F)">
            <FullscreenIcon />
          </button>
        </div>
      </header>

      {panel && (
        <section className="cruise-panel" aria-label="Time, weather and camera">
          <div className="cruise-row">
            <span className="cruise-label">Time</span>
            <b className="cruise-clock">{clock(hourShown)}</b>
            <button type="button" className="track-toggle" aria-pressed={settings.cycle} onClick={() => update({ cycle: !settings.cycle, hour: hourRef.current })}>
              Let time pass
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={24}
            step={0.05}
            value={hourShown}
            aria-label="Time of day"
            style={{ accentColor: accent }}
            onChange={(e) => update({ hour: Number(e.target.value) })}
          />
          <div className="cruise-chips">
            {MOMENTS.map((m) => (
              <button key={m.label} type="button" className="chip" onClick={() => update({ hour: m.hour })}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="cruise-row">
            <span className="cruise-label">Weather</span>
          </div>
          <div className="segmented" role="group" aria-label="Weather">
            {WEATHERS.map((w) => (
              <button key={w.id} type="button" aria-pressed={settings.weather === w.id} onClick={() => update({ weather: w.id })}>
                {w.label}
              </button>
            ))}
          </div>
          <div className="cruise-row">
            <span className="cruise-label">Camera</span>
            <span className="cruise-hint">C</span>
          </div>
          <div className="segmented" role="group" aria-label="Camera">
            {CAMERA_MODES.map((c) => (
              <button key={c} type="button" aria-pressed={settings.camera === c} onClick={() => update({ camera: c })}>
                {CAMERA_LABEL[c]}
              </button>
            ))}
          </div>
          <div className="cruise-row cruise-toggles">
            <button type="button" className="track-toggle" aria-pressed={settings.autopilot} onClick={() => update({ autopilot: !settings.autopilot })}>
              Autopilot (T)
            </button>
            <button type="button" className="track-toggle" aria-pressed={settings.autoGears} onClick={() => update({ autoGears: !settings.autoGears })}>
              Auto gears (G)
            </button>
            <button type="button" className="track-toggle" aria-pressed={settings.free} onClick={() => update({ free: !settings.free })}>
              Free roam (R)
            </button>
          </div>
          <div className="cruise-row">
            <span className="cruise-label">Road #{seed}</span>
            <button
              type="button"
              className="chip"
              onClick={() => {
                setLoading(true);
                setSeed(1 + Math.floor(Math.random() * 9999));
              }}
            >
              New road
            </button>
          </div>
        </section>
      )}

      {ignition === "off" && !loading && !failed && (
        <div className="drive-start cruise-start">
          <IgnitionButton store={sim.store} onPress={press} pending={pending} subscribe={subscribe} />
          <p className="text-xs text-zinc-300">Start it up and take it for a drive</p>
        </div>
      )}

      {settings.free && (
        <button type="button" className="cruise-free cruise-fade" onClick={() => update({ free: false })} title="Back to the road (R)">
          Free roam <span>R · back to the road</span>
        </button>
      )}

      {settings.autopilot && ignition === "running" && (
        <p className="cruise-pilot cruise-fade" aria-live="polite">
          Autopilot · {setKmh} km/h <span>W / S to change</span>
        </p>
      )}

      <div className="track-cluster cruise-cluster">
        <div className="track-lights">
          <ShiftLights state={sim.state} redlineRpm={vehicle.engine.redlineRpm} />
        </div>
        <div className="track-dials">
          <div className="track-gauge">
            <Tachometer state={sim.state} redlineRpm={vehicle.engine.redlineRpm} limiterRpm={vehicle.engine.limiterRpm} accent={accent} subscribe={subscribe} />
          </div>
          <div className="track-gauge track-boost">
            <BoostGauge state={sim.state} redlineRpm={vehicle.engine.redlineRpm} turbo={Boolean(vehicle.turbo)} accent={accent} />
          </div>
          <div className="track-gauge">
            <Speedometer state={sim.state} accent={accent} maxKmh={maxKmh} />
          </div>
        </div>
        <p className="cruise-trip">{(trip / 1000).toFixed(1)} km</p>
      </div>

      <dl className="drive-keys cruise-keys cruise-fade">
        {[
          ["W / S", "Gas / brake"],
          ["A / D", "Steer"],
          ["R", "Free roam"],
          ["E / Q", "Shift"],
          ["C", "Camera"],
          ["T", "Autopilot"],
          ["H", "Hide HUD"],
        ].map(([k, what]) => (
          <div key={k}>
            <kbd className="keycap">{k}</kbd>
            <span>{what}</span>
          </div>
        ))}
      </dl>

      <div className="drive-touch">
        <div className="drive-touch-left">
          <ShiftButtons onUp={rig.shiftUp} onDown={rig.shiftDown} onNeutral={rig.neutral} subscribe={subscribe} gear={rig.gear} />
          <div className="drive-touch-brake">
            <BrakePad input={input} />
          </div>
        </div>
        {settings.free && (
          <div className="cruise-steer" role="group" aria-label="Steer">
            {([-1, 1] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                className="ctl"
                aria-label={dir < 0 ? "Steer left" : "Steer right"}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  touchSteer.current = dir;
                }}
                onPointerUp={() => (touchSteer.current = 0)}
                onPointerCancel={() => (touchSteer.current = 0)}
              >
                <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden>
                  <path d={dir < 0 ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ))}
          </div>
        )}
        <div className="drive-touch-gas">
          <ThrottleControl input={input} accent={accent} />
        </div>
      </div>
    </main>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path d="M5 13a5 5 0 0110 0M2.5 13h15M10 4v2.2M4.3 6.3l1.5 1.5M15.7 6.3l-1.5 1.5M5 16.5h10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden>
      <path d="M3 8v4h3l4 3.5v-11L6 8H3z" fill="currentColor" />
      {muted ? (
        <path d="M13 7.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      ) : (
        <path d="M13 7a4 4 0 010 6m2.2-8.5a7.5 7.5 0 010 11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      )}
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path d="M3 8V3h5m4 0h5v5m0 4v5h-5m-4 0H3v-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
