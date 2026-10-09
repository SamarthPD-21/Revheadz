import type { MouseEvent, PointerEvent } from "react";

/**
 * Fires on finger/mouse *down* rather than click, so buttons work while another finger
 * is holding the throttle (mobile browsers often drop clicks during multitouch).
 * Keyboard activation (Enter/Space) still arrives as a click with detail 0.
 */
export function pressHandlers(action: () => void) {
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      action();
    },
    onClick: (e: MouseEvent) => {
      if (e.detail === 0) action();
    },
  };
}
