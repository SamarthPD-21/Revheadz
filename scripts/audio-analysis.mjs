/**
 * DSP helpers for turning real engine recordings into RPM loops:
 * decoding, pitch tracking, pitch flattening, seamless looping, filtering.
 */
import { execFileSync } from "node:child_process";

export const SR = 44100;

/** Decodes any audio file to mono float32 at 44.1 kHz with ffmpeg. */
export function decode(file) {
  const b = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], {
    maxBuffer: 1 << 30,
  });
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice();
}

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k;
        const q = p + len / 2;
        const vr = re[q] * cr - im[q] * ci;
        const vi = re[q] * ci + im[q] * cr;
        re[q] = re[p] - vr;
        im[q] = im[p] - vi;
        re[p] += vr;
        im[p] += vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const N_FFT = 8192;
const HOP = 512;
const F_MIN = 18;
const F_MAX = 700;
const BINS_PER_OCT = 96;
const HARMONICS = 10;

/**
 * Pitch track of the dominant harmonic comb (an engine's firing or cycle frequency).
 * Harmonic-sum salience on a log-frequency grid, then Viterbi smoothing so the track
 * doesn't jump octaves. Returns per-frame { t, f0, level } (level in dBFS).
 */
export function trackPitch(x, { fMin = F_MIN, fMax = F_MAX, harmonics = HARMONICS, nFft = N_FFT, hop = HOP, maxHz = 5000 } = {}) {
  const N_FFT = nFft;
  const HOP = hop;
  const HARMONICS = harmonics;
  const nCand = Math.ceil(Math.log2(fMax / fMin) * BINS_PER_OCT);
  const cand = Array.from({ length: nCand }, (_, i) => fMin * Math.pow(2, i / BINS_PER_OCT));
  const win = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));
  const frames = [];
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const binHz = SR / N_FFT;
  for (let start = 0; start + N_FFT <= x.length; start += HOP) {
    let e = 0;
    for (let i = 0; i < N_FFT; i++) {
      const v = x[start + i];
      e += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(N_FFT / 2);
    for (let k = 0; k < N_FFT / 2; k++) mag[k] = Math.log1p(1000 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
    const sal = new Float64Array(nCand);
    for (let c = 0; c < nCand; c++) {
      let s = 0;
      for (let h = 1; h <= HARMONICS; h++) {
        const f = cand[c] * h;
        if (f > maxHz) break;
        const k = f / binHz;
        const k0 = Math.floor(k);
        const m = mag[k0] + (mag[k0 + 1] - mag[k0]) * (k - k0);
        const w = HARMONICS > 12 ? 1 : Math.pow(0.86, h - 1);
        s += m * w;
        // penalise candidates whose "harmonics" fall between real peaks (subharmonic errors)
        const kh = (f - cand[c] / 2) / binHz;
        const kh0 = Math.floor(kh);
        if (kh0 > 0) s -= 0.35 * (mag[kh0] + (mag[kh0 + 1] - mag[kh0]) * (kh - kh0)) * w;
      }
      sal[c] = s;
    }
    frames.push({ t: (start + N_FFT / 2) / SR, sal, level: 10 * Math.log10(e / N_FFT + 1e-12) });
  }
  // Viterbi: maximise salience minus a penalty for pitch movement
  const jump = Math.max(6, Math.round(18 * (HOP / 512))); // max bins per hop (~3/16 octave per 12 ms)
  const penalty = 0.06;
  let score = Float64Array.from(frames[0]?.sal ?? []);
  const back = [];
  for (let f = 1; f < frames.length; f++) {
    const next = new Float64Array(nCand);
    const bp = new Int32Array(nCand);
    for (let c = 0; c < nCand; c++) {
      let best = -Infinity;
      let arg = c;
      for (let d = -jump; d <= jump; d++) {
        const p = c + d;
        if (p < 0 || p >= nCand) continue;
        const v = score[p] - penalty * Math.abs(d);
        if (v > best) {
          best = v;
          arg = p;
        }
      }
      next[c] = best + frames[f].sal[c];
      bp[c] = arg;
    }
    back.push(bp);
    score = next;
  }
  let c = score.indexOf(Math.max(...score));
  const path = new Int32Array(frames.length);
  for (let f = frames.length - 1; f >= 0; f--) {
    path[f] = c;
    if (f > 0) c = back[f - 1][c];
  }
  return frames.map((fr, i) => {
    const k = path[i];
    // parabolic refinement
    const a = fr.sal[k - 1] ?? fr.sal[k];
    const b = fr.sal[k];
    const d = fr.sal[k + 1] ?? fr.sal[k];
    const off = a - 2 * b + d !== 0 ? (0.5 * (a - d)) / (a - 2 * b + d) : 0;
    return { t: fr.t, f0: fMin * Math.pow(2, (k + Math.max(-0.5, Math.min(0.5, off))) / BINS_PER_OCT), level: fr.level };
  });
}

/** Linear-interpolated value of the track at time t. */
export function f0At(track, t) {
  if (t <= track[0].t) return track[0].f0;
  for (let i = 1; i < track.length; i++) {
    if (track[i].t >= t) {
      const a = track[i - 1];
      const b = track[i];
      return a.f0 + ((b.f0 - a.f0) * (t - a.t)) / (b.t - a.t);
    }
  }
  return track[track.length - 1].f0;
}

/**
 * Resamples x[t0..t1] so its pitch becomes the constant `targetF0`: wobble and sweeps
 * are flattened, so the result represents one exact RPM.
 */
export function flatten(x, track, t0, t1, targetF0) {
  // phase(t) = integral f0(t) dt; output time tau where targetF0 * tau = phase(t)
  const dt = 1 / SR;
  const times = [];
  let phase = 0;
  const out = [];
  let tau = 0;
  let t = t0;
  let nextOutPhase = 0;
  while (t < t1) {
    const f = f0At(track, t);
    const nextPhase = phase + f * dt;
    while (nextOutPhase < nextPhase) {
      const frac = (nextOutPhase - phase) / (nextPhase - phase);
      const pos = (t + frac * dt) * SR;
      const i = Math.floor(pos);
      const w = pos - i;
      out.push((x[i] ?? 0) * (1 - w) + (x[i + 1] ?? 0) * w);
      tau += dt;
      nextOutPhase = targetF0 * tau;
    }
    phase = nextPhase;
    t += dt;
  }
  void times;
  return Float32Array.from(out);
}

/**
 * Makes a seamless loop from y: finds the end point (near the end, whole periods of f0)
 * whose surroundings best match the start, then crossfades the tail into the head.
 */
export function makeLoop(y, f0, { crossfadeS = 0.06, lengthBias = 0 } = {}) {
  const period = SR / f0;
  const xf = Math.round(crossfadeS * SR);
  const maxLen = y.length - xf - 1;
  const periods = Math.floor((maxLen - xf) / period);
  if (periods < 4) throw new Error("segment too short to loop");
  // search a few candidate lengths (whole periods) near the longest, pick best correlation
  let best = { score: -Infinity, len: Math.round(periods * period) };
  for (let p = periods; p >= Math.max(4, periods - 6); p--) {
    const base = Math.round(p * period);
    for (let d = -6; d <= 6; d++) {
      const len = base + d;
      if (len + xf >= y.length) continue;
      let num = 0;
      let ea = 0;
      let eb = 0;
      for (let i = 0; i < xf; i++) {
        const a = y[i];
        const b = y[len + i];
        num += a * b;
        ea += a * a;
        eb += b * b;
      }
      const corr = num / Math.sqrt(ea * eb + 1e-12);
      // lengthBias > 0 favours longer loops (fewer audible repeats) over a slightly better seam
      const score = corr - lengthBias * (periods - p);
      if (score > best.score) best = { score, corr, len };
    }
  }
  const { len } = best;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = y[i];
  // equal-power crossfade of the material after the loop point into the head
  for (let i = 0; i < xf; i++) {
    const w = i / xf;
    out[i] = y[len + i] * Math.cos((w * Math.PI) / 2) + y[i] * Math.sin((w * Math.PI) / 2);
  }
  return { loop: out, correlation: best.corr ?? best.score, cycles: len / period };
}

export function biquad(type, freq, q = 0.707) {
  const w0 = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (type === "lp") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === "hp") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  b0 /= a0; b1 /= a0; b2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** Filters a loop circularly (primed with one pass) so the seam stays seamless. */
export function filterLoop(buf, type, freq, q) {
  const f = biquad(type, freq, q);
  for (let i = 0; i < buf.length; i++) f(buf[i]);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = f(buf[i]);
  return out;
}

export function filterOnce(buf, type, freq, q) {
  const f = biquad(type, freq, q);
  return Float32Array.from(buf, (v) => f(v));
}

export const rms = (b) => Math.sqrt(b.reduce((s, v) => s + v * v, 0) / Math.max(1, b.length));

export function wav(samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + samples.length * 2, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return data;
}

// ------------------------------------------------------------- tone matching

const BAND_EDGES = (() => {
  const e = [];
  for (let f = 40; f < 18000; f *= Math.pow(2, 1 / 3)) e.push(f);
  return e;
})();

/** Average power per 1/3-octave band (40 Hz - 18 kHz) of a signal. */
export function bandSpectrum(x) {
  const N = 4096;
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const bands = new Float64Array(BAND_EDGES.length - 1);
  let frames = 0;
  for (let st = 0; st + N <= x.length; st += N / 2) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[st + i] * win[i];
    fft(re, im);
    for (let b = 0; b < bands.length; b++) {
      const k0 = Math.floor((BAND_EDGES[b] / SR) * N);
      const k1 = Math.max(k0 + 1, Math.floor((BAND_EDGES[b + 1] / SR) * N));
      let p = 0;
      for (let k = k0; k < k1; k++) p += re[k] * re[k] + im[k] * im[k];
      bands[b] += p / (k1 - k0);
    }
    frames++;
  }
  return bands.map((p) => p / Math.max(1, frames));
}

