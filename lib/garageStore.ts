"use client";

import { useSyncExternalStore } from "react";

/**
 * Per-browser garage conveniences: favourite vehicles and recently driven ones.
 * Stored in localStorage; every access is guarded so private windows and blocked
 * storage simply behave as an empty garage.
 */
const KEYS = { favourites: "revheadz:favourites", recent: "revheadz:recent" } as const;
type Key = keyof typeof KEYS;

const EMPTY: readonly string[] = [];
const cache: Partial<Record<Key, readonly string[]>> = {};
const listeners = new Set<() => void>();

function read(key: Key): readonly string[] {
  if (cache[key]) return cache[key]!;
  let list: readonly string[] = EMPTY;
  try {
    const raw = localStorage.getItem(KEYS[key]);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* storage unavailable */
  }
  cache[key] = list;
  return list;
}

function write(key: Key, list: readonly string[]) {
  cache[key] = list;
  try {
    localStorage.setItem(KEYS[key], JSON.stringify(list));
  } catch {
    /* storage unavailable: keep it for this page view only */
  }
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEYS.favourites || e.key === KEYS.recent) {
      delete cache.favourites;
      delete cache.recent;
      fn();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function useStoredList(key: Key): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => EMPTY,
  );
}

export function toggleFavourite(id: string): boolean {
  const list = read("favourites");
  const on = !list.includes(id);
  write("favourites", on ? [...list, id] : list.filter((x) => x !== id));
  return on;
}

/** Most recent first, at most six. */
export function markDriven(id: string) {
  write("recent", [id, ...read("recent").filter((x) => x !== id)].slice(0, 6));
}
