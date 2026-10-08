/** Generated one-shots for vehicles (or files) without recordings. Small, simple DSP. */

type Fill = (t: number, rand: () => number) => number;

function make(ctx: BaseAudioContext, seconds: number, fill: Fill): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.max(1, Math.round(seconds * sr)), sr);
  const data = buf.getChannelData(0);
  const rand = Math.random;
  let lp = 0;
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const raw = fill(i / sr, rand);
    lp += (raw - lp) * 0.5; // light smoothing
    const edge = Math.min(1, i / 40, (n - 1 - i) / 40);
    data[i] = Math.tanh(lp * 1.4) * edge * 0.8;
  }
  return buf;
}

export function proceduralStart(ctx: BaseAudioContext, cylinders: number): AudioBuffer {
  const crank = 0.9;
  return make(ctx, 1.6, (t, rand) => {
    if (t < crank) {
      const chug = Math.pow(Math.max(0, Math.sin(2 * Math.PI * (2 + cylinders * 0.4) * t)), 3);
      const whine = Math.sin(2 * Math.PI * (150 + 40 * Math.min(1, t * 4)) * t) * 0.22;
      return (whine + chug * 0.35 * (rand() * 2 - 1)) * Math.min(1, t * 20);
    }
    const k = t - crank;
    const burst = Math.exp(-k * 7) * Math.sin(2 * Math.PI * (60 + 30 * Math.exp(-k * 5)) * k);
    return burst * 0.7 + (rand() * 2 - 1) * 0.15 * Math.exp(-k * 9);
  });
}

export function proceduralStop(ctx: BaseAudioContext): AudioBuffer {
  return make(ctx, 0.9, (t, rand) => {
    const f = 55 * Math.pow(Math.max(0.15, 1 - t / 0.75), 1.5);
    const body = Math.sin(2 * Math.PI * f * t) * Math.max(0, 1 - t / 0.75);
    const clunk = t > 0.7 && t < 0.85 ? Math.sin(2 * Math.PI * 70 * (t - 0.7)) * Math.exp(-(t - 0.7) * 40) * 0.5 : 0;
    return body * 0.6 + clunk + (rand() * 2 - 1) * 0.05 * Math.max(0, 1 - t / 0.6);
  });
}

export function proceduralShift(ctx: BaseAudioContext, variant: number): AudioBuffer {
  const f = 85 + variant * 18;
  return make(ctx, 0.14, (t, rand) => (rand() * 2 - 1) * Math.exp(-t / 0.012) * 0.8 + Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.035));
}

export function proceduralPop(ctx: BaseAudioContext, variant: number): AudioBuffer {
  const decay = [0.03, 0.05, 0.04][variant % 3];
  return make(ctx, 0.2, (t, rand) => (rand() * 2 - 1) * Math.exp(-t / decay) * Math.min(1, t * 900));
}
