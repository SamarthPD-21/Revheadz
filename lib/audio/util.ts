/** Time constant for every parameter change: avoids "zipper" crackle from direct assignment. */
export const SMOOTH_S = 0.02;

export function ramp(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstant = SMOOTH_S): void {
  param.setTargetAtTime(value, ctx.currentTime, timeConstant);
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
