import Link from "next/link";
import { GarageGrid, type GarageVehicle } from "../components/GarageGrid";
import { Logo } from "../components/Logo";
import { vehicles } from "../lib/vehicles";
import { assertVehicleFilesExist } from "../lib/vehicles/validate.node";

const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL;

export default function Garage() {
  assertVehicleFilesExist(); // fails the build if a config references a missing sound file

  const list: GarageVehicle[] = vehicles.map((v) => ({
    id: v.id,
    name: v.name,
    type: v.type,
    description: v.description,
    category: v.ui.category,
    layout: v.ui.layout,
    displacement: v.ui.displacement,
    powerHp: v.ui.powerHp,
    redlineRpm: v.engine.redlineRpm,
    accent: v.ui.accent,
    silhouette: v.ui.silhouette,
    turbo: Boolean(v.turbo),
    synth: v.audio.mode === "synth",
    recorded: Boolean(v.ui.recorded),
  }));
  const recorded = list.filter((v) => v.recorded).length;

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="garage-backdrop pointer-events-none absolute inset-x-0 top-0 h-[560px]" />
      <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-8 sm:py-12">
        <header className="mb-8 sm:mb-12">
          <Logo size="lg" />
          <h1 className="mt-6 max-w-2xl text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
            Rev it. Shift it. <span className="text-zinc-400">Hear it.</span>
          </h1>
          <p className="mt-3 max-w-xl text-zinc-400">
            Pick a machine, hit start and bounce it off the limiter. Real engine recordings, a live engine model, turbo flutter and
            overrun crackle, all in your browser. Keyboard or thumbs. Headphones recommended.
          </p>
          <ul className="mt-5 flex flex-wrap gap-2 text-xs text-zinc-300" aria-label="At a glance">
            <li className="stat-pill">
              <b>{list.length}</b> machines
            </li>
            <li className="stat-pill">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
              <b>{recorded}</b> real recordings
            </li>
            <li className="stat-pill">Free · no install</li>
          </ul>
        </header>

        <GarageGrid vehicles={list} />

        <footer className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/5 pt-8 text-sm text-zinc-500 sm:mt-16">
          <Logo size="sm" className="opacity-70" />
          <Link href="/credits" className="underline-offset-4 hover:text-zinc-200 hover:underline">
            Sound credits
          </Link>
          {FEEDBACK_URL && (
            <a href={FEEDBACK_URL} className="underline-offset-4 hover:text-zinc-200 hover:underline" target="_blank" rel="noreferrer">
              Send feedback
            </a>
          )}
          <span className="basis-full text-xs text-zinc-600 sm:basis-auto">
            Vehicle names are generic. Engine sounds are real recordings or original synthesis; see credits.
          </span>
        </footer>
      </div>
    </div>
  );
}
