"use client";

import { useRef } from "react";
import type { InputManager } from "../lib/input/InputManager";
import { useFrame } from "./useFrame";

const ROWS: { keys: string; codes: string[]; label: string }[] = [
  { keys: "W ↑", codes: ["KeyW", "ArrowUp"], label: "gas" },
  { keys: "S ↓", codes: ["KeyS", "ArrowDown"], label: "brake" },
  { keys: "E Q", codes: ["KeyE", "KeyQ"], label: "shift up / down" },
  { keys: "N", codes: ["KeyN"], label: "neutral" },
  { keys: "Space", codes: ["Space"], label: "blip" },
  { keys: "I", codes: ["KeyI"], label: "engine start / stop" },
  { keys: "M", codes: [], label: "mute" },
  { keys: "[ ]", codes: [], label: "previous / next vehicle" },
];

/** Keyboard legend whose keys light up while held. Shown only with a fine pointer (desktop). */
export function KeyLegend({ input }: { input: InputManager }) {
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
    <dl className="drive-keys hidden grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-left text-[11px] text-zinc-500 pointer-fine:grid">
      {ROWS.map((r, i) => (
        <div key={r.keys} className="contents">
          <dt>
            <kbd ref={(el) => void (keyEls.current[i] = el)} data-on="0" className="keycap">
              {r.keys}
            </kbd>
          </dt>
          <dd>{r.label}</dd>
        </div>
      ))}
    </dl>
  );
}
