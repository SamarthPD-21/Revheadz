/** Time constant for every parameter change: avoids "zipper" crackle from direct assignment. */
export const SMOOTH_S = 0.02;

/** The last target each param was sent, so a value that hasn't moved isn't re-sent every frame. */
const targets = new WeakMap<AudioParam, number>();

export function ramp(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstant = SMOOTH_S): void {
  // Most params hold still most frames (every silent loop's gain sits at 0); re-scheduling them
  // 60 times a second is wasted work for the audio thread. The last target is still being approached.
  const last = targets.get(param);
  if (last !== undefined && Math.abs(value - last) <= 1e-4 * Math.max(1, Math.abs(value))) return;
  targets.set(param, value);
  param.setTargetAtTime(value, ctx.currentTime, timeConstant);
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
