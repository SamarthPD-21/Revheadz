"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { trackEvent } from "../lib/analytics";
import type { Silhouette as Kind } from "../lib/vehicles/types";
import { Silhouette } from "./Silhouette";

export interface GarageVehicle {
  id: string;
  name: string;
  type: "car" | "bike";
  description: string;
  category: string;
  layout: string;
  displacement: string;
  powerHp: number;
  redlineRpm: number;
  accent: string;
  silhouette: Kind;
  turbo: boolean;
  synth: boolean;
  recorded: boolean;
}

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "car", label: "Cars", test: (v: GarageVehicle) => v.type === "car" },
  { id: "bike", label: "Bikes", test: (v: GarageVehicle) => v.type === "bike" },
  { id: "turbo", label: "Turbo", test: (v: GarageVehicle) => v.turbo },
  { id: "recorded", label: "Real recordings", test: (v: GarageVehicle) => v.recorded },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

/** The rev meter on each card spans 0 to this many rpm. */
const METER_MAX_RPM = 18000;

export function GarageGrid({ vehicles }: { vehicles: GarageVehicle[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const router = useRouter();
  const active = FILTERS.find((f) => f.id === filter)!;
  const shown = vehicles.filter(active.test);

  const random = () => {
    const pool = shown.length ? shown : vehicles;
    const v = pool[Math.floor(Math.random() * pool.length)];
    trackEvent("vehicle_picked", { vehicle: v.id, via: "random" });
    router.push(`/drive/${v.id}`);
  };

  return (
    <>
      <div className="mb-6 flex items-center gap-2">
        <div className="no-scrollbar -ml-4 flex min-w-0 gap-2 overflow-x-auto pl-4 sm:ml-0 sm:flex-wrap sm:pl-0" role="group" aria-label="Filter vehicles">
          {FILTERS.map((f) => {
            const n = vehicles.filter(f.test).length;
            const on = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(f.id)}
                className={`chip shrink-0 ${on ? "chip-on" : ""}`}
              >
                {f.label}
                <span className={`chip-count ${on ? "text-black/60" : "text-zinc-500"}`}>{n}</span>
              </button>
            );
          })}
        </div>
        <button type="button" onClick={random} className="chip ml-auto shrink-0 gap-2" title="Jump into a random machine" aria-label="Surprise me: random vehicle">
          <DiceIcon />
          <span className="hidden sm:inline">Surprise me</span>
        </button>
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Vehicles">
        {shown.map((v, i) => (
          <li key={v.id} className="card-enter" style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}>
            <Link
              href={`/drive/${v.id}`}
              onClick={() => trackEvent("vehicle_picked", { vehicle: v.id })}
              style={{ "--accent": v.accent, "--rev": Math.min(1, v.redlineRpm / METER_MAX_RPM) } as React.CSSProperties}
              className="vehicle-card group"
            >
              <div className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-[var(--accent)] opacity-[0.08] blur-3xl transition duration-500 group-hover:opacity-25" />
              <div className="relative flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--accent)]">{v.category}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {v.turbo && <span className="tag">Turbo</span>}
                  {v.recorded && (
                    <span className="tag border-emerald-400/30 text-emerald-300" title="Real engine recording">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                      Real
                    </span>
                  )}
                  {v.synth && <span className="tag">Live synth</span>}
                </span>
              </div>
              <div className="relative my-1">
                <div className="pointer-events-none absolute inset-x-8 bottom-1 h-6 rounded-full bg-[var(--accent)] opacity-0 blur-xl transition duration-500 group-hover:opacity-30" />
                <Silhouette kind={v.silhouette} accent={v.accent} className="vehicle-silhouette relative h-24 w-full" />
              </div>
              <h2 className="flex items-center gap-1.5 text-lg font-semibold text-white">
                {v.name}
                <svg viewBox="0 0 16 16" className="card-go h-4 w-4 text-[var(--accent)]" aria-hidden>
                  <path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </h2>
              <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{v.description}</p>

              <div className="mt-auto pt-4">
                <div className="flex items-baseline justify-between text-xs text-zinc-400">
                  <span className="font-medium text-zinc-200">{v.layout}</span>
                  <span>
                    <b className="font-semibold text-zinc-100">~{v.powerHp}</b> hp
                  </span>
                </div>
                <div className="mt-2.5 flex items-center gap-3">
                  <div className="rev-meter" aria-hidden>
                    <span />
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-zinc-400">
                    {(v.redlineRpm / 1000).toFixed(1)}k <span className="text-zinc-600">rpm</span>
                  </span>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function DiceIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <rect x="2.5" y="2.5" width="15" height="15" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="7" cy="7" r="1.4" fill="currentColor" />
      <circle cx="13" cy="13" r="1.4" fill="currentColor" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" />
    </svg>
  );
}
