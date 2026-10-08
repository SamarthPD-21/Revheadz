import type { Silhouette as Kind } from "../lib/vehicles/types";

/** Generic side profiles (no real models), drawn in a 200 x 72 box. */
const BODIES: Record<Kind, { body: string; extra?: string; wheels: [number, number][]; r: number }> = {
  muscle: {
    body: "M8 56 L9 45 Q11 41 28 40 L80 38 L100 26 Q106 23 116 23 L134 23 Q144 24 152 30 L164 39 L186 42 Q192 43 192 50 L192 56 Z",
    wheels: [[46, 56], [160, 56]], r: 12,
  },
  coupe: {
    body: "M10 56 L12 47 Q16 42 38 40 L72 37 Q90 25 110 24 L130 25 Q148 28 162 39 L184 43 Q190 45 190 51 L190 56 Z",
    wheels: [[44, 56], [158, 56]], r: 12,
  },
  sport: {
    body: "M12 56 L13 48 Q18 42 42 40 Q66 24 100 22 Q136 22 166 40 Q184 45 188 51 L188 56 Z",
    wheels: [[46, 56], [152, 56]], r: 12,
  },
  supercar: {
    body: "M6 56 L7 50 Q12 46 38 44 L80 40 Q100 29 124 28 Q148 29 170 41 L192 45 L194 53 L194 56 Z",
    extra: "M150 34 L176 40",
    wheels: [[46, 56], [164, 56]], r: 12,
  },
  gt: {
    body: "M8 56 L9 47 Q13 42 34 41 L98 38 Q114 27 130 26 L148 27 Q162 32 172 41 L188 44 Q193 46 193 52 L193 56 Z",
    wheels: [[44, 56], [164, 56]], r: 12,
  },
  hatch: {
    body: "M14 56 L15 46 Q19 42 36 40 L60 37 Q76 23 100 21 L158 21 Q168 22 170 30 L174 44 Q176 48 176 52 L176 56 Z",
    wheels: [[42, 56], [150, 56]], r: 12,
  },
  rally: {
    body: "M8 56 L9 46 Q13 42 32 40 L62 37 Q78 24 100 23 L134 23 Q150 26 162 37 L186 40 Q192 42 192 50 L192 56 Z",
    extra: "M168 33 L192 30 M184 31 L184 39",
    wheels: [[44, 56], [160, 56]], r: 12,
  },
  superbike: {
    body: "M54 50 L74 30 Q88 21 106 23 L128 28 L150 40 L124 44 L98 50 Z M118 28 L164 22 L152 32 Z",
    extra: "M40 56 L70 34 M150 56 L136 40",
    wheels: [[40, 56], [150, 56]], r: 15,
  },
  cruiser: {
    body: "M62 48 Q72 35 92 34 L112 36 L132 44 L164 47 L154 52 L102 52 L82 51 Z",
    extra: "M36 56 L56 30 L68 26 M160 56 L140 46",
    wheels: [[36, 56], [160, 56]], r: 15,
  },
};

export function Silhouette({ kind, accent, className }: { kind: Kind; accent: string; className?: string }) {
  const s = BODIES[kind];
  const id = `g-${kind}`;
  return (
    <svg viewBox="0 0 200 72" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={accent} stopOpacity="0.55" />
          <stop offset="1" stopColor={accent} stopOpacity="0.08" />
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="68" rx="92" ry="3" fill="black" opacity="0.5" />
      <path d={s.body} fill={`url(#${id})`} stroke={accent} strokeWidth="1.5" strokeLinejoin="round" />
      {s.extra && <path d={s.extra} fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />}
      {s.wheels.map(([x, y]) => (
        <g key={x}>
          <circle cx={x} cy={y} r={s.r} fill="#0b0b0f" stroke={accent} strokeWidth="1.5" />
          <circle cx={x} cy={y} r={s.r * 0.45} fill="none" stroke={accent} strokeOpacity="0.6" strokeWidth="1" />
        </g>
      ))}
    </svg>
  );
}
