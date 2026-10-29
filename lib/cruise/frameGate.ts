/**
 * Frame pacing for a chosen frame rate. The browser calls back once per screen refresh; this
 * says which of those refreshes to draw on so frames come at the chosen rate on average
 * (on a 144 Hz screen, 90 fps draws on most refreshes and skips the rest). It also measures
 * the screen's own refresh interval, since nothing can be drawn faster than that.
 */
export class FrameGate {
  /** The screen's refresh interval, ms (60 Hz until measured). */
  screenMs = 1000 / 60;
  private readonly gaps: number[] = [];
  private lastCall = -1;
  private due = -Infinity;

  /** Call on every refresh with its timestamp; true to draw this one. `fps` 0 draws them all. */
  tick(now: number, fps: number): boolean {
    if (this.lastCall >= 0) {
      const gap = now - this.lastCall;
      // (ignore stalls and a hidden tab's long gaps)
      if (gap > 2 && gap < 50) {
        this.gaps.push(gap);
        if (this.gaps.length > 90) this.gaps.shift();
        if (this.gaps.length >= 20) this.screenMs = [...this.gaps].sort((a, b) => a - b)[Math.floor(this.gaps.length / 2)];
      }
    }
    this.lastCall = now;
    if (!fps) return true;
    const interval = 1000 / fps;
    // a frame is due one interval after the last one was due (so the average holds); draw on
    // the refresh nearest to when it's due, never more than an interval late
    if (now < this.due - this.screenMs * 0.5) return false;
    this.due = Math.max(this.due + interval, now);
    return true;
  }

  /** The frame time to tune the picture for: the chosen rate's, or the screen's if that's slower. */
  targetMs(fps: number): number {
    return Math.max(fps ? 1000 / fps : 0, this.screenMs);
  }
}
