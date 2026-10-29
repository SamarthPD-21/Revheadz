import { ramp } from "../../lib/audio/util";

/**
 * The world's sound under the engine: wind that builds with speed (a dull rumble at a
 * cruise, a roar flat out) and, in the rain, the hiss of it falling and of tyres on a wet
 * road. Filtered noise, so it never loops audibly. Created from a tap, like the engine.
 */
export class Ambience {
  private ctx: AudioContext | null = null;
  private wind: { filter: BiquadFilterNode; gain: GainNode } | null = null;
  private rain: { gain: GainNode; spray: GainNode } | null = null;
  private master: GainNode | null = null;
  private volume = 0.8;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state !== "running") void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.ctx = ctx;
    const noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = noise.getChannelData(0);
    // pinkish noise (Paul Kellet's filter): fuller and softer than white
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
    const src = (rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(ctx.currentTime + Math.random() * 0.1, Math.random() * 3);
      return s;
    };
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    const wf = ctx.createBiquadFilter();
    wf.type = "lowpass";
    wf.frequency.value = 300;
    wf.Q.value = 0.4;
    const wg = ctx.createGain();
    wg.gain.value = 0;
    src(1).connect(wf).connect(wg).connect(this.master);
    this.wind = { filter: wf, gain: wg };

    const rf = ctx.createBiquadFilter();
    rf.type = "highpass";
    rf.frequency.value = 1800;
    const rg = ctx.createGain();
    rg.gain.value = 0;
    src(0.93).connect(rf).connect(rg).connect(this.master);
    const sf = ctx.createBiquadFilter();
    sf.type = "bandpass";
    sf.frequency.value = 900;
    sf.Q.value = 0.7;
    const sg = ctx.createGain();
    sg.gain.value = 0;
    src(1.07).connect(sf).connect(sg).connect(this.master);
    this.rain = { gain: rg, spray: sg };
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && this.master) ramp(this.master.gain, v, this.ctx, 0.05);
  }

  update(speedKmh: number, raining: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.wind || !this.rain) return;
    const v = Math.min(1, speedKmh / 260);
    ramp(this.wind.gain.gain, 0.02 + 0.55 * v * v, ctx, 0.2);
    ramp(this.wind.filter.frequency, 220 + 2400 * v, ctx, 0.2);
    ramp(this.rain.gain.gain, raining ? 0.16 : 0, ctx, 0.8);
    ramp(this.rain.spray.gain, raining ? 0.05 + 0.35 * Math.min(1, speedKmh / 120) : 0, ctx, 0.3);
  }

  suspend(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.wind = this.rain = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }
}
