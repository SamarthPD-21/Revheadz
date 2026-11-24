"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "../lib/analytics";
import { blipRpm, playPreview, stopPreview } from "../lib/audio/preview";
import type { GarageVehicle } from "./GarageGrid";

/** The tach's sweep: 240 degrees, starting bottom-left. */
const SWEEP = 240;
const START = -120;

type HeroCar = GarageVehicle & { card: string; preview: NonNullable<GarageVehicle["preview"]> };

/**
 * The front page's opening: one car, big, with a rev counter under it. "Rev it" plays the car's
 * real recording and the needle follows the sound; the strip below swaps the car.
 */
export function HeroRev({ cars }: { cars: HeroCar[] }) {
  const [i, setI] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "revving">("idle");
  const needle = useRef<SVGGElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const frame = useRef(0);
  const car = cars[i];
  const max = Math.ceil((car.redlineRpm + 500) / 1000) * 1000;

  const show = (rpm: number) => {
    const a = START + (Math.min(rpm, max) / max) * SWEEP;
    needle.current?.setAttribute("transform", `rotate(${a.toFixed(2)} 100 100)`);
    if (readout.current) readout.current.textContent = (Math.round(rpm / 50) * 50).toLocaleString("en-US");
  };

  useEffect(() => {
    show(car.preview.idleRpm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [car]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      stopPreview();
    },
    [],
  );

  const rev = () => {
    if (state !== "idle") {
      stopPreview();
      return;
    }
    setState("loading");
    trackEvent("sound_preview", { vehicle: car.id, via: "hero" });
    void playPreview(
      car.base,
      car.preview,
      () => {
        cancelAnimationFrame(frame.current);
        show(car.preview.idleRpm);
        setState("idle");
      },
      (at) => {
        setState("revving");
        const tick = () => {
          show(blipRpm((performance.now() - at) / 1000, car.preview));
          frame.current = requestAnimationFrame(tick);
        };
        tick();
      },
    );
  };

  const pick = (n: number) => {
    stopPreview();
    setI(n);
  };

  const ticks = Array.from({ length: max / 1000 + 1 }, (_, k) => k);
  const redFrom = START + (car.redlineRpm / max) * SWEEP;

  return (
    <div className="hero-rev">
      <div className="hero-stage">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={car.id} src={car.card} alt={car.name} className="hero-car" width={720} height={300} />
      </div>

      <div className="hero-dash">
        <svg viewBox="0 0 200 150" className="hero-tach" aria-hidden>
          <path d={arc(START, redFrom)} className="hero-tach-track" />
          <path d={arc(redFrom, START + SWEEP)} className="hero-tach-red" />
          {ticks.map((k) => {
            const a = ((START + (k / (max / 1000)) * SWEEP) * Math.PI) / 180;
            const [x, y] = [100 + 64 * Math.sin(a), 100 - 64 * Math.cos(a)];
            return (
              <text key={k} x={x} y={y + 5} className="hero-tach-num">
                {k}
              </text>
            );
          })}
          <g ref={needle}>
            <line x1="100" y1="112" x2="100" y2="22" className="hero-tach-needle" />
          </g>
          <circle cx="100" cy="100" r="5" className="hero-tach-hub" />
        </svg>
        <p className="hero-rpm">
          <span ref={readout}>{car.preview.idleRpm.toLocaleString("en-US")}</span> rpm
        </p>
      </div>

      <div className="hero-meta">
        <div>
          <h2 className="hero-name">{car.name}</h2>
          <p className="hero-spec">
            {car.engineType}, {car.powerHp.toLocaleString("en-US")} hp, redline {car.redlineRpm.toLocaleString("en-US")}
          </p>
        </div>
        <div className="hero-actions">
          <button type="button" className="hero-rev-btn" onClick={rev} aria-pressed={state !== "idle"}>
            {state === "loading" ? "Starting…" : state === "revving" ? "Stop" : "Rev it"}
          </button>
          <Link href={`/drive/${car.id}`} className="hero-drive" onClick={() => trackEvent("vehicle_picked", { vehicle: car.id, via: "hero" })}>
            Drive it
          </Link>
        </div>
      </div>

      <ul className="hero-rail no-scrollbar" aria-label="Choose a car">
        {cars.map((c, n) => (
          <li key={c.id}>
            <button type="button" onClick={() => pick(n)} aria-pressed={n === i} aria-label={c.name} title={c.name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.card} alt="" loading="lazy" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An arc of the tach's ring between two angles (degrees, 0 = straight up). */
function arc(from: number, to: number): string {
  const p = (a: number) => {
    const r = (a * Math.PI) / 180;
    return `${(100 + 84 * Math.sin(r)).toFixed(2)} ${(100 - 84 * Math.cos(r)).toFixed(2)}`;
  };
  return `M ${p(from)} A 84 84 0 ${to - from > 180 ? 1 : 0} 1 ${p(to)}`;
}
