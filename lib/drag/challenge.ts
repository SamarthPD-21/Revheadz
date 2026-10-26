import { getVehicle } from "../vehicles";
import { classOf } from "./classes";
import { replay, type DriveKey, type DriveLog, type RunResult } from "./race";

/**
 * "Beat my run" links. A drive log is a few dozen numbers, so a whole run fits in a URL: the
 * friend who opens it races that exact run as a ghost. Nothing needs a server, and nothing in
 * the link is trusted: the time it shows is worked out by replaying the inputs, so editing the
 * link can't fake a faster time without actually driving one.
 *
 * Bump REPLAY_VERSION whenever a physics change moves replayed times (see the golden times in
 * tests/determinism.test.ts); older links then say so instead of replaying differently.
 */
export const REPLAY_VERSION = 1;

const KEYS: DriveKey[] = ["launch", "up", "down", "gas+", "gas-", "brake+", "brake-"];
const MAX_EVENTS = 400;

export interface Challenge {
  name: string;
  carId: string;
  log: DriveLog;
}

export interface VerifiedChallenge extends Challenge {
  /** Their run, recomputed from the inputs. */
  result: RunResult;
}

/** The log as it will travel: event times on a 0.1 ms grid (so the link is exact and short). */
export function quantise(log: DriveLog): DriveLog {
  return { assist: log.assist, events: log.events.map(([ms, k]) => [Math.round(ms * 10) / 10, k]) };
}

// URL-safe base64 of UTF-8 (names can have accents or emoji)
function b64url(s: string) {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

export function encodeChallenge(c: Challenge): string {
  // events as a flat list of [time step since the previous event (0.1 ms), key index]
  const flat: number[] = [];
  let prev = 0;
  for (const [ms, k] of quantise(c.log).events) {
    const t = Math.round(ms * 10);
    flat.push(t - prev, KEYS.indexOf(k));
    prev = t;
  }
  return b64url(JSON.stringify({ v: REPLAY_VERSION, n: c.name.slice(0, 16), c: c.carId, a: c.log.assist ? 1 : 0, e: flat }));
}

export type DecodeError = "invalid" | "version" | "car";

export function decodeChallenge(code: string): Challenge | DecodeError {
  let raw: unknown;
  try {
    raw = JSON.parse(unb64url(code));
  } catch {
    return "invalid";
  }
  if (!raw || typeof raw !== "object") return "invalid";
  const o = raw as Record<string, unknown>;
  if (o.v !== REPLAY_VERSION) return typeof o.v === "number" ? "version" : "invalid";
  if (typeof o.c !== "string" || !getVehicle(o.c)) return "car";
  if (!Array.isArray(o.e) || o.e.length % 2 || o.e.length > MAX_EVENTS * 2) return "invalid";
  const events: [number, DriveKey][] = [];
  let t = 0;
  for (let i = 0; i < o.e.length; i += 2) {
    const dt = o.e[i];
    const k = o.e[i + 1];
    if (!Number.isInteger(dt) || !Number.isInteger(k) || k < 0 || k >= KEYS.length) return "invalid";
    // the launch may come before green (a red light), but events never go back in time
    if (i > 0 && dt < 0) return "invalid";
    t += dt;
    events.push([t / 10, KEYS[k]]);
  }
  const name = typeof o.n === "string" && o.n.trim() ? o.n.trim().slice(0, 16) : "A friend";
  return { name, carId: o.c, log: { assist: o.a === 1, events } };
}

/** Replays the challenge to find out what their run really was. */
export function verifyChallenge(c: Challenge): VerifiedChallenge {
  return { ...c, result: replay(getVehicle(c.carId)!, c.log) };
}

/** The link and a short message for sharing a run. Times come from replaying the shared log. */
export function shareRun(origin: string, name: string, carId: string, log: DriveLog) {
  const challenge: Challenge = { name, carId, log: quantise(log) };
  const { result } = verifyChallenge(challenge);
  const cfg = getVehicle(carId)!;
  const url = `${origin}/drag#c=${encodeChallenge(challenge)}`;
  const text = `${(result.elapsedMs / 1000).toFixed(3)} s at ${Math.round(result.trapKmh)} km/h in a ${cfg.name} (${classOf(carId).name} class), reaction ${((result.reactionMs ?? 0) / 1000).toFixed(3)}. Beat it:`;
  return { url, text, result };
}