/**
 * Re-colours `loop` towards the tonal balance of `refBands` (from bandSpectrum), so loops
 * cut from a different recording or mic blend in. Overall level is left to the caller;
 * corrections are smoothed and limited to +-maxDb. Circular, so loops stay seamless.
 */
export function matchTone(loop, refBands, maxDb = 9) {
  const own = bandSpectrum(loop);
  let db = Array.from(own, (p, b) => 10 * Math.log10((refBands[b] + 1e-12) / (p + 1e-12)));
  const mean = db.reduce((a, v) => a + v, 0) / db.length;
  db = db.map((v) => Math.max(-maxDb, Math.min(maxDb, v - mean)));
  db = db.map((_, i) => (db[Math.max(0, i - 1)] + 2 * db[i] + db[Math.min(db.length - 1, i + 1)]) / 4);
  // linear-phase FIR by frequency sampling
  const N = 2048;
  const centres = BAND_EDGES.slice(0, -1).map((f, i) => Math.sqrt(f * BAND_EDGES[i + 1]));
  const gainAt = (f) => {
    if (f <= centres[0]) return db[0];
    for (let i = 1; i < centres.length; i++) if (f <= centres[i]) {
      const t = Math.log(f / centres[i - 1]) / Math.log(centres[i] / centres[i - 1]);
      return db[i - 1] + (db[i] - db[i - 1]) * t;
    }
    return db[db.length - 1];
  };
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const g = Math.pow(10, gainAt((k * SR) / N) / 20);
    re[k] = g;
    if (k > 0 && k < N / 2) re[N - k] = g;
  }
  // inverse FFT via conjugate trick
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  const taps = 1023;
  const h = new Float64Array(taps);
  for (let i = 0; i < taps; i++) {
    const idx = (i - (taps - 1) / 2 + N) % N;
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = (re[idx] / N) * w;
  }
  const n = loop.length;
  const out = new Float32Array(n);
  const half = (taps - 1) / 2;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < taps; j++) acc += h[j] * loop[(i - j + half + n * 2) % n];
    out[i] = acc;
  }
  return out;
}
