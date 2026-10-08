import type { SampleRef } from "../vehicles/types";

/** Playback rates outside this range sound chipmunk-like or muddy; configs keep active loops inside it. */
export const MIN_RATE = 0.6;
export const MAX_RATE = 1.6;

/**
 * How alike two neighbouring loops are. Loops are phase-locked (same firing instants),
 * so they are partly correlated; a plain equal-power fade would bump +1-3 dB mid-way.
 */
export const LOOP_CORRELATION = 0.5;

export interface Blend {
  lower: number;
  upper: number;
  gainLower: number;
  gainUpper: number;
}

/**
 * Constant-loudness crossfade for signals with correlation `rho` (0 = unrelated, the
 * classic equal-power fade; 1 = identical, a linear fade). Satisfies a^2 + b^2 + 2*rho*a*b = 1.
 */
export function crossfade(position: number, rho = 0): [number, number] {
  const w = Math.min(1, Math.max(0, position));
  const a = Math.cos((w * Math.PI) / 2);
  const b = Math.sin((w * Math.PI) / 2);
  const norm = Math.sqrt(a * a + b * b + 2 * rho * a * b);
  return [a / norm, b / norm];
}

/** Classic equal-power pair (gainA^2 + gainB^2 === 1). */
export const equalPower = (position: number): [number, number] => crossfade(position, 0);

/** Picks the two loops whose recorded rpm bracket the current rpm and their crossfade gains. */
export function blendSamples(rpm: number, samples: readonly SampleRef[], rho = LOOP_CORRELATION): Blend {
  const n = samples.length;
  let upper = samples.findIndex((s) => s.rpm >= rpm);
  if (upper === -1) upper = n - 1;
  const lower = Math.max(0, upper - 1);
  if (upper === lower) {
    const above = rpm >= samples[upper].rpm;
    return { lower, upper, gainLower: above ? 0 : 1, gainUpper: above ? 1 : 0 };
  }
  const position = (rpm - samples[lower].rpm) / (samples[upper].rpm - samples[lower].rpm);
  const [gainLower, gainUpper] = crossfade(position, rho);
  return { lower, upper, gainLower, gainUpper };
}

/**
 * Playback rate that matches a loop's pitch to the engine. Applied to every loop, active
 * or not, so all loops advance through the engine cycle together (phase-locked).
 */
export const rateFor = (rpm: number, sampleRpm: number): number => Math.min(16, Math.max(0.0625, rpm / sampleRpm));

/** Split between the idle loop and the RPM loops just above idle. */
export function idleBlend(rpm: number, idleRpm: number, lowestLoopRpm: number): { idle: number; loops: number } {
  const span = Math.max(1, lowestLoopRpm - idleRpm);
  const [idle, loops] = crossfade((rpm - idleRpm) / span, LOOP_CORRELATION);
  return { idle, loops };
}
