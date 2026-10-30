import { ramp } from "../../lib/audio/util";

/** What the tyres are doing, for their sound. */
export interface TyreSound {
  /** 0-1 how hard they're sliding (a drift, scrubbing wide) or spinning. */
  slide: number;
  /** What's under them. */
  surface: "road" | "loose" | "water";
}

/**
 * The world's sound under the engine: wind that builds with speed (a dull rumble at a
 * cruise, a roar flat out), the road itself (a low drone off the tarmac, a crunch off it),
 * tyres squealing when they slide and, in the rain, the hiss of it falling and of tyres on a
 * wet road. Filtered noise, so it never loops audibly. Created from a tap, like the engine.
 */
export class Ambience {
  private ctx: AudioContext | null = null;
  private wind: { filter: BiquadFilterNode; gain: GainNode } | null = null;
  private rain: { gain: GainNode; spray: GainNode } | null = null;
  private master: GainNode | null = null;
  private road: { drone: GainNode; droneF: BiquadFilterNode; crunch: GainNode; squeal: GainNode; squealF: BiquadFilterNode } | null = null;
  private volume = 0.8;
  private noise: AudioBuffer | null = null;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state !== "running") void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.ctx = ctx;
    const noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    this.noise = noise;
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

    // the road: tyre drone off the tarmac, a coarse crunch off it, and a squeal (a narrow band of
    // noise, wavering) when they slide
    const df = ctx.createBiquadFilter();
    df.type = "bandpass";
    df.frequency.value = 110;
    df.Q.value = 1.1;
    const dg = ctx.createGain();
    dg.gain.value = 0;
    src(0.8).connect(df).connect(dg).connect(this.master);
    const cf = ctx.createBiquadFilter();
    cf.type = "bandpass";
    cf.frequency.value = 1300;
    cf.Q.value = 0.6;
    const cg = ctx.createGain();
    cg.gain.value = 0;
    src(1.3).connect(cf).connect(cg).connect(this.master);
    const qf = ctx.createBiquadFilter();
    qf.type = "bandpass";
    qf.frequency.value = 1050;
    qf.Q.value = 18;
    const qg = ctx.createGain();
    qg.gain.value = 0;
    src(1).connect(qf).connect(qg).connect(this.master);
    this.road = { drone: dg, droneF: df, crunch: cg, squeal: qg, squealF: qf };
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && this.master) ramp(this.master.gain, v, this.ctx, 0.05);
  }

  update(speedKmh: number, raining: boolean, tyres: TyreSound = { slide: 0, surface: "road" }): void {
    const ctx = this.ctx;
    if (!ctx || !this.wind || !this.rain) return;
    const road = this.road;
    if (road) {
      const moving = Math.min(1, speedKmh / 140);
      const onRoad = tyres.surface === "road";
      ramp(road.drone.gain, onRoad ? 0.05 + 0.4 * moving : 0.02, ctx, 0.15);
      ramp(road.droneF.frequency, 80 + 140 * moving, ctx, 0.2);
      ramp(road.crunch.gain, tyres.surface === "loose" ? 0.05 + 0.45 * Math.min(1, speedKmh / 60) : 0, ctx, 0.12);
      // a squeal on tarmac only; it wavers in pitch as the tyres chatter
      const squeal = onRoad && speedKmh > 3 ? Math.min(1, tyres.slide * 1.3) : 0;
      ramp(road.squeal.gain, squeal * squeal * 0.9, ctx, 0.06);
      ramp(road.squealF.frequency, 900 + 300 * tyres.slide + 60 * Math.sin(ctx.currentTime * 23), ctx, 0.05);
    }
    const v = Math.min(1, speedKmh / 260);
    ramp(this.wind.gain.gain, 0.02 + 0.55 * v * v, ctx, 0.2);
    ramp(this.wind.filter.frequency, 220 + 2400 * v, ctx, 0.2);
    ramp(this.rain.gain.gain, raining ? 0.16 : 0, ctx, 0.8);
    ramp(this.rain.spray.gain, raining ? 0.05 + 0.35 * Math.min(1, speedKmh / 120) : 0, ctx, 0.3);
  }

  /** A knock against a guardrail: a thud of steel, louder the harder it was (speed into it, m/s). */
  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || strength < 0.3) return;
    const now = ctx.currentTime;
    const loud = Math.min(1, strength / 12);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 500 + 1500 * loud;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.25 + 0.9 * loud, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18 + 0.35 * loud);
    src.connect(f).connect(g).connect(this.master);
    src.start(now, Math.random() * 3);
    src.stop(now + 0.6);
    // and the ring of the rail
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = 180 + Math.random() * 60;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(0.12 * loud + 0.02, now + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    o.connect(og).connect(this.master);
    o.start(now);
    o.stop(now + 0.55);
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
    this.road = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }
}
