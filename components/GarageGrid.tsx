"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "../lib/analytics";
import { playPreview, stopPreview, type PreviewSounds } from "../lib/audio/preview";
import { toggleFavourite, useStoredList } from "../lib/garageStore";
import type { Silhouette as Kind } from "../lib/vehicles/types";
import { Silhouette } from "./Silhouette";

export interface GarageVehicle {
  id: string;
  name: string;
  type: "car" | "bike";
  description: string;
  engineType: string;
  category: string;
  layout: string;
  displacement: string;
  powerHp: number;
  redlineRpm: number;
  accent: string;
  silhouette: Kind;
  turbo: boolean;
  recorded: boolean;
  make?: string;
  year?: string;
  /** Folder the vehicle's sounds are served from. */
  base: string;
  preview: PreviewSounds | null;
}

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "car", label: "Cars", test: (v: GarageVehicle) => v.type === "car" },
  { id: "bike", label: "Bikes", test: (v: GarageVehicle) => v.type === "bike" },
  { id: "turbo", label: "Forced induction", test: (v: GarageVehicle) => v.turbo },
  { id: "na", label: "Naturally aspirated", test: (v: GarageVehicle) => !v.turbo },
] as const;

type Filter = (typeof FILTERS)[number]["id"] | "favourites";

const SORTS = {
  featured: { label: "Featured", cmp: () => 0 },
  power: { label: "Most power", cmp: (a: GarageVehicle, b: GarageVehicle) => b.powerHp - a.powerHp },
  redline: { label: "Highest redline", cmp: (a: GarageVehicle, b: GarageVehicle) => b.redlineRpm - a.redlineRpm },
  year: { label: "Newest", cmp: (a: GarageVehicle, b: GarageVehicle) => Number(b.year?.slice(0, 4) ?? 0) - Number(a.year?.slice(0, 4) ?? 0) },
  name: { label: "A to Z", cmp: (a: GarageVehicle, b: GarageVehicle) => a.name.localeCompare(b.name) },
} as const;
type Sort = keyof typeof SORTS;

/** The rev meter on each card spans 0 to this many rpm. */
const METER_MAX_RPM = 19000;

const haystack = (v: GarageVehicle) =>
  [v.name, v.make, v.year, v.engineType, v.category, v.layout, v.displacement, v.type === "bike" ? "bike motorcycle" : "car"]
    .join(" ")
    .toLowerCase();

/**
 * `base` is where a card goes: the playground's drive screen, or another mode's. `betaBikes`
 * marks the bikes as still in beta there (Cruise).
 */
