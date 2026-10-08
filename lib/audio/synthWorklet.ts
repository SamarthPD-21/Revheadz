/**
 * Source of the AudioWorkletProcessor behind the synthesized engine. Kept as a
 * string and loaded from a Blob URL so the static export needs no extra file.
 *
 * Model: one short exhaust pulse per cylinder firing (rate = rpm / 60 x cylinders / 2
 * for a four-stroke), each with a decaying envelope, random timing/amplitude jitter
 * and an optional uneven firing order. Filtering happens downstream in the graph.
 */
export const SYNTH_PROCESSOR_NAME = "revheadz-engine-synth";

export const SYNTH_WORKLET_SOURCE = /* js */ `
class EngineSynth extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rpm", defaultValue: 0, minValue: 0, maxValue: 30000, automationRate: "k-rate" },
      { name: "load", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.cyl = o.cylinders || 4;
    this.rough = o.roughness == null ? 0.2 : o.roughness;
    const uneven = o.unevenness || 0;
    this.offsets = [];
    for (let k = 0; k < this.cyl; k++) {
      const swing = k % 2 === 0 ? 1 : -1;
      this.offsets.push(k / this.cyl + (swing * uneven * (0.5 + (k % 4) / 4)) / this.cyl);
    }
    this.cycle = 0;
    this.k = 0;
    this.phase = 0;
    this.pulses = [];
    this.noiseState = 0;
    this.dc = 0;
  }

  spawn(ff, load) {
    if (this.pulses.length >= 24) this.pulses.shift();
    const tf = 1 / Math.max(ff, 20);
    const jitter = 1 + (Math.random() * 2 - 1) * this.rough;
    this.pulses.push({
      t: -Math.random() * this.rough * 0.15 * tf, // random timing jitter
      ff,
      amp: (0.35 + 0.65 * load) * jitter,
      tau1: tf * (0.75 - 0.2 * load),
      tau2: tf * 0.22,
      noise: 0.15 + 0.4 * load,
    });
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    const rpm = parameters.rpm[0];
    const load = parameters.load[0];
    const dt = 1 / sampleRate;
    const step = rpm / 120 * dt; // engine cycles per sample
    const ff = rpm / 120 * this.cyl;
    const drive = 1.3 + 1.4 * load;
    const TWO_PI = 2 * Math.PI;

    for (let i = 0; i < out.length; i++) {
      if (rpm > 20) {
        this.phase += step;
        let next = this.cycle + this.offsets[this.k];
        while (this.phase >= next) {
          this.spawn(ff, load);
          this.k++;
          if (this.k >= this.cyl) { this.k = 0; this.cycle++; }
          next = this.cycle + this.offsets[this.k];
        }
        if (this.cycle >= 64) { this.phase -= this.cycle; this.cycle = 0; }
      }

      this.noiseState += ((Math.random() * 2 - 1) - this.noiseState) * 0.35;
      let s = 0;
      for (let p = this.pulses.length - 1; p >= 0; p--) {
        const q = this.pulses[p];
        if (q.t < 0) { q.t += dt; continue; }
        const e1 = Math.exp(-q.t / q.tau1);
        if (q.t > q.tau1 * 6) { this.pulses.splice(p, 1); continue; }
        const body =
          Math.sin(TWO_PI * q.ff * q.t) * 0.9 +
          Math.sin(TWO_PI * q.ff * 2 * q.t + 0.6) * 0.5 +
          Math.sin(TWO_PI * q.ff * 3 * q.t + 1.1) * 0.3;
        s += (body * e1 + this.noiseState * q.noise * Math.exp(-q.t / q.tau2)) * q.amp;
        q.t += dt;
      }
      out[i] = Math.tanh(s * drive) * 0.6;
    }
    return true;
  }
}
registerProcessor("${SYNTH_PROCESSOR_NAME}", EngineSynth);
`;
