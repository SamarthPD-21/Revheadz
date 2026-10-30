"use client";

import { useState } from "react";
import { PRESETS, presetOf, type Settings } from "./settings";

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Frames drawn a second now, the screen's refresh rate, and the resolution being drawn (share of full). */
  fps: { now: number; screen: number };
  renderScale: number;
  accent: string;
  onClose: () => void;
}

type Tab = "display" | "graphics" | "sound";

const FRAME_RATES: { id: Settings["fps"]; label: string }[] = [
  { id: "60", label: "60" },
  { id: "90", label: "90" },
  { id: "120", label: "120" },
  { id: "max", label: "Max" },
];
const SCALES: { id: Settings["scale"]; label: string; title: string }[] = [
  { id: "auto", label: "Auto", title: "Sharpens or softens on its own to hold the frame rate" },
  { id: "50", label: "50%", title: "Half resolution: fastest" },
  { id: "75", label: "75%", title: "Three-quarter resolution" },
  { id: "100", label: "100%", title: "Full resolution" },
  { id: "150", label: "150%", title: "Drawn larger and scaled down: the smoothest edges, the most work" },
];
const DISTANCES: { id: Settings["distance"]; label: string; title: string }[] = [
  { id: "near", label: "Near", title: "About 500 m of detail, the horizon at 2 km" },
  { id: "medium", label: "Medium", title: "About 650 m of detail, the horizon at 3 km" },
  { id: "far", label: "Far", title: "About 800 m of detail, the horizon at 4 km" },
  { id: "extreme", label: "Extreme", title: "About 1.1 km of detail, the horizon at 5.5 km" },
];
const LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
] as const;
const SHADOWS: { id: Settings["shadows"]; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "on", label: "On" },
  { id: "high", label: "High" },
];

/** The cruise's settings: display, graphics and sound, each change applied as it's made. */
export function SettingsPanel({ settings: s, update, fps, renderScale, accent, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("display");
  const preset = presetOf(s);
  return (
    <section className="cruise-panel cruise-settings" aria-label="Settings">
      <div className="cruise-row">
        <span className="cruise-label">Settings</span>
        <button type="button" className="cruise-close" onClick={onClose} aria-label="Close settings (O)" title="Close (O)">
          ×
        </button>
      </div>
      <div className="cruise-tabs" role="tablist">
        {(["display", "graphics", "sound"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "display" && (
        <>
          <Row label="Resolution" hint={`drawing at ${Math.round(renderScale * 100)}%`} />
          <Segmented label="Resolution" options={SCALES} value={s.scale} onPick={(scale) => update({ scale })} />
          <Row label="Frame rate" hint={`${fps.now} fps · screen ${fps.screen} Hz`} />
          <Segmented
            label="Frame rate"
            options={FRAME_RATES.map((f) => ({ ...f, title: f.id === "max" ? "As fast as your screen refreshes" : `Aim for ${f.label} frames a second` }))}
            value={s.fps}
            onPick={(fpsId) => update({ fps: fpsId })}
          />
          <Row label="Field of view" hint={`${s.fov}°`} />
          <input type="range" min={45} max={85} step={1} value={s.fov} aria-label="Field of view" style={{ accentColor: accent }} onChange={(e) => update({ fov: Number(e.target.value) })} />
          <Toggle label="Show frame rate" on={s.showFps} onToggle={() => update({ showFps: !s.showFps })} />
        </>
      )}

      {tab === "graphics" && (
        <>
          <Row label="Quality" hint={preset ? "" : "Custom"} />
          <Segmented label="Quality preset" options={PRESETS} value={preset ?? ""} onPick={(id) => update({ ...PRESETS.find((p) => p.id === id)!.q })} />
          <Row label="Render distance" />
          <Segmented label="Render distance" options={DISTANCES} value={s.distance} onPick={(distance) => update({ distance })} />
          <Row label="Trees and grass" />
          <Segmented label="Trees and grass" options={LEVELS.map((l) => ({ ...l, title: `${l.label} density` }))} value={s.vegetation} onPick={(vegetation) => update({ vegetation })} />
          <Row label="Shadows" />
          <Segmented label="Shadows" options={SHADOWS.map((o) => ({ ...o, title: o.id === "high" ? "A finer shadow map: crisper edges" : o.label }))} value={s.shadows} onPick={(shadows) => update({ shadows })} />
          <div className="cruise-row cruise-toggles">
            <Toggle label="Glow (bloom)" on={s.bloom} onToggle={() => update({ bloom: !s.bloom })} />
            <Toggle label="Clouds" on={s.clouds} onToggle={() => update({ clouds: !s.clouds })} />
          </div>
        </>
      )}

      {tab === "sound" && (
        <>
          <Row label="Engine" hint={`${Math.round(s.engineVolume * 100)}%`} />
          <input type="range" min={0} max={1} step={0.05} value={s.engineVolume} aria-label="Engine volume" style={{ accentColor: accent }} onChange={(e) => update({ engineVolume: Number(e.target.value) })} />
          <Row label="Wind and rain" hint={`${Math.round(s.worldVolume * 100)}%`} />
          <input type="range" min={0} max={1} step={0.05} value={s.worldVolume} aria-label="Wind and rain volume" style={{ accentColor: accent }} onChange={(e) => update({ worldVolume: Number(e.target.value) })} />
        </>
      )}
    </section>
  );
}

function Row({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="cruise-row">
      <span className="cruise-label">{label}</span>
      {hint ? <span className="cruise-hint">{hint}</span> : null}
    </div>
  );
}

function Segmented<T extends string>({ label, options, value, onPick }: { label: string; options: readonly { id: T; label: string; title?: string }[]; value: T | ""; onPick: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onPick(o.id)} title={o.title}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="track-toggle" aria-pressed={on} onClick={onToggle}>
      {label}
    </button>
  );
}
