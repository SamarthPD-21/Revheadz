import { rateShift, type Tone } from "../drag/rating";

/**
 * A running time slip for the proving ground: every shift and split of the current run, with
 * the time since launch. Upshifts are rated the way the drag race rates them, against the car's
 * shift light: how long after the revs reached it the shift came, or how far short of it.
 *
 * The page samples the revs once a frame; the moment they cross the shift light is interpolated
 * between samples, like the run timer's splits.
 */

export interface LogEntry {
  /** Time since launch, ms. */
  ms: number;
  what: string;
  /** For a rated shift: Perfect, Great, Good, Early or Late. */
  rating?: string;
  note?: string;
  tone?: Tone;
}

/** A shift this long after the light was missed altogether (the drag race shifts for you by then). */
const MISSED_MS = 900;

export class ShiftLog {
  entries: LogEntry[] = [];
  private t0 = 0;
  private gear = 0;
  private cueAt: number | null = null;
  private peak = 0;
  private prev: { t: number; rpm: number } | null = null;

  /** @param cue the shift light's rpm */
  constructor(readonly cue: number) {}

  /** A run started at `t` (s) in `gear`. */
  start(t: number, gear: number) {
    this.t0 = t;
    this.gear = gear;
    this.entries = [{ ms: 0, what: "Launch" }];
    this.resetGear();
  }

  /** One sample per frame during a run: time (s), revs and the gear engaged. */
  sample(t: number, rpm: number, gear: number) {
    this.gear = gear;
    const prev = this.prev;
    this.prev = { t, rpm };
    this.peak = Math.max(this.peak, rpm);
    if (this.cueAt !== null || rpm < this.cue) return;
    this.cueAt = prev && prev.rpm < this.cue ? prev.t + ((t - prev.t) * (this.cue - prev.rpm)) / (rpm - prev.rpm) : t;
  }

  /** A gear change into `to` at `t` (s). Returns the entry it logged. */
  shift(t: number, to: number): LogEntry {
    const from = this.gear;
    const entry: LogEntry = { ms: this.ms(t), what: `${from || "N"}→${to || "N"}` };
    if (to > from && from > 0) {
      if (this.cueAt === null) {
        entry.rating = "Early";
        entry.note = `${Math.round((this.cue - this.peak) / 10) * 10} rpm short`;
        entry.tone = "bad";
      } else {
        const late = (t - this.cueAt) * 1000;
        const r = rateShift(late);
        entry.rating = r.title.replace(" shift", "");
        entry.note = late >= MISSED_MS ? "on the limiter" : `+${Math.round(late)} ms`;
        entry.tone = r.tone;
      }
    }
    this.gear = to;
    this.resetGear();
    this.entries.push(entry);
    return entry;
  }

  /** A split crossed at `ms` since launch. */
  split(ms: number, what: string, note?: string): LogEntry {
    const entry = { ms, what, note };
    // splits are interpolated, so one can land just before a shift logged this frame
    let i = this.entries.length;
    while (i > 0 && this.entries[i - 1].ms > ms) i--;
    this.entries.splice(i, 0, entry);
    return entry;
  }

  private ms(t: number) {
    return Math.max(0, (t - this.t0) * 1000);
  }

  private resetGear() {
    this.cueAt = null;
    this.peak = 0;
    this.prev = null;
  }
}
