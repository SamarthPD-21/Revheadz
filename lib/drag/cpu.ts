import { DragRun } from "./race";

/** A human-ish practice opponent: typical reaction times, the odd great one, a rare red light. */
export interface CpuSkill {
  launchMs: [number, number];
  shiftMs: [number, number];
  redLightChance: number;
}

export const CPU_LEVELS: Record<"easy" | "club" | "pro", CpuSkill> = {
  easy: { launchMs: [260, 90], shiftMs: [260, 90], redLightChance: 0.02 },
  club: { launchMs: [190, 50], shiftMs: [170, 50], redLightChance: 0.04 },
  pro: { launchMs: [130, 30], shiftMs: [110, 30], redLightChance: 0.06 },
};

/** Box-Muller normal, clamped to something a person could do. */
function sample([mean, sd]: [number, number], min: number) {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.max(min, mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

/** Arms a run with a CPU driver: it launches and shifts on its own as the run advances. */
export function driveWithCpu(run: DragRun, skill: CpuSkill) {
  const red = Math.random() < skill.redLightChance;
  run.press(red ? -sample([40, 25], 5) : sample(skill.launchMs, 95));
  run.on((e) => {
    if (e.type === "cue") run.press(run.t + sample(skill.shiftMs, 70));
  });
}
