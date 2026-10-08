import type { SynthTone } from "../vehicles/types";
import { SYNTH_PROCESSOR_NAME, SYNTH_WORKLET_SOURCE } from "./synthWorklet";
import { ramp } from "./util";

const loaded = new WeakSet<BaseAudioContext>();

/** Matches the synth's loudness to the sample-based vehicles. */
const SYNTH_LEVEL = 0.5;

/** Procedural engine: no sound files, so it also covers the gap while recordings load. */
export class SynthEngine {
  readonly output: GainNode;
  private node: AudioWorkletNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private disposed = false;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly cylinders: number,
    private readonly tone: SynthTone,
  ) {
    this.output = ctx.createGain();
    this.output.gain.value = 0;
  }

  /** Resolves to null when AudioWorklet is unavailable. */
  static async create(ctx: AudioContext, cylinders: number, tone: SynthTone, destination: AudioNode): Promise<SynthEngine | null> {
    if (!ctx.audioWorklet) return null;
    const synth = new SynthEngine(ctx, cylinders, tone);
    try {
      if (!loaded.has(ctx)) {
        const url = URL.createObjectURL(new Blob([SYNTH_WORKLET_SOURCE], { type: "application/javascript" }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        loaded.add(ctx);
      }
    } catch (e) {
      console.warn("Synth engine unavailable", e);
      return null;
    }
    if (synth.disposed) return null;
    synth.build(destination);
    return synth;
  }

  private build(destination: AudioNode) {
    const { ctx, tone } = this;
    const node = new AudioWorkletNode(ctx, SYNTH_PROCESSOR_NAME, {
      numberOfInputs: 0,
      outputChannelCount: [1],
      processorOptions: { cylinders: this.cylinders, roughness: tone.roughness, unevenness: tone.unevenness },
    });
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 35;
    const exhaust = ctx.createBiquadFilter();
    exhaust.type = "bandpass";
    exhaust.frequency.value = tone.exhaustHz;
    exhaust.Q.value = 1.4;
    const exhaustGain = ctx.createGain();
    exhaustGain.gain.value = 0.8;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = tone.cutoffHz * 0.5;
    const sum = ctx.createGain();

    // exhaust pipe: delayed, phase-inverted, damped reflection from the open end
    const pipeDelay = ctx.createDelay(0.05);
    pipeDelay.delayTime.value = (2 * 1.6) / 343;
    const pipeDamp = ctx.createBiquadFilter();
    pipeDamp.type = "lowpass";
    pipeDamp.frequency.value = 2200;
    const pipeFeedback = ctx.createGain();
    pipeFeedback.gain.value = -0.42;

    node.connect(highpass);
    highpass.connect(sum);
    highpass.connect(pipeDelay);
    pipeDelay.connect(pipeDamp).connect(pipeFeedback);
    pipeFeedback.connect(pipeDelay);
    pipeFeedback.connect(sum);
    highpass.connect(exhaust).connect(exhaustGain).connect(sum);
    sum.connect(lowpass).connect(this.output).connect(destination);
    this.node = node;
    this.lowpass = lowpass;
  }

  update(rpm: number, load: number, audible: boolean): void {
    if (!this.node || !this.lowpass) return;
    const { ctx } = this;
    ramp(this.node.parameters.get("rpm")!, rpm, ctx);
    ramp(this.node.parameters.get("load")!, load, ctx);
    ramp(this.lowpass.frequency, this.tone.cutoffHz * (0.45 + 0.55 * load), ctx);
    ramp(this.output.gain, audible ? SYNTH_LEVEL : 0, ctx);
  }

  dispose(): void {
    this.disposed = true;
    this.node?.disconnect();
    this.lowpass?.disconnect();
    this.output.disconnect();
    this.node = null;
  }
}
