/** The strip's time of day: tonight's floodlit strip, or golden hour with the sun going down. */
export type TimeOfDay = "night" | "dusk";

const KEY = "revheadz:track-time";

/** The time of day the strip is drawn at, remembered on this device. Night unless chosen otherwise. */
export function loadTrackTime(): TimeOfDay {
  try {
    return localStorage.getItem(KEY) === "dusk" ? "dusk" : "night";
  } catch {
    return "night";
  }
}

export function saveTrackTime(t: TimeOfDay) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode */
  }
}
