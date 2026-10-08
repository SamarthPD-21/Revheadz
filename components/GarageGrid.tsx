"use client";

import Link from "next/link";
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
  { id: "all", label: "All" },
  { id: "car", label: "Cars" },
  { id: "bike", label: "Bikes" },
  { id: "turbo", label: "Turbo" },
  { id: "recorded", label: "Real recordings" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

export function GarageGrid({ vehicles }: { vehicles: GarageVehicle[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = vehicles.filter((v) =>
    filter === "all" ? true : filter === "turbo" ? v.turbo : filter === "recorded" ? v.recorded : v.type === filter,
  );

  return (
    <>
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filter vehicles">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${
              filter === f.id
                ? "border-orange-400 bg-orange-500 text-black"
                : "border-white/15 bg-white/5 text-zinc-300 hover:border-white/30 hover:text-white"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Vehicles">
        {shown.map((v) => (
          <li key={v.id}>
            <Link
              href={`/drive/${v.id}`}
              onClick={() => trackEvent("vehicle_picked", { vehicle: v.id })}
              style={{ "--accent": v.accent } as React.CSSProperties}
              className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.02] p-5 transition duration-200 hover:-translate-y-0.5 hover:border-[var(--accent)]/70 hover:shadow-[0_10px_40px_-12px_var(--accent)]"
            >
              <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-[var(--accent)] opacity-10 blur-3xl transition group-hover:opacity-25" />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--accent)]">{v.category}</span>
                {v.turbo && (
                  <span className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
                    Turbo
                  </span>
                )}
                {v.recorded && (
                  <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                    Real recording
                  </span>
                )}
                {v.synth && (
                  <span className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
                    Live synth
                  </span>
                )}
              </div>
              <Silhouette kind={v.silhouette} accent={v.accent} className="my-2 h-24 w-full transition duration-300 group-hover:scale-[1.04]" />
              <h2 className="text-xl font-semibold text-white">{v.name}</h2>
              <p className="mt-1 text-sm text-zinc-400">{v.description}</p>
              <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-center">
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">Engine</dt>
                  <dd className="text-sm font-semibold text-zinc-100">{v.layout}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">Power</dt>
                  <dd className="text-sm font-semibold text-zinc-100">~{v.powerHp} hp</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-zinc-500">Redline</dt>
                  <dd className="text-sm font-semibold text-zinc-100">{(v.redlineRpm / 1000).toFixed(1)}k</dd>
                </div>
              </dl>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)]">
                Start engine <span className="transition group-hover:translate-x-1">→</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
