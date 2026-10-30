"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useEngineState } from "../../hooks/useEngineState";
import { trackEvent } from "../../lib/analytics";
import { AudioEngine } from "../../lib/audio/AudioEngine";
import { SpeedHold, autoShift, safeSpeedKmh } from "../../lib/cruise/autopilot";
import { chassisOf, type Aids } from "../../lib/cruise/handling";
import { roadModel } from "../../lib/cruise/specs";
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
import { FrameGate } from "../../lib/cruise/frameGate";
import { forgetRoad, loadTiles, saveTiles } from "../../lib/cruise/tileCache";
import { CAMERA_MODES, CruiseScene, type CameraMode, type Place, type Weather } from "./scene";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULTS, graphicsOf, type Settings } from "./settings";
import { RANGES, World, type TileData } from "./world";

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

const STORE_KEY = "revheadz:cruise";
const WEATHERS: { id: Weather; label: string }[] = [
  { id: "clear", label: "Clear" },
  { id: "haze", label: "Haze" },
  { id: "fog", label: "Fog" },
  { id: "rain", label: "Rain" },
];
const CAMERA_LABEL: Record<CameraMode, string> = { chase: "Chase", far: "Far", hood: "Bonnet", drone: "Drone", cinematic: "Film" };
const MOMENTS = [
  { label: "Sunrise", hour: 6.5 },
  { label: "Day", hour: 12.5 },
  { label: "Golden", hour: 18.95 },
  { label: "Dusk", hour: 19.75 },
  { label: "Night", hour: 23 },
];
/** Game hours per real second when the day is going by (a day in 24 minutes). */
const HOURS_PER_S = 1 / 60;
const AIDS: { id: Settings["aids"]; label: string; title: string }[] = [
  { id: "car", label: "As built", title: "The aids this car left the factory with" },
  { id: "on", label: "All on", title: "ABS, traction control and stability control" },
  { id: "off", label: "Off", title: "No ABS, no traction control, no stability control" },
];
const ALL_AIDS: Aids = { abs: true, tc: true, esc: true };
const NO_AIDS: Aids = { abs: false, tc: false, esc: false };
const aidList = (a: Aids) => [a.abs && "ABS", a.tc && "TC", a.esc && "ESC"].filter(Boolean).join(" · ") || "none";
const STEER_LEFT = ["KeyA", "ArrowLeft"];
const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));
const STEER_RIGHT = ["KeyD", "ArrowRight"];

/** The world you were in: its road, where you'd got to, and your trip so far. */
interface SavedWorld {
  seed: number;
  place: Place;
  tripM: number;
  tripS: number;
}
const WORLD_KEY = "revheadz:cruise-world";

function loadWorld(): SavedWorld | null {
  try {
    const raw = localStorage.getItem(WORLD_KEY);
    return raw ? (JSON.parse(raw) as SavedWorld) : null;
  } catch {
    return null;
  }
}

function saveWorld(w: SavedWorld | null) {
  try {
    if (w) localStorage.setItem(WORLD_KEY, JSON.stringify(w));
    else localStorage.removeItem(WORLD_KEY);
  } catch {
    /* not kept, still drives */
  }
}

