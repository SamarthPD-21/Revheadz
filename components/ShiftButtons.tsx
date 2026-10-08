"use client";

interface Props {
  onUp: () => void;
  onDown: () => void;
  onNeutral: () => void;
}

const paddle =
  "flex-1 touch-none select-none rounded-xl border border-white/15 bg-gradient-to-b from-zinc-700/80 to-zinc-900 py-3 text-lg font-black text-zinc-100 shadow-inner transition active:scale-95 active:from-zinc-600";

export function ShiftButtons({ onUp, onDown, onNeutral }: Props) {
  return (
    <div className="flex gap-2" role="group" aria-label="Gear shift">
      <button type="button" className={paddle} onClick={onDown} aria-label="Shift down (Q)">
        − <span className="text-[10px] font-semibold text-zinc-500 pointer-coarse:hidden">Q</span>
      </button>
      <button type="button" className={`${paddle} max-w-14 text-base`} onClick={onNeutral} aria-label="Neutral (N)">
        N
      </button>
      <button type="button" className={paddle} onClick={onUp} aria-label="Shift up (E)">
        + <span className="text-[10px] font-semibold text-zinc-500 pointer-coarse:hidden">E</span>
      </button>
    </div>
  );
}
