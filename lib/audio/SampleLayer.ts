import type { SampleRef } from "../vehicles/types";
import { blendSamples, rateFor } from "./blend";
import { ramp } from "./util";

interface Loop {
  ref: SampleRef;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/**
 * A set of looping recordings at different RPMs. Every loop runs continuously (starting
 * and stopping sources clicks) and all of them start at the same instant. Each frame,
 * every loop's rate is set to rpm / sampleRpm, so they stay phase-locked, and the two
 * loops bracketing the current RPM are faded in.
 */
export class SampleLayer {
  private readonly loops: Loop[];

  constructor(
    private readonly ctx: AudioContext,
    samples: readonly SampleRef[],
    buffers: Map<string, AudioBuffer>,
    keyOf: (ref: SampleRef) => string,
    destination: AudioNode,
    startAt: number,
  ) {
    this.loops = samples.map((ref) => {
      const source = ctx.createBufferSource();
      source.buffer = buffers.get(keyOf(ref)) ?? null;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(destination);
      source.start(startAt);
      return { ref, source, gain };
    });
  }

  get lowestRpm(): number {
    return this.loops[0].ref.rpm;
  }

  update(rpm: number): void {
    const b = blendSamples(rpm, this.loops.map((l) => l.ref));
    this.loops.forEach((loop, i) => {
      let g = 0;
      if (i === b.lower) g += b.gainLower;
      if (i === b.upper) g += b.gainUpper;
      ramp(loop.gain.gain, g, this.ctx);
      ramp(loop.source.playbackRate, rateFor(rpm, loop.ref.rpm), this.ctx);
    });
  }

  dispose(): void {
    for (const l of this.loops) {
      try {
        l.source.stop();
      } catch {
        /* already stopped */
      }
      l.source.disconnect();
      l.gain.disconnect();
    }
    this.loops.length = 0;
  }
}
