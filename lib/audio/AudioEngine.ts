import { decodeAll, prefetch } from "../assets/Loader";
import type { SimEvent, SimState } from "../sim/types";
import { referencedSoundFiles, vehicleBaseUrl } from "../vehicles";
import type { AudioConfig, SampleRef, VehicleConfig } from "../vehicles/types";
import { equalPower, idleBlend, rateFor } from "./blend";
import { OneShots, type OneShotBuffers, type OneShotKind } from "./OneShots";
import {
  proceduralPop,
  proceduralShift,
  proceduralStart,
  proceduralStop,
} from "./proceduralOneShots";
import { SampleLayer } from "./SampleLayer";
import { SynthEngine } from "./SynthEngine";
import { dbToGain, ramp } from "./util";

const FALLBACK_TONE = { exhaustHz: 600, cutoffHz: 4500, roughness: 0.25, unevenness: 0.1 };

type Status = "idle" | "loading" | "ready" | "error";

/**
 * Web Audio graph for one vehicle.
 *
 *   loops -> gain -> layer bus --\
 *   on-load bus  -> load crossfade -> loops bus --\
 *   off-load bus -/                        idle --+-> low-pass -> compressor -> master -> speakers
 *   one-shots ----------------------------------------^
 *
 * The AudioContext is created and resumed only inside `unlock()`, which the
 * ignition button calls from its tap handler (browser autoplay rules).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private onBus: GainNode | null = null;
  private offBus: GainNode | null = null;
  private loopsBus: GainNode | null = null;
  private idleBus: GainNode | null = null;
  private engineBus: GainNode | null = null; // dips during rev-limiter fuel cut
  private onLayer: SampleLayer | null = null;
  private offLayer: SampleLayer | null = null;
  private idleSource: AudioBufferSourceNode | null = null;
  private idleSourceGain: GainNode | null = null;
  private idleRef: SampleRef | null = null;
  private synth: SynthEngine | null = null;
  private synthRetiring = false;
  private oneShots: OneShots | null = null;
  private turbo: { whistle: OscillatorNode; whistle2: OscillatorNode; whistleGain: GainNode; hiss: AudioBufferSourceNode; hissFilter: BiquadFilterNode; hissGain: GainNode } | null = null;
  private volume = 0.8;
  private disposed = false;
  private wasRunning = false;
  private status: Status = "idle";
  private statusListeners = new Set<(s: Status) => void>();
  private readonly onVisibility = () => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (document.hidden) {
      this.wasRunning = ctx.state === "running";
      void ctx.suspend();
    } else if (this.wasRunning) {
      void ctx.resume();
    }
  };

  /** The sound set this engine plays: the vehicle's main one, or its generated alternative. */
  private readonly audio: AudioConfig;

  constructor(private readonly cfg: VehicleConfig, audio?: AudioConfig) {
    this.audio = audio ?? cfg.audio;
  }

  /** Starts downloading the sounds and watching tab visibility. Pair with dispose(); may be repeated. */
  attach(): void {
    this.disposed = false;
    // Download right away; decoding waits for the AudioContext, which needs a tap.
    void prefetch(this.soundUrls()).catch(() => undefined);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** True once a user gesture has created the AudioContext. */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  get loadStatus(): Status {
    return this.status;
  }

  onStatus(listener: (s: Status) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Resolves once sounds are decoded (or failed), or after `timeoutMs`, whichever comes first. */
  whenReady(timeoutMs: number): Promise<void> {
    if (this.status === "ready" || this.status === "error") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = this.onStatus((s) => (s === "ready" || s === "error") && done());
      const timer = setTimeout(done, timeoutMs);
    });
  }

  private setStatus(s: Status) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private soundUrls(): string[] {
    const base = `${vehicleBaseUrl(this.cfg.id)}/sounds/`;
    return referencedSoundFiles(this.cfg, this.audio).map((f) => base + f);
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: "interactive" });
      this.buildGraph(this.ctx);
      void this.load(this.ctx);
    }
    if (this.ctx.state !== "running") void this.ctx.resume();
  }

  private buildGraph(ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = this.volume * dbToGain(this.audio.masterGainDb);
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.15;
    this.compressor.connect(this.master).connect(ctx.destination);

    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpass.frequency.value = 6000;
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0;
    this.lowpass.connect(this.engineBus).connect(this.compressor);

    this.loopsBus = ctx.createGain();
    this.idleBus = ctx.createGain();
    this.onBus = ctx.createGain();
    this.offBus = ctx.createGain();
    this.onBus.connect(this.loopsBus);
    this.offBus.connect(this.loopsBus);
    this.loopsBus.connect(this.lowpass);
    this.idleBus.connect(this.lowpass);
    if (this.cfg.turbo) this.buildTurbo(ctx);
  }

  /**
   * Live turbo layer: the compressor's whistle (pitch rises with boost and shaft speed) and
   * the hiss of intake air, both driven by the simulated boost each frame. It bypasses the
   * engine's low-pass so it stays crisp, like hearing the turbo from the driver's seat.
   */
  private buildTurbo(ctx: AudioContext) {
    const whistle = ctx.createOscillator();
    whistle.type = "sine";
    whistle.frequency.value = 1500;
    const whistle2 = ctx.createOscillator();
    whistle2.type = "triangle";
    whistle2.frequency.value = 3000;
    const w2 = ctx.createGain();
    w2.gain.value = 0.25;
    const whistleGain = ctx.createGain();
    whistleGain.gain.value = 0;
    whistle.connect(whistleGain);
    whistle2.connect(w2).connect(whistleGain);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const hiss = ctx.createBufferSource();
    hiss.buffer = noise;
    hiss.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = "bandpass";
    hissFilter.frequency.value = 3000;
    hissFilter.Q.value = 1.4;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;
    hiss.connect(hissFilter).connect(hissGain);

    const bus = ctx.createGain();
    bus.gain.value = 1;
    whistleGain.connect(bus);
    hissGain.connect(bus);
    bus.connect(this.compressor!);
    const at = ctx.currentTime + 0.02;
    whistle.start(at);
    whistle2.start(at);
    hiss.start(at);
    this.turbo = { whistle, whistle2, whistleGain, hiss, hissFilter, hissGain };
  }

  private updateTurbo(ctx: AudioContext, s: SimState) {
    const t = this.turbo;
    if (!t) return;
    const audible = s.ignition === "running" ? 1 : 0;
    const boost = s.boost;
    const shaft = Math.min(1, s.rpm / this.cfg.engine.redlineRpm);
    const f = 1400 + 5200 * boost + 1400 * shaft;
    ramp(t.whistle.frequency, f, ctx, 0.05);
    ramp(t.whistle2.frequency, f * 2.02, ctx, 0.05);
    ramp(t.whistleGain.gain, audible * 0.045 * Math.pow(boost, 1.4) * (0.5 + 0.5 * s.throttle), ctx, 0.04);
    ramp(t.hissFilter.frequency, 2200 + 4200 * boost, ctx, 0.05);
    ramp(t.hissGain.gain, audible * 0.09 * boost * (0.35 + 0.65 * s.throttle), ctx, 0.04);
  }

  private async load(ctx: AudioContext) {
    this.setStatus("loading");
    const cfg = this.cfg;
    const compressor = this.compressor!;
    const tone = this.audio.synth ?? FALLBACK_TONE;

    // The synth is the instant sound while recordings load (and the whole engine for synth vehicles).
    const synthPromise = SynthEngine.create(ctx, cfg.engine.cylinders, tone, this.lowpass!).then((s) => {
      if (this.disposed) s?.dispose();
      else this.synth = s;
    });

    try {
      const a = this.audio;
      const proc = this.proceduralOneShots(ctx);
      if (a.mode === "samples") {
        const base = `${vehicleBaseUrl(cfg.id)}/sounds/`;
        const buffers = await decodeAll(ctx, referencedSoundFiles(cfg, a).map((f) => base + f));
        if (this.disposed) return;
        const keyOf = (r: SampleRef) => base + r.file;
        // One shared start time keeps every loop on the same crank angle (phase-locked).
        const startAt = ctx.currentTime + 0.05;
        this.onLayer = new SampleLayer(ctx, a.onLoad!, buffers, keyOf, this.onBus!, startAt);
        this.offLayer = new SampleLayer(ctx, a.offLoad!, buffers, keyOf, this.offBus!, startAt);
        const idle = a.idle!;
        this.idleRef = idle;
        this.idleSource = ctx.createBufferSource();
        this.idleSource.buffer = buffers.get(keyOf(idle)) ?? null;
        this.idleSource.loop = true;
        this.idleSourceGain = ctx.createGain();
        this.idleSource.connect(this.idleSourceGain).connect(this.idleBus!);
        this.idleSource.start(startAt);

        const o = a.oneShots ?? {};
        const get = (f?: string) => (f ? buffers.get(base + f) : undefined);
        const one: OneShotBuffers = {
          start: get(o.start) ?? proc.start,
          stop: get(o.stop) ?? proc.stop,
          shift: o.shift?.length ? o.shift.map((f) => get(f)!) : proc.shift,
          backfire: o.backfire?.length ? o.backfire.map((f) => get(f)!) : proc.backfire,
          blowoff: o.blowoff?.length ? o.blowoff.map((f) => get(f)!) : [],
        };
        this.oneShots = new OneShots(ctx, one, compressor);
      } else {
        this.oneShots = new OneShots(ctx, proc, compressor);
      }
      await synthPromise;
      this.setStatus("ready");
    } catch (e) {
      console.error("Failed to load vehicle sounds", e);
      this.oneShots ??= new OneShots(ctx, this.proceduralOneShots(ctx), compressor);
      await synthPromise;
      this.setStatus("error"); // synth keeps running as the fallback
    }
  }

  private proceduralOneShots(ctx: AudioContext): OneShotBuffers {
    return {
      start: proceduralStart(ctx, this.cfg.engine.cylinders),
      stop: proceduralStop(ctx),
      shift: [proceduralShift(ctx, 0), proceduralShift(ctx, 1)],
      backfire: [proceduralPop(ctx, 0), proceduralPop(ctx, 1), proceduralPop(ctx, 2)],
      blowoff: [],
    };
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.ctx && this.master) ramp(this.master.gain, this.volume * dbToGain(this.audio.masterGainDb), this.ctx, 0.03);
  }

  handleEvent(e: SimEvent): void {
    // Shifts are heard through the engine note itself (rpm drop, rev-match blip); no clunks or cracks.
    if (e.type === "limiter" || e.type === "shift" || e.type === "shiftCrack") return;
    if (e.type === "crackle") this.oneShots?.play("backfire", { gain: 0.28, rate: 1.15 + Math.random() * 0.25 });
    else if (e.type === "blowoff") this.oneShots?.play("blowoff", { index: this.cfg.turbo?.release === "flutter" ? 1 : 0 });
    else this.oneShots?.play(e.type as OneShotKind);
  }

  /** Called every animation frame with the latest simulation state. */
  update(s: SimState): void {
    const ctx = this.ctx;
    if (!ctx || !this.lowpass || !this.engineBus || this.disposed) return;
    const audible = s.ignition === "running";
    // Fuel cut drops the on-load layer and thins the sound, which is what makes the limiter "bounce".
    const load = s.limiterActive ? 0 : s.load;
    ramp(this.engineBus.gain, audible ? (s.limiterActive ? 0.55 : 1) : 0, ctx, 0.02);
    ramp(this.lowpass.frequency, Math.min(21000, 3500 * (1 + 5 * s.throttle)), ctx, 0.03);

    this.updateTurbo(ctx, s);
    const sampleLayersReady = this.onLayer && this.offLayer && this.idleSource;
    if (sampleLayersReady) {
      const [offW, onW] = equalPower(load);
      ramp(this.onBus!.gain, onW, ctx);
      ramp(this.offBus!.gain, offW, ctx);
      this.onLayer!.update(s.rpm);
      this.offLayer!.update(s.rpm);
      const lowest = Math.min(this.onLayer!.lowestRpm, this.offLayer!.lowestRpm);
      const { idle, loops } = idleBlend(s.rpm, this.cfg.engine.idleRpm, lowest);
      ramp(this.idleBus!.gain, idle, ctx);
      ramp(this.loopsBus!.gain, loops, ctx);
      ramp(this.idleSourceGain!.gain, 1, ctx);
      ramp(this.idleSource!.playbackRate, rateFor(s.rpm, this.idleRef!.rpm), ctx);
      if (this.synth) {
        // Recordings are ready: fade the fallback synth out, then free it.
        this.synth.update(s.rpm, load, false);
        if (!this.synthRetiring) {
          this.synthRetiring = true;
          setTimeout(() => {
            this.synth?.dispose();
            this.synth = null;
          }, 300);
        }
      }
    } else {
      this.synth?.update(s.rpm, load, audible);
    }
  }

  /** Stops all sound and frees every node and the AudioContext. */
  dispose(): void {
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.onLayer?.dispose();
    this.offLayer?.dispose();
    try {
      this.idleSource?.stop();
    } catch {
      /* not started */
    }
    this.idleSource?.disconnect();
    this.synth?.dispose();
    this.oneShots?.dispose();
    if (this.turbo) {
      for (const n of [this.turbo.whistle, this.turbo.whistle2, this.turbo.hiss]) {
        try {
          n.stop();
        } catch {
          /* not started */
        }
      }
      this.turbo = null;
    }
    this.onLayer = this.offLayer = null;
    this.idleSource = this.idleSourceGain = this.idleRef = null;
    this.synth = null;
    this.oneShots = null;
    this.synthRetiring = false;
    this.wasRunning = false;
    this.status = "idle";
    this.statusListeners.clear();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }
}
