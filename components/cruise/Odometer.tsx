"use client";

const KEY = "revheadz:odometer";

/** Kilometres each car has done in Cruise, kept between visits. */
export function loadOdometer(id: string): number {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
    return Number.isFinite(all[id]) ? all[id] : 0;
  } catch {
    return 0;
  }
}

export function saveOdometer(id: string, km: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
    all[id] = km;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* not kept, still counts */
  }
}

/**
 * A mechanical odometer: six drums of whole kilometres and a tenths drum (the red one) that
 * rolls round smoothly as you drive, the next one up turning over with it at the end of each
 * kilometre, and a trip meter beside it.
 */
export function Odometer({ km, tripKm }: { km: number; tripKm: number }) {
  const tenths = km * 10;
  const digits: { value: number; roll: number; red?: boolean }[] = [];
  // the tenths drum turns continuously; each drum above it turns over only as the one below
  // passes from 9 to 0
  let carry = tenths % 1;
  let rest = Math.floor(tenths);
  digits.unshift({ value: rest % 10, roll: carry, red: true });
  for (let i = 0; i < 6; i++) {
    const below = rest % 10;
    carry = below === 9 ? carry : 0;
    rest = Math.floor(rest / 10);
    digits.unshift({ value: rest % 10, roll: carry });
  }
  return (
    <div className="cruise-odo" title="Kilometres this car has driven in Cruise, and this trip">
      <span className="cruise-odo-label">km</span>
      <span className="cruise-odo-drums" aria-label={`${km.toFixed(1)} kilometres`}>
        {digits.map((d, i) => (
          <span key={i} className={`cruise-odo-drum${d.red ? " red" : ""}`} aria-hidden>
            <span style={{ transform: `translateY(${(-(d.value + d.roll) * 100) / 11}%)` }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n, j) => (
                <i key={j}>{n}</i>
              ))}
            </span>
          </span>
        ))}
      </span>
      <span className="cruise-odo-trip">
        TRIP <b>{tripKm.toFixed(1)}</b>
      </span>
    </div>
  );
}
