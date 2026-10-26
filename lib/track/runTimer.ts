/**
 * Timing for the proving ground. Every run from a standstill is timed, like a performance test:
 * speed splits (0-100, 100-200 km/h...), distance splits with the speed at each line (60 ft,
 * 1/8 and 1/4 mile...) and the top speed.
 *
 * The page samples the car once a frame; crossings are interpolated between samples, so splits
 * are good to about a millisecond rather than a frame.
 */

export interface SplitDef {
  id: string;
  label: string;
}

export const SPEED_SPLITS: (SplitDef & { from: number; to: number })[] = [
  { id: "0-100", label: "0–100 km/h", from: 0, to: 100 },
  { id: "0-200", label: "0–200 km/h", from: 0, to: 200 },
  { id: "100-200", label: "100–200 km/h", from: 100, to: 200 },
  { id: "0-300", label: "0–300 km/h", from: 0, to: 300 },
];

export const DISTANCE_SPLITS: (SplitDef & { m: number })[] = [
  { id: "60ft", label: "60 ft", m: 18.288 },
  { id: "1/8", label: "1/8 mile", m: 201.168 },
  { id: "1/4", label: "1/4 mile", m: 402.336 },
  { id: "1/2", label: "1/2 mile", m: 804.672 },
  { id: "1km", label: "1 km", m: 1000 },
];

export interface SplitResult {
  ms: number;
  /** Speed at the line, for distance splits. */
  kmh?: number;
}

/** Below this the car counts as stopped; a run starts when it moves off again. */
const STOPPED_KMH = 0.5;
/** How long the car must sit still before the next launch is timed. */
const ARM_S = 0.3;

export class RunTimer {
  /** True while a run is being timed. */
  running = false;
  /** True when stopped long enough that the next launch starts a run. */
  armed = false;
  /** Odometer reading where the current (or last) run started, m. */
  startX: number | null = null;
  results: Record<string, SplitResult> = {};
  topKmh = 0;

  private startT = 0;
  private stillFor = 0;
  private prev: { t: number; x: number; kmh: number } | null = null;
  private crossed: Record<number, number> = {};

  /**
   * Feed one sample: time (s), odometer (m), speed (km/h). Returns the ids of splits completed
   * by this sample (empty most frames).
   */
  update(t: number, x: number, kmh: number): string[] {
    const prev = this.prev;
    this.prev = { t, x, kmh };
    if (!prev) {
      this.armed = kmh < STOPPED_KMH;
      return [];
    }
    const done: string[] = [];
    // linear interpolation between the last sample and this one, at fraction f
    const at = (f: number) => ({ t: prev.t + (t - prev.t) * f, x: prev.x + (x - prev.x) * f, kmh: prev.kmh + (kmh - prev.kmh) * f });

    if (kmh < STOPPED_KMH) {
      this.stillFor += t - prev.t;
      if (this.running) this.running = false;
      if (this.stillFor >= ARM_S) this.armed = true;
      return done;
    }
    this.stillFor = 0;

    if (!this.running && this.armed && prev.kmh < STOPPED_KMH) {
      // moving off: a new run starts where the speed passed the threshold
      const s = at((STOPPED_KMH - prev.kmh) / (kmh - prev.kmh));
      this.running = true;
      this.armed = false;
      this.startT = s.t;
      this.startX = s.x;
      this.results = {};
      this.topKmh = kmh;
      this.crossed = { 0: s.t };
      return done;
    }
    if (!this.running) return done;

    this.topKmh = Math.max(this.topKmh, kmh);
    // speed splits: first time each speed is passed on the way up
    for (const v of new Set(SPEED_SPLITS.flatMap((s) => [s.from, s.to]))) {
      if (this.crossed[v] === undefined && prev.kmh < v && kmh >= v) this.crossed[v] = at((v - prev.kmh) / (kmh - prev.kmh)).t;
    }
    for (const s of SPEED_SPLITS) {
      const a = this.crossed[s.from];
      const b = this.crossed[s.to];
      if (!this.results[s.id] && a !== undefined && b !== undefined) {
        this.results[s.id] = { ms: (b - a) * 1000 };
        done.push(s.id);
      }
    }
    // distance splits, with the speed at the line
    const start = this.startX!;
    for (const s of DISTANCE_SPLITS) {
      const line = start + s.m;
      if (!this.results[s.id] && prev.x < line && x >= line) {
        const c = at((line - prev.x) / (x - prev.x));
        this.results[s.id] = { ms: (c.t - this.startT) * 1000, kmh: c.kmh };
        done.push(s.id);
      }
    }
    return done;
  }
}
