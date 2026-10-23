/**
 * Turns a short engine loop into a longer one that doesn't audibly repeat.
 *
 * Recorded loops cut from a fast sweep (a dyno pull, an onboard ramp) are often only
 * 0.3-1 s long. Looped as they are, the same handful of engine cycles comes round
 * several times a second, a buzzy "stuck" pattern the ear picks out at once. Here
 * the loop is re-spliced into a few seconds of material: grains of about a cycle and
 * a half, each followed by a jump to a random place in the loop. Every jump lands
 * where the waveform best matches the point we leave (a WSOLA-style search over one
 * engine cycle), and is short-crossfaded, so the splices are seamless. The result
 * ends by splicing back into its own start, so it loops too.
 */

const DECIMATE = 4;

/** xorshift32: deterministic per loop, so a vehicle always sounds the same. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Normalised correlation of x[a..] and x[b..] over n samples (circular), on every DECIMATE-th sample. */
function similarity(x: Float32Array, a: number, b: number, n: number): number {
  const L = x.length;
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 0; i < n; i += DECIMATE) {
    const p = x[(a + i) % L];
    const q = x[(b + i) % L];
    xy += p * q;
    xx += p * p;
    yy += q * q;
  }
  return xy / (Math.sqrt(xx * yy) || 1);
}

/** The read position near `target` (within +-half a cycle) whose next samples best match those at `from`. */
function bestMatch(x: Float32Array, from: number, target: number, halfRange: number, n: number): number {
  const L = x.length;
  let best = target;
  let bestScore = -Infinity;
  for (let d = -halfRange; d <= halfRange; d += DECIMATE) {
    const q = (((target + d) % L) + L) % L;
    const s = similarity(x, from, q, n);
    if (s > bestScore) {
      bestScore = s;
      best = q;
    }
  }
  return best;
}

export interface ShuffleOptions {
  /** Engine rpm the loop was recorded at (sets the grain and search lengths). */
  rpm: number;
  /** Output length in seconds. */
  seconds?: number;
  seed?: number;
}

/** Splice plan: a list of [readStart, length] runs through the source, joined by crossfades of `fade` samples. */
function plan(x: Float32Array, sampleRate: number, o: ShuffleOptions) {
  const L = x.length;
  const cycle = Math.round((sampleRate * 120) / Math.max(300, o.rpm)); // one four-stroke cycle
  const fade = Math.min(Math.round(0.012 * sampleRate), Math.floor(L / 8));
  const grainMin = Math.min(Math.max(Math.round(cycle * 1.5), Math.round(0.09 * sampleRate)), Math.floor(L * 0.6));
  const half = Math.min(Math.floor(cycle / 2), Math.floor(L / 4));
  const total = Math.round((o.seconds ?? 5) * sampleRate);
  const rand = rng(o.seed ?? 1);

  const runs: [number, number][] = [];
  let read = 0;
  let written = 0;
  while (written < total) {
    const len = grainMin + Math.floor(rand() * grainMin * 0.6);
    runs.push([read, len]);
    written += len;
    const leave = (read + len) % L;
    // jump somewhere else in the loop (at least a grain away), landing on the best-matching sample
    const target = (leave + grainMin + Math.floor(rand() * Math.max(1, L - 2 * grainMin))) % L;
    // the crossfade overlaps the run's last `fade` samples with the next run's first ones
    read = bestMatch(x, (leave - fade + L) % L, target, half, fade);
  }
  // close the loop: trim or extend the last run (by up to half a cycle) so its end matches the very start
  const last = runs[runs.length - 1];
  const end = (last[0] + last[1]) % L;
  const closeAt = (bestMatch(x, 0, (end - fade + L) % L, half, fade) + fade) % L;
  const delta = (((closeAt - end) % L) + L + half) % L - half; // signed, within +-half
  last[1] = Math.max(fade * 2, last[1] + delta);
  return { runs, fade };
}

function render(x: Float32Array, runs: [number, number][], fade: number): Float32Array<ArrayBuffer> {
  const L = x.length;
  const n = runs.reduce((s, r) => s + r[1], 0);
  const y = new Float32Array(n);
  let w = 0;
  for (let k = 0; k < runs.length; k++) {
    const [start, len] = runs[k];
    const next = runs[(k + 1) % runs.length][0];
    for (let i = 0; i < len; i++) {
      const fromEnd = len - i;
      let v = x[(start + i) % L];
      if (fromEnd <= fade) {
        // crossfade into the next run's opening samples (raised cosine: the signals are aligned)
        const f = 0.5 - 0.5 * Math.cos((Math.PI * (fade - fromEnd + 1)) / (fade + 1));
        v = v * (1 - f) + x[(next + (fade - fromEnd)) % L] * f;
      }
      y[w++] = v;
    }
    // the next run's first `fade` samples were already mixed in above
    if (k + 1 < runs.length) runs[k + 1] = [(runs[k + 1][0] + fade) % L, runs[k + 1][1] - fade];
  }
  return y.subarray(0, w); // later runs lost their first `fade` samples to the crossfades
}

/** A longer, non-repeating version of `buffer` (or the buffer itself if it's already long). */
export function shuffleLoop(ctx: BaseAudioContext, buffer: AudioBuffer, o: ShuffleOptions): AudioBuffer {
  const minUseful = 0.25;
  if (buffer.duration >= 2.5 || buffer.duration < minUseful) return buffer;
  const x0 = buffer.getChannelData(0);
  const { runs, fade } = plan(x0, buffer.sampleRate, o);
  // the opening `fade` samples are replaced by the closing crossfade: start the buffer after them
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => {
    const y = render(buffer.getChannelData(c), runs.map((r) => [...r] as [number, number]), fade);
    return y.subarray(fade);
  });
  const out = ctx.createBuffer(buffer.numberOfChannels, channels[0].length, buffer.sampleRate);
  channels.forEach((y, c) => out.copyToChannel(y, c));
  return out;
}
