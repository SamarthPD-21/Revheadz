/** How a launch or a shift went, in the words the race and the playground both use. */
export type Tone = "great" | "good" | "bad" | "red";
export interface Rating {
  title: string;
  tone: Tone;
}

/** Reaction to the green, ms (negative: a red light). */
export function rateLaunch(ms: number): Rating {
  if (ms < 0) return { title: "Red light", tone: "red" };
  if (ms < 60) return { title: "Perfect launch", tone: "great" };
  if (ms < 150) return { title: "Great launch", tone: "great" };
  if (ms < 250) return { title: "Good launch", tone: "good" };
  return { title: "Slow launch", tone: "bad" };
}

/** Time from the shift light to the shift, ms (negative: before the light). */
export function rateShift(ms: number): Rating {
  if (ms < 0) return { title: "Early shift", tone: "bad" };
  if (ms < 80) return { title: "Perfect shift", tone: "great" };
  if (ms < 160) return { title: "Great shift", tone: "great" };
  if (ms < 260) return { title: "Good shift", tone: "good" };
  return { title: "Late shift", tone: "bad" };
}