/** 1:05:09 or 5:09. */
const duration = (s: number) => {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings> & { autoGears?: boolean };
      // the old on/off "auto gears" switch becomes the gearbox choice
      if (!saved.gears && saved.autoGears !== undefined) saved.gears = saved.autoGears ? "auto" : "manual";
      delete saved.autoGears;
      return { ...DEFAULTS, ...saved };
    }
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
  // on the open road it drives as the real car does: its engine, weight, aero and drivetrain
  sim.model = roadModel(vehicle);
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
  const carAids = chassisOf(vehicle, 4.5).aids;
  return { sim, audio, ambience, input, press, subscribe, shiftUp, shiftDown, neutral, gear, carAids };
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
  // the road you were on last time, or a new one
  const [seed, setSeed] = useState(() => loadWorld()?.seed ?? 1 + Math.floor(Math.random() * 9999));
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renderScale, setRenderScale] = useState(1);
  const [idle, setIdle] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [muted, setMuted] = useState(false);
  const [setKmh, setSetKmh] = useState(100);
  const setKmhRef = useRef(100);
  const [trip, setTrip] = useState({ m: 0, s: 0 });
  /** Frames drawn a second, and how fast the screen refreshes. */
  const [fps, setFps] = useState({ now: 0, screen: 60 });
  const [rig] = useState(() => createRig(vehicle, setPending));
  const sceneRef = useRef<CruiseScene | null>(null);
  const steerKeys = useRef(new Set<string>());
  /** Touch steering in free roam: -1, 0 or 1 from the on-screen arrows. */
  const touchSteer = useRef(0);
  const gripRef = useRef<HTMLParagraphElement>(null);
  const [stalled, setStalled] = useState(false);

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

  const toggleMute = () => setMuted((m) => !m);
  // the sound settings (and mute over them)
  useEffect(() => {
    rig.audio.setVolume(muted ? 0 : settings.engineVolume);
    rig.ambience.setVolume(muted ? 0 : settings.worldVolume);
  }, [rig, muted, settings.engineVolume, settings.worldVolume]);
  // the graphics settings, as they change
  useEffect(() => {
    sceneRef.current?.setGraphics(graphicsOf(settings));
  }, [settings]);
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
      else if (e.code === "KeyG") update({ gears: s.gears === "auto" ? "manual" : "auto" });
      else if (e.code === "KeyB") sceneRef.current?.resetToRoad();
      else if (e.code === "KeyR") update({ free: !s.free });
      else if (e.code === "KeyH") setHidden((h) => !h);
      else if (e.code === "KeyO") {
        setSettingsOpen((o) => !o);
        setPanel(false);
      } else if (e.code === "Escape") setSettingsOpen(false);
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
    scene.setGraphics(graphicsOf(settingsRef.current));
    // in development, or with ?debug in the address: lets a test drive measure the renderer
    if (process.env.NODE_ENV !== "production" || new URLSearchParams(location.search).has("debug")) (window as unknown as { __cruise?: CruiseScene }).__cruise = scene;
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
    // back where you left off, on the same road
    const was = loadWorld();
    let tripS = 0;
    if (was && was.seed === seed) {
      scene.restore(was.place);
      scene.trip = was.tripM;
      tripS = was.tripS;
    }
    const save = () => {
      saveWorld({ seed, place: scene.placeNow, tripM: scene.trip, tripS });
      void saveTiles(seed, scene.takeFreshTiles());
    };
    // load the map kept from earlier visits, then build the rest (behind the loading screen)
    let cancelled = false;
    let ready = false;
    let warm = 0;
    const start = scene.placeNow;
    void loadTiles<TileData>(seed, World.keysAround(start.x, start.z, RANGES[settingsRef.current.distance].ring)).then((tiles) => {
      if (cancelled) return;
      scene.primeTiles(tiles);
      warm = window.setTimeout(() => {
        const s = settingsRef.current;
        scene.warmUp({ hour: hourRef.current, weather: s.weather, camera: s.camera });
        ready = true;
        setLoading(false);
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }, 30);
    });
    let lastSave = performance.now();
    const gate = new FrameGate();
    let frames = 0;
    let fpsAt = performance.now();
    let lastGrip = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const s = settingsRef.current;
      // the chosen frame rate: on a screen faster than it, some refreshes are skipped
      const cap = s.fps === "max" ? 0 : Number(s.fps);
      if (!gate.tick(now, cap)) return;
      scene.targetMs = gate.targetMs(cap);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      frames++;
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
      if (s.autopilot || s.gears === "auto") lastShift = autoShift(sim, vehicle, sim.input.throttle, now / 1000, lastShift);
      // free roam: grass and dirt drag at the wheels, water much more, and deep water stops you dead
      if (scene.freeRoam !== s.free) scene.setFreeRoam(s.free);
      const under = scene.surface;
      const aids = s.aids === "car" ? scene.carAids : s.aids === "on" ? ALL_AIDS : NO_AIDS;
      scene.aids = aids;
      sim.input.tc = aids.tc;
      sim.input.abs = aids.abs;
      sim.input.grade = scene.grade;
      // what the tyres can put down here, and take on the brakes (grip, weight on the wheels, slope)
      sim.input.traction = scene.traction;
      sim.input.brakeGrip = scene.brakeGrip;
      // with a clutch pedal and you on the gears, it can stall
      sim.canStall = s.gears === "manual" && !s.autopilot;
      // soft ground drags at the wheels (water much more, and deep water stops you dead), and the
      // tyres take speed off through bends and slides
      const soft = under.blocked ? 1.2 : under.depth > 0 ? 0.35 : under.offRoad ? 0.07 : 0;
      const mass = sim.model?.massKg ?? vehicle.dynamics.massKg;
      sim.input.resist = soft * 9.81 * mass * Math.min(1, sim.state.speedKmh / 15 + (under.blocked ? 1 : 0)) + scene.scrub;
      // stability control cuts the power while it's catching the car
      if (scene.escActive) sim.input.throttle *= 0.4;
      sim.advance(dt);
      if (sim.state.speedKmh > 1) tripS += dt;
      audio.update(sim.state);
      if (s.cycle) hourRef.current = (hourRef.current + dt * HOURS_PER_S) % 24;
      ambience.update(sim.state.speedKmh, s.weather === "rain");
      const keys = steerKeys.current;
      const steer = clampUnit((STEER_RIGHT.some((k) => keys.has(k)) ? 1 : 0) - (STEER_LEFT.some((k) => keys.has(k)) ? 1 : 0) + touchSteer.current);
      scene.frame(dt, { speedKmh: sim.state.speedKmh, throttle: sim.input.throttle, brake: sim.input.brake, wheelspin: sim.state.wheelspin ?? 0, locked: Boolean(sim.state.locked), steer, ignition: running }, { hour: hourRef.current, weather: s.weather, camera: s.camera });
      // grip readout: what's underfoot, how grippy it is for this car, and any wheelspin or slide
      const gripEl = gripRef.current;
      if (gripEl && now - lastGrip > 120) {
        lastGrip = now;
        const g = scene.gripInfo;
        const spin = (sim.state.wheelspin ?? 0) > 0.2;
        const slide = scene.surface.slide > 0.35;
        const text = `${g.name} · grip ×${g.factor.toFixed(2)}`;
        if (gripEl.dataset.text !== text) {
          gripEl.dataset.text = text;
          gripEl.firstChild!.textContent = text;
        }
        const warn = sim.state.locked ? "Wheels locked" : spin ? "Wheelspin" : slide ? "Sliding" : "";
        if (gripEl.dataset.warn !== warn) {
          gripEl.dataset.warn = warn;
          (gripEl.children[1] as HTMLElement).textContent = warn;
        }
        // the dash lights: each one flickers on while its aid is working
        const lights = gripEl.lastElementChild as HTMLElement;
        const on = [sim.state.abs, aids.tc && (sim.state.wheelspin ?? 0) > 0.04, scene.escActive];
        on.forEach((lit, i) => (lights.children[i] as HTMLElement).classList.toggle("lit", Boolean(lit)));
      }
      // the slow-moving numbers on screen: a few times a second is plenty
      if (now - lastUi > 400) {
        lastUi = now;
        setHourShown(hourRef.current);
        setTrip({ m: scene.trip, s: tripS });
        setSetKmh(Math.round(setKmhRef.current));
        setFps({ now: Math.round((frames * 1000) / Math.max(1, now - fpsAt)), screen: Math.round(1000 / gate.screenMs) });
        setRenderScale(scene.renderScale);
        frames = 0;
        fpsAt = now;
      }
      if (now - lastSave > 4000) {
        lastSave = now;
        save();
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

    const onHide = () => document.hidden && save();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", save);
    return () => {
      cancelled = true;
      clearTimeout(warm);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", save);
      if (ready) save(); // (not before the world was even built: that would save the start)
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
      if (e.type === "stall") {
        setStalled(true);
        navigator.vibrate?.([30, 40, 60]);
      }
      if (e.type === "start") setStalled(false);
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
          <button type="button" className={iconBtn} onClick={() => sceneRef.current?.resetToRoad()} aria-label="Back to the road (B)" title="Back to the road (B)">
            <RoadIcon />
          </button>
          <button
            type="button"
            className={iconBtn}
            onClick={() => {
              setPanel((p) => !p);
              setSettingsOpen(false);
            }}
            aria-expanded={panel}
            aria-label="Time, weather and camera"
            title="Time, weather and camera"
          >
            <SunIcon />
          </button>
          <button
            type="button"
            className={iconBtn}
            onClick={() => {
              setSettingsOpen((o) => !o);
              setPanel(false);
            }}
            aria-expanded={settingsOpen}
            aria-label="Settings (O)"
            title="Settings: resolution, frame rate, render distance, graphics, sound (O)"
          >
            <GearIcon />
          </button>
          <button type="button" className={iconBtn} onClick={toggleMute} aria-pressed={muted} aria-label={muted ? "Unmute (M)" : "Mute (M)"} title={muted ? "Unmute (M)" : "Mute (M)"}>
            <SpeakerIcon muted={muted} />
          </button>
          <button type="button" className={`drive-fs ${iconBtn}`} onClick={toggleFullscreen} aria-label="Fullscreen (F)" title="Fullscreen (F)">
            <FullscreenIcon />
          </button>
        </div>
      </header>

      {settingsOpen && <SettingsPanel settings={settings} update={update} fps={fps} renderScale={renderScale} accent={accent} onClose={() => setSettingsOpen(false)} />}
      {settings.showFps && (
        <p className="cruise-fps" aria-hidden>
          {fps.now} fps
        </p>
      )}

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
          <div className="cruise-row">
            <span className="cruise-label">Gearbox</span>
            <span className="cruise-hint">G</span>
          </div>
          <div className="segmented" role="group" aria-label="Gearbox">
            {(["manual", "auto"] as const).map((g) => (
              <button key={g} type="button" aria-pressed={settings.gears === g} onClick={() => update({ gears: g })} title={g === "manual" ? "You shift, with E and Q" : "The car shifts for you"}>
                {g === "manual" ? "Manual" : "Automatic"}
              </button>
            ))}
          </div>
          <div className="cruise-row">
            <span className="cruise-label">Driver aids</span>
            <span className="cruise-hint" title="What this car came with">{vehicle.name}: {aidList(rig.carAids)}</span>
          </div>
          <div className="segmented" role="group" aria-label="Driver aids">
            {AIDS.map((a) => (
              <button key={a.id} type="button" aria-pressed={settings.aids === a.id} onClick={() => update({ aids: a.id })} title={a.title}>
                {a.label}
              </button>
            ))}
          </div>
          <div className="cruise-row cruise-toggles">
            <button type="button" className="track-toggle" aria-pressed={settings.autopilot} onClick={() => update({ autopilot: !settings.autopilot })}>
              Autopilot (T)
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
                void forgetRoad(seed);
                saveWorld(null);
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
          {stalled && <p className="cruise-stalled">Stalled</p>}
          <IgnitionButton store={sim.store} onPress={press} pending={pending} subscribe={subscribe} />
          <p className="text-xs text-zinc-300">
            {stalled ? "Knock it into neutral (N) or 1st, then start it again (I)" : "Start it up and take it for a drive"}
          </p>
        </div>
      )}

      {settings.free && (
        <button type="button" className="cruise-free cruise-fade" onClick={() => update({ free: false })} title="Lane assist back on (R)">
          Free roam <span>R · lane assist · B · back to road</span>
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
        <p ref={gripRef} className="cruise-grip" aria-live="off">
          <span>Tarmac · grip ×1.00</span>
          <b />
          <span className="cruise-lights" aria-hidden>
            <i>ABS</i>
            <i>TC</i>
            <i>ESC</i>
          </span>
        </p>
        <p className="cruise-trip" title="This trip: distance, time on the move and average speed">
          {(trip.m / 1000).toFixed(1)} km · {duration(trip.s)} · avg {trip.s > 5 ? Math.round((trip.m / trip.s) * 3.6) : 0} km/h · {settings.gears === "auto" ? "Auto" : "Manual"}
        </p>
      </div>

      <dl className="drive-keys cruise-keys cruise-fade">
        {[
          ["W / S", "Gas / brake"],
          ["A / D", "Steer"],
          ["R", "Free roam"],
          ["B", "Back to road"],
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

function RoadIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path d="M7 3L4 17M13 3l3 14M10 4v2.5M10 9v2.5M10 14v2.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
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

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
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
