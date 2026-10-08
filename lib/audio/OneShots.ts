import { pick } from "./util";

export interface OneShotBuffers {
  start: AudioBuffer;
  stop: AudioBuffer;
  shift: AudioBuffer[];
  backfire: AudioBuffer[];
  blowoff: AudioBuffer[];
}

export type OneShotKind = "start" | "stop" | "shift" | "backfire" | "blowoff";

const MAX_SIMULTANEOUS = 4;

/** Fire-and-forget sounds: starter, stop, gear shifts, backfire pops. */
export class OneShots {
  private active = new Set<AudioBufferSourceNode>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly buffers: OneShotBuffers,
    private readonly destination: AudioNode,
  ) {}

  play(kind: OneShotKind, opts?: { gain?: number; rate?: number }): void {
    if (this.active.size >= MAX_SIMULTANEOUS) return;
    const b = this.buffers;
    const list = kind === "start" ? [b.start] : kind === "stop" ? [b.stop] : b[kind];
    if (!list.length) return;
    const buffer = kind === "shift" ? list[0] : pick(list);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    if (kind === "backfire") {
      // random pitch (+-8%) and level so repeats don't sound copied
      src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.08;
      gain.gain.value = 0.6 + Math.random() * 0.4;
    } else if (kind === "blowoff") {
      gain.gain.value = 0.8 + Math.random() * 0.2;
    } else if (kind === "shift") {
      // a subtle, consistent gearbox clunk: the engine note change carries the shift
      gain.gain.value = 0.4;
    }
    if (opts?.gain !== undefined) gain.gain.value *= opts.gain;
    if (opts?.rate !== undefined) src.playbackRate.value *= opts.rate;
    src.connect(gain).connect(this.destination);
    this.active.add(src);
    src.onended = () => {
      this.active.delete(src);
      src.disconnect();
      gain.disconnect();
    };
    src.start();
  }

  dispose(): void {
    for (const s of this.active) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* ended */
      }
      s.disconnect();
    }
    this.active.clear();
  }
}
