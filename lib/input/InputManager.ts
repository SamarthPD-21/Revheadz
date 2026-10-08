import type { SimInput } from "../sim/types";

export interface InputHandlers {
  ignition(): void;
  shiftUp(): void;
  shiftDown(): void;
  neutral(): void;
}

const BLIP_MS = 160;
const BLIP_THROTTLE = 0.65;

const THROTTLE_KEYS = new Set(["KeyW", "ArrowUp"]);
const BRAKE_KEYS = new Set(["KeyS", "ArrowDown"]);
const HANDLED = new Set([...THROTTLE_KEYS, ...BRAKE_KEYS, "KeyE", "KeyQ", "KeyN", "KeyI", "Space"]);

/**
 * Turns keyboard and on-screen controls into throttle/brake levels and discrete
 * commands. One code path serves mouse and touch (pointer events in the UI).
 */
export class InputManager {
  private keys = new Set<string>();
  private touchThrottle = 0;
  private touchBrake = false;
  private blipUntil = 0;
  private attached = false;

  constructor(private readonly handlers: InputHandlers) {}

  attach(target: Window = window): void {
    if (this.attached) return;
    this.attached = true;
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.clear);
  }

  detach(target: Window = window): void {
    if (!this.attached) return;
    this.attached = false;
    target.removeEventListener("keydown", this.onKeyDown);
    target.removeEventListener("keyup", this.onKeyUp);
    target.removeEventListener("blur", this.clear);
    this.clear();
  }

  setTouchThrottle(v: number): void {
    this.touchThrottle = Math.min(1, Math.max(0, v));
  }

  setTouchBrake(on: boolean): void {
    this.touchBrake = on;
  }

  /** Current brake level (for the telemetry display). */
  brakeLevel(): number {
    if (this.touchBrake) return 1;
    for (const k of BRAKE_KEYS) if (this.keys.has(k)) return 1;
    return 0;
  }

  blip(now = performance.now()): void {
    this.blipUntil = now + BLIP_MS;
  }

  /** Writes the current levels into the simulation input. */
  apply(out: SimInput, now = performance.now()): void {
    let throttle = this.touchThrottle;
    for (const k of THROTTLE_KEYS) if (this.keys.has(k)) throttle = 1;
    if (now < this.blipUntil) throttle = Math.max(throttle, BLIP_THROTTLE);
    let brake = this.touchBrake;
    for (const k of BRAKE_KEYS) if (this.keys.has(k)) brake = true;
    out.throttle = throttle;
    out.brake = brake ? 1 : 0;
  }

  private clear = () => {
    this.keys.clear();
    this.touchThrottle = 0;
    this.touchBrake = false;
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !HANDLED.has(e.code)) return;
    // Let focused form controls (e.g. the volume slider) keep their arrow keys.
    const el = e.target as HTMLElement | null;
    if (el?.tagName === "INPUT" && e.code.startsWith("Arrow")) return;
    e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
    switch (e.code) {
      case "KeyE": this.handlers.shiftUp(); break;
      case "KeyQ": this.handlers.shiftDown(); break;
      case "KeyN": this.handlers.neutral(); break;
      case "KeyI": this.handlers.ignition(); break;
      case "Space": this.blip(); break;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!HANDLED.has(e.code)) return;
    if (e.code === "Space") e.preventDefault(); // stop a focused button "clicking" on space-up
    this.keys.delete(e.code);
  };
}
