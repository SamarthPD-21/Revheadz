"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "../lib/analytics";

export interface PickerVehicle {
  id: string;
  name: string;
  make?: string;
  year?: string;
  layout: string;
  accent: string;
}

/**
 * The drive screen's title: shows the current vehicle and opens a searchable list of the
 * whole garage (V key, or click). Arrow keys move, Enter drives, Esc closes.
 */
export function VehiclePicker({ current, vehicles, eyebrow }: { current: PickerVehicle; vehicles: PickerVehicle[]; eyebrow: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = vehicles.filter((v) => {
    const h = `${v.name} ${v.make ?? ""} ${v.year ?? ""} ${v.layout}`.toLowerCase();
    return words.every((w) => h.includes(w));
  });

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const choose = (v: PickerVehicle) => {
    close();
    if (v.id === current.id) return;
    trackEvent("vehicle_picked", { vehicle: v.id, via: "picker" });
    router.push(`/drive/${v.id}`);
  };
  const show = () => {
    setActive(Math.max(0, vehicles.findIndex((v) => v.id === current.id)));
    setOpen(true);
  };
  const latest = useRef({ show, open });
  useEffect(() => {
    latest.current = { show, open };
  });

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  // V opens the picker (driving keys never use V)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyV" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      if (!latest.current.open) latest.current.show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => (open ? close() : show())}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Switch vehicle (V)"
        className="picker-trigger group flex min-w-0 max-w-full items-center gap-2 rounded-xl px-2 py-1 text-left transition hover:bg-white/5 active:scale-[0.98]"
      >
        <span className="min-w-0">
          <span className="block truncate text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: current.accent }}>
            {eyebrow}
          </span>
          <span className="block truncate text-sm font-bold text-zinc-100 sm:text-base">{current.name}</span>
        </span>
        <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition group-hover:text-zinc-200 ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="picker-panel" role="dialog" aria-label="Switch vehicle">
          <div className="search m-2 !h-10">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(shown.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter" && shown[active]) choose(shown[active]);
                e.stopPropagation(); // keep driving keys (W, S, E...) out of the simulator while typing
              }}
              placeholder="Find a machine…"
              aria-label="Search vehicles"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-500"
            />
          </div>
          <ul ref={listRef} className="max-h-[min(60vh,420px)] overflow-y-auto px-1.5 pb-1.5" role="listbox" aria-label="Vehicles">
            {shown.map((v, i) => (
              <li key={v.id} role="option" aria-selected={i === active} data-i={i}>
                <button
                  type="button"
                  onClick={() => choose(v)}
                  onPointerEnter={() => setActive(i)}
                  className={`picker-item ${i === active ? "picker-item-on" : ""}`}
                  style={{ "--accent": v.accent } as React.CSSProperties}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  <span className="shrink-0 text-[11px] text-zinc-500">{v.id === current.id ? "driving" : v.layout}</span>
                </button>
              </li>
            ))}
            {!shown.length && <li className="px-3 py-6 text-center text-sm text-zinc-500">Nothing matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
