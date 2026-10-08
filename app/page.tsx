import Link from "next/link";
import { GarageGrid, type GarageVehicle } from "../components/GarageGrid";
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

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(ellipse_at_top,rgba(249,115,22,0.18),transparent_65%)]" />
      <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-10 sm:py-14">
        <header className="mb-8 sm:mb-10">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-orange-400">Engine sound simulator</p>
          <h1 className="mt-2 bg-gradient-to-br from-white to-zinc-400 bg-clip-text text-5xl font-black tracking-tight text-transparent sm:text-6xl">
            Revheadz
          </h1>
          <p className="mt-3 max-w-xl text-zinc-400">
            Pick a machine, hit start, and rev it. Shift through the gears, bounce it off the limiter, pop it on the overrun.
            Keyboard or thumbs. Headphones recommended.
          </p>
        </header>

        <GarageGrid vehicles={list} />

        <footer className="mt-auto flex flex-wrap gap-x-6 gap-y-2 pt-14 text-sm text-zinc-500">
          <Link href="/credits" className="underline underline-offset-4 hover:text-zinc-200">
            Sound credits
          </Link>
          {FEEDBACK_URL && (
            <a href={FEEDBACK_URL} className="underline underline-offset-4 hover:text-zinc-200" target="_blank" rel="noreferrer">
              Send feedback
            </a>
          )}
          <span>Vehicle names are generic. Engine sounds are real recordings or original synthesis; see credits.</span>
        </footer>
      </div>
    </div>
  );
}
