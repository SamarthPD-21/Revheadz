import { decodeAll } from "../assets/Loader";
import { shuffleLoop } from "./loopShuffle";

/** What the garage needs to play a quick rev of a vehicle: its idle loop and one high on-load loop. */
export interface PreviewSounds {
  idle: string;
  idleRpm: number;
  rev: string;
  revRpm: number;
}

let ctx: AudioContext | null = null;
let stopCurrent: (() => void) | null = null;

/**
 * Plays a short "blip": idle, a rev up toward the high loop, a moment held, then back down.
 * One preview at a time; starting another (or calling stopPreview) fades the last one out.
 * Must be called from a tap or key handler (it creates/resumes the AudioContext).
 * Resolves when the blip has finished or been stopped.
 */
export async function playPreview(base: string, s: PreviewSounds, onEnd?: () => void): Promise<void> {
  stopPreview();
  ctx ??= new AudioContext();
  void ctx.resume();
  const ac = ctx;

  let cancelled = false;
  stopCurrent = () => {
    cancelled = true;
    onEnd?.();
  };
  let buffers: Map<string, AudioBuffer>;
  try {
    buffers = await decodeAll(ac, [`${base}/${s.idle}`, `${base}/${s.rev}`]);
  } catch {
    if (!cancelled) stopCurrent?.();
    return;
  }
  if (cancelled) return;

  const t0 = ac.currentTime + 0.02;
  const out = ac.createGain();
  out.gain.value = 0.7;
  out.connect(ac.destination);

  const idle = ac.createBufferSource();
  idle.buffer = shuffleLoop(ac, buffers.get(`${base}/${s.idle}`)!, { rpm: s.idleRpm, seconds: 3 });
  idle.loop = true;
  const idleGain = ac.createGain();
  idle.connect(idleGain).connect(out);

  const rev = ac.createBufferSource();
  rev.buffer = shuffleLoop(ac, buffers.get(`${base}/${s.rev}`)!, { rpm: s.revRpm, seconds: 3 });
  rev.loop = true;
  const revGain = ac.createGain();
  rev.connect(revGain).connect(out);

  // the rev loop starts pitched down near idle, sweeps up to its own rpm, holds, and falls back
  const low = Math.min(1, Math.max(0.3, (s.idleRpm * 1.4) / s.revRpm));
  const up = 0.45;
  const hold = 0.35;
  const down = 0.8;
  const tUp = t0 + 0.45;
  const tTop = tUp + up;
  const tFall = tTop + hold;
  const tEnd = tFall + down;

  idleGain.gain.setValueAtTime(0, t0);
  idleGain.gain.linearRampToValueAtTime(0.8, t0 + 0.06);
  idleGain.gain.setValueAtTime(0.8, tUp);
  idleGain.gain.linearRampToValueAtTime(0.05, tUp + 0.2);
  idleGain.gain.setValueAtTime(0.05, tFall + down * 0.5);
  idleGain.gain.linearRampToValueAtTime(0.7, tEnd);
  idleGain.gain.linearRampToValueAtTime(0, tEnd + 0.5);

  rev.playbackRate.setValueAtTime(low, t0);
  rev.playbackRate.setValueAtTime(low, tUp);
  rev.playbackRate.exponentialRampToValueAtTime(1, tTop);
  rev.playbackRate.setValueAtTime(1, tFall);
  rev.playbackRate.exponentialRampToValueAtTime(low, tEnd);
  revGain.gain.setValueAtTime(0, t0);
  revGain.gain.setValueAtTime(0, tUp);
  revGain.gain.linearRampToValueAtTime(1, tUp + 0.15);
  revGain.gain.setValueAtTime(1, tFall);
  revGain.gain.linearRampToValueAtTime(0.35, tFall + down * 0.6);
  revGain.gain.linearRampToValueAtTime(0, tEnd + 0.1);

  idle.start(t0);
  rev.start(t0);
  const stopAt = tEnd + 0.55;
  idle.stop(stopAt);
  rev.stop(stopAt);

  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (stopCurrent === fade) stopCurrent = null;
      onEnd?.();
      finish();
    }, (stopAt - ac.currentTime) * 1000);
    const fade = () => {
      const now = ac.currentTime;
      out.gain.cancelScheduledValues(now);
      out.gain.setTargetAtTime(0, now, 0.04);
      try {
        idle.stop(now + 0.25);
        rev.stop(now + 0.25);
      } catch {
        /* already stopped */
      }
      onEnd?.();
      finish();
    };
    stopCurrent = fade;
  });
}

export function stopPreview(): void {
  const s = stopCurrent;
  stopCurrent = null;
  s?.();
}
