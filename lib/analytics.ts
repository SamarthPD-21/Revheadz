import { track } from "@vercel/analytics";

/** Fire-and-forget custom events. Never throws, never blocks the UI. */
export function trackEvent(name: string, props?: Record<string, string | number>): void {
  try {
    track(name, props);
  } catch {
    /* analytics is optional */
  }
}
