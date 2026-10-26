import type { SimState } from "../sim/types";
import { ramp } from "./util";

/**
 * The whine of a mechanically driven supercharger. Unlike a turbo, its rotors are geared or
 * belted to the crank, so the whine is locked to engine speed: it climbs with every rev, drops
 * on every upshift, and keeps singing (quieter, with the bypass valve open) when you lift.
 *
 * - "twin-screw": a positive-displacement blower (the Hellcat's 2.4 L IHI). The mesh of its
 *   lobed rotors gives a strong, buzzy tone with plenty of harmonics, loud from low revs.
 * - "centrifugal": a high-speed impeller (the Ninja H2's). A purer, higher siren that only
 *   really comes in near the top of the rev range, as its boost does.
 */
export type BlowerKind = "twin-screw" | "centrifugal";

const VOICES: Record<BlowerKind, { hzPerRpm: number; harmonics: number[]; low: number; high: number; curve: number }> = {
  // ~310 Hz at idle up to ~2.6 kHz at the Hellcat's redline
  "twin-screw": { hzPerRpm: 0.42, harmonics: [1, 0.6, 0.34, 0.22, 0.12, 0.07], low: 0.018, high: 0.06, curve: 1 },
  "centrifugal": { hzPerRpm: 0.5, harmonics: [1, 0.25, 0.08], low: 0.004, high: 0.05, curve: 2.2 },
};

export interface BlowerWhine {
  update(s: SimState, redlineRpm: number): void;
  stop(): void;
}

export function blowerWhine(ctx: AudioContext, kind: BlowerKind, dest: AudioNode): BlowerWhine {
  const v = VOICES[kind];
  // the rotor tone, rich in harmonics, plus a slightly detuned copy whose beating gives the
  // shimmer of a real blower
  const real = new Float32Array(v.harmonics.length + 1);
  const imag = new Float32Array([0, ...v.harmonics]);
  const wave = ctx.createPeriodicWave(real, imag);
  const tone = ctx.createOscillator();
  tone.setPeriodicWave(wave);
  const shimmer = ctx.createOscillator();
  shimmer.setPeriodicWave(wave);
  const shimmerGain = ctx.createGain();
  shimmerGain.gain.value = 0.45;
  const toneGain = ctx.createGain();
  toneGain.gain.value = 0;
  tone.connect(toneGain);
  shimmer.connect(shimmerGain).connect(toneGain);

  // air rushing through it, tuned around the whine
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const air = ctx.createBufferSource();
  air.buffer = noise;
  air.loop = true;
  const airFilter = ctx.createBiquadFilter();
  airFilter.type = "bandpass";
  airFilter.Q.value = 2.5;
  const airGain = ctx.createGain();
  airGain.gain.value = 0;
  air.connect(airFilter).connect(airGain);

  // keep the rumble out of it: the engine loops already carry the low end
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 220;
  toneGain.connect(hp);
  airGain.connect(hp);
  hp.connect(dest);

  const at = ctx.currentTime + 0.02;
  tone.start(at);
  shimmer.start(at);
  air.start(at);

  return {
    update(s, redlineRpm) {
      const running = s.ignition === "running" ? 1 : 0;
      const f = Math.max(40, s.rpm * v.hzPerRpm);
      // locked to the crank: follows the revs with no lag at all
      ramp(tone.frequency, f, ctx, 0.008);
      ramp(shimmer.frequency, f * 1.006, ctx, 0.008);
      ramp(airFilter.frequency, f * 1.5, ctx, 0.02);
      const shaft = Math.min(1, s.rpm / redlineRpm) ** v.curve;
      const thr = Math.min(1, Math.max(0, s.throttle));
      // under load the rotors compress air and scream; on a lift the bypass opens and it sings softer
      ramp(toneGain.gain, running * shaft * (v.low + (v.high - v.low) * thr), ctx, 0.03);
      ramp(airGain.gain, running * shaft * 0.05 * thr, ctx, 0.04);
    },
    stop() {
      for (const n of [tone, shimmer, air]) {
        try {
          n.stop();
        } catch {
          /* not started */
        }
      }
      hp.disconnect();
    },
  };
}
