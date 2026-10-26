"use client";

import { useRef, useState } from "react";
import type { InputManager } from "../lib/input/InputManager";
import { useFrame } from "./useFrame";

const ROWS: { keys: string; codes: string[]; label: string; more?: true }[] = [
  { keys: "W", codes: ["KeyW", "ArrowUp"], label: "gas" },
  { keys: "S", codes: ["KeyS", "ArrowDown"], label: "brake" },
  { keys: "E Q", codes: ["KeyE", "KeyQ"], label: "shift" },
  { keys: "I", codes: ["KeyI"], label: "engine" },
  { keys: "N", codes: ["KeyN"], label: "neutral", more: true },
  { keys: "Space", codes: ["Space"], label: "blip", more: true },
  { keys: "M", codes: [], label: "mute", more: true },
  { keys: "F", codes: [], label: "full screen", more: true },
  { keys: "[ ]", codes: [], label: "previous / next car", more: true },
  { keys: "V", codes: [], label: "pick a car", more: true },
];

/**
 * One quiet line of the driving keys, which light up while held; the rest on request. Shown
 * only with a fine pointer (desktop): phones get the touch controls instead.
 */
export function KeyLegend({ input }: { input: InputManager }) {
  const [more, setMore] = useState(false);
  const keyEls = useRef<(HTMLElement | null)[]>([]);
  useFrame(() => {
    ROWS.forEach((r, i) => {
      const el = keyEls.current[i];
      if (!el) return;
      const on = r.codes.some((c) => input.isKeyDown(c)) ? "1" : "0";
      if (el.dataset.on !== on) el.dataset.on = on;
    });
  });
  return (
    <div className="drive-keys" data-more={more ? "1" : undefined}>
      <dl>
        {ROWS.map((r, i) =>
          r.more && !more ? null : (
            <div key={r.keys}>
              <dt>
                <kbd ref={(el) => void (keyEls.current[i] = el)} data-on="0" className="keycap">
                  {r.keys}
                </kbd>
              </dt>
              <dd>{r.label}</dd>
            </div>
          ),
        )}
      </dl>
      <button type="button" className="drive-keys-more" onClick={() => setMore(!more)} aria-expanded={more}>
        {more ? "Less" : "More keys"}
      </button>
    </div>
  );
}
