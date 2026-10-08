import type { IgnitionState } from "./types";

/** Slow-changing state the React UI subscribes to (never rpm/speed). */
export interface LowFreqState {
  gear: number;
  ignition: IgnitionState;
}

export class LowFreqStore {
  private snapshot: LowFreqState = { gear: 0, ignition: "off" };
  private listeners = new Set<() => void>();

  getSnapshot = (): LowFreqState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Publishes only when something actually changed, so snapshots stay referentially stable. */
  set(gear: number, ignition: IgnitionState): void {
    if (gear === this.snapshot.gear && ignition === this.snapshot.ignition) return;
    this.snapshot = { gear, ignition };
    this.listeners.forEach((l) => l());
  }
}
