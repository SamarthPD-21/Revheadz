import type { Metadata } from "next";
import Link from "next/link";
import { GarageGrid } from "../../components/GarageGrid";
import { Logo } from "../../components/Logo";
import { garageList } from "../../lib/vehicles/garage";
import { assertVehicleFilesExist } from "../../lib/vehicles/validate.node";

export const metadata: Metadata = {
  title: "Playground",
  description: "Every machine in the garage: hear it rev, then start it, shift it and bounce it off the limiter.",
};

export default function Playground() {
  assertVehicleFilesExist(); // fails the build if a config references a missing sound file
  const list = garageList();
  const recorded = list.filter((v) => v.recorded).length;
  const makes = new Set(list.map((v) => v.make).filter(Boolean)).size;

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="garage-backdrop pointer-events-none absolute inset-x-0 top-0 h-[420px]" />
      <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:py-10">
        <header className="mb-6 sm:mb-8">
          <nav className="flex items-center justify-between gap-4" aria-label="Site">
            <Link href="/" aria-label="Revheadz home" className="transition active:scale-95">
              <Logo size="md" />
            </Link>
            <Link href="/" className="chip shrink-0">
              ← Modes
            </Link>
          </nav>
          <p className="mt-8 text-xs font-bold uppercase tracking-[0.24em] text-orange-400">Playground</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">Pick a machine. Make some noise.</h1>
          <p className="mt-3 max-w-2xl text-zinc-400">
            No timer, no rules: start any engine, rev it, shift it and bounce it off the limiter. Tap <b className="text-zinc-200">Hear it</b> on a
            card for a quick rev first. Headphones recommended.
          </p>
          <ul className="mt-5 flex flex-wrap gap-2 text-xs text-zinc-300" aria-label="At a glance">
            <li className="stat-pill">
              <b>{list.length}</b> machines
            </li>
            <li className="stat-pill">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
              <b>{recorded}</b> real recordings
            </li>
            <li className="stat-pill">
              <b>{makes}</b> makes
            </li>
          </ul>
        </header>

        <GarageGrid vehicles={list} />

        <footer className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/5 pt-8 text-sm text-zinc-500 sm:mt-16">
          <Link href="/credits" className="underline-offset-4 hover:text-zinc-200 hover:underline">
            Sound credits
          </Link>
          <span className="text-xs text-zinc-600">Engine sounds are recordings of each machine; see credits for sources. Not affiliated with any manufacturer.</span>
        </footer>
      </div>
    </div>
  );
}
