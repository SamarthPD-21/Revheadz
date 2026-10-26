/**
 * Keeps a canvas at 60 fps by trading resolution for speed. Fill rate is what limits low-end
 * devices, so the backing store starts capped (lower on phones) and steps down whenever the
 * frame rate stays under 55 fps for two seconds running (one hitch, like a sound decoding,
 * doesn't cost sharpness for the rest of the session).
 */
export class FrameBudget {
  private maxDpr: number;
  private frames = 0;
  private since = performance.now();
  private slowWindows = 0;

  constructor() {
    this.maxDpr = window.matchMedia("(pointer: coarse)").matches ? 1.25 : 1.5;
  }

  /** Call once per frame; returns the device-pixel ratio to draw at. */
  tick(now: number): number {
    this.frames++;
    const elapsed = now - this.since;
    if (elapsed > 1000) {
      const fps = this.frames / (elapsed / 1000);
      this.slowWindows = fps < 55 ? this.slowWindows + 1 : 0;
      if (this.slowWindows >= 2 && this.maxDpr > 0.75) {
        this.maxDpr = Math.max(0.75, this.maxDpr - 0.25);
        this.slowWindows = 0;
      }
      this.frames = 0;
      this.since = now;
    }
    return Math.min(this.maxDpr, window.devicePixelRatio || 1);
  }
}