export function GarageGrid({ vehicles, base = "/drive", betaBikes = false }: { vehicles: GarageVehicle[]; base?: string; betaBikes?: boolean }) {
  const [chosenFilter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("featured");
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const favourites = useStoredList("favourites");
  const recentIds = useStoredList("recent");
  // a favourites filter with nothing left in it falls back to everything
  const filter: Filter = chosenFilter === "favourites" && !favourites.length ? "all" : chosenFilter;
  const searchRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const byId = useMemo(() => new Map(vehicles.map((v) => [v.id, v])), [vehicles]);
  const recent = recentIds.map((id) => byId.get(id)).filter((v): v is GarageVehicle => Boolean(v));

  const testFor = (f: Filter) => (f === "favourites" ? (v: GarageVehicle) => favourites.includes(v.id) : FILTERS.find((x) => x.id === f)!.test);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (v: GarageVehicle) => {
    const h = haystack(v);
    return words.every((w) => h.includes(w));
  };
  const shown = vehicles.filter((v) => testFor(filter)(v) && matches(v)).sort(SORTS[sort].cmp);

  // "/" focuses search, Esc clears it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => () => stopPreview(), []);

  const go = (v: GarageVehicle, via: string) => {
    stopPreview();
    trackEvent("vehicle_picked", { vehicle: v.id, via });
    router.push(`/drive/${v.id}`);
  };
  const random = () => {
    const pool = shown.length ? shown : vehicles;
    go(pool[Math.floor(Math.random() * pool.length)], "random");
  };
  const preview = (v: GarageVehicle) => {
    if (!v.preview) return;
    if (playing === v.id) {
      stopPreview();
      return;
    }
    setPlaying(v.id);
    trackEvent("sound_preview", { vehicle: v.id });
    void playPreview(v.base, v.preview, () => setPlaying((p) => (p === v.id ? null : p)));
  };

  const chips: { id: Filter; label: string; n: number }[] = [
    ...FILTERS.map((f) => ({ id: f.id as Filter, label: f.label, n: vehicles.filter(f.test).length })),
    ...(favourites.length ? [{ id: "favourites" as Filter, label: "♥ Favourites", n: favourites.filter((id) => byId.has(id)).length }] : []),
  ];

  return (
    <>
      {recent.length > 0 && (
        <section className="mb-8" aria-label="Recently driven">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Jump back in</h2>
          <ul className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
            {recent.map((v) => (
              <li key={v.id} className="shrink-0">
                <Link
                  href={`${base}/${v.id}`}
                  onClick={() => trackEvent("vehicle_picked", { vehicle: v.id, via: "recent" })}
                  className="recent-pill"
                  style={{ "--accent": v.accent } as React.CSSProperties}
                >
                  <span className="h-2 w-2 rounded-full bg-[var(--accent)]" aria-hidden />
                  {v.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="garage-toolbar sticky top-0 z-20 -mx-4 mb-6 space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <label className="search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                } else if (e.key === "Enter" && shown.length) go(shown[0], "search");
              }}
              placeholder="Search Ferrari, V12, turbo, 1998…"
              aria-label="Search vehicles"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-zinc-500"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} className="text-zinc-400 hover:text-white" aria-label="Clear search">
                ✕
              </button>
            ) : (
              <kbd className="keycap hidden pointer-fine:inline-block">/</kbd>
            )}
          </label>
          <label className="select min-w-0 flex-1 sm:flex-none">
            <span className="sr-only">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort vehicles">
              {Object.entries(SORTS).map(([k, s]) => (
                <option key={k} value={k}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={random} className="chip shrink-0 gap-2" title="Jump into a random machine" aria-label="Surprise me: random vehicle">
            <DiceIcon />
            <span className="hidden md:inline">Surprise me</span>
          </button>
        </div>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Filter vehicles">
          {chips.map((f) => {
            const on = filter === f.id;
            return (
              <button key={f.id} type="button" aria-pressed={on} onClick={() => setFilter(f.id)} className={`chip shrink-0 ${on ? "chip-on" : ""}`}>
                {f.label}
                <span className={`chip-count ${on ? "text-black/60" : "text-zinc-500"}`}>{f.n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-white/10 py-16 text-center text-zinc-400">
          <p>No machines match “{query}”.</p>
          <button
            type="button"
            className="chip mt-4"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            Show everything
          </button>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Vehicles">
          {shown.map((v, i) => {
            const fav = favourites.includes(v.id);
            const isPlaying = playing === v.id;
            return (
              <li key={v.id} className="card-enter" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                <article
                  style={{ "--accent": v.accent, "--rev": Math.min(1, v.redlineRpm / METER_MAX_RPM) } as React.CSSProperties}
                  className="vehicle-card group"
                  data-playing={isPlaying ? "1" : undefined}
                >
                  <div className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-[var(--accent)] opacity-[0.08] blur-3xl transition duration-500 group-hover:opacity-25" />
                  <div className="relative flex items-center gap-2">
                    <span className="truncate text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--accent)]">
                      {v.make ?? v.category}
                      {v.year && <span className="ml-1.5 text-zinc-500">{v.year}</span>}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      {v.turbo && <span className="tag">Boost</span>}
                      {v.recorded && (
                        <span className="tag border-emerald-400/30 text-emerald-300" title="Real engine recording">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                          Real
                        </span>
                      )}
                      <button
                        type="button"
                        className="card-btn"
                        aria-pressed={fav}
                        aria-label={fav ? `Remove ${v.name} from favourites` : `Add ${v.name} to favourites`}
                        title={fav ? "Remove from favourites" : "Add to favourites"}
                        onClick={() => {
                          const on = toggleFavourite(v.id);
                          trackEvent("favourite", { vehicle: v.id, on: on ? 1 : 0 });
                        }}
                      >
                        <HeartIcon on={fav} />
                      </button>
                    </span>
                  </div>
                  <div className="relative my-1">
                    <div className="pointer-events-none absolute inset-x-8 bottom-1 h-6 rounded-full bg-[var(--accent)] opacity-0 blur-xl transition duration-500 group-hover:opacity-30" />
                    <Silhouette kind={v.silhouette} accent={v.accent} className="vehicle-silhouette relative h-24 w-full" />
                    {v.preview && (
                      <button
                        type="button"
                        className="card-btn preview-btn"
                        aria-pressed={isPlaying}
                        aria-label={isPlaying ? `Stop ${v.name} preview` : `Hear ${v.name} rev`}
                        title={isPlaying ? "Stop" : "Hear it rev"}
                        onClick={() => preview(v)}
                      >
                        {isPlaying ? <Bars /> : <PlayIcon />}
                        <span className="text-[11px] font-semibold">{isPlaying ? "Revving" : "Hear it"}</span>
                      </button>
                    )}
                  </div>
                  <h2 className="text-lg font-semibold text-white">
                    <Link
                      href={`${base}/${v.id}`}
                      onClick={() => {
                        stopPreview();
                        trackEvent("vehicle_picked", { vehicle: v.id });
                      }}
                      className="card-link inline-flex items-center gap-1.5 outline-none"
                    >
                      {v.name}
                      {betaBikes && v.type === "bike" && (
                        <span className="beta-tag" title="Bikes are in beta here: their riding and models are still being tuned">
                          Beta
                        </span>
                      )}
                      <svg viewBox="0 0 16 16" className="card-go h-4 w-4 text-[var(--accent)]" aria-hidden>
                        <path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </Link>
                  </h2>
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{v.description}</p>

                  <div className="mt-auto pt-4">
                    <div className="flex items-baseline justify-between gap-3 text-xs text-zinc-400">
                      <span className="truncate font-medium text-zinc-200">
                        {v.layout}
                        {!v.layout.includes(v.displacement) && <span className="text-zinc-500"> · {v.displacement}</span>}
                      </span>
                      <span className="shrink-0">
                        <b className="font-semibold text-zinc-100">{v.powerHp.toLocaleString("en-US")}</b> hp
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
                </article>
              </li>
            );
          })}
        </ul>
      )}
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

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden>
      <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M13.2 13.2L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function HeartIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path
        d="M10 16.5s-6.5-3.9-6.5-8.6A3.6 3.6 0 0110 5.6a3.6 3.6 0 016.5 2.3c0 4.7-6.5 8.6-6.5 8.6z"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden>
      <path d="M6 4.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

/** Little animated equaliser shown while a preview plays. */
function Bars() {
  return (
    <span className="eq" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
