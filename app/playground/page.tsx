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
          <h1 className="display mt-8 text-4xl text-zinc-50 sm:text-5xl">Playground</h1>
          <p className="mt-3 max-w-2xl text-zinc-400">
            Start any engine and drive it with nothing timing you. Not sure which one? Hit <b className="text-zinc-200">Hear it</b> on a card
            for a quick rev. Sounds best on headphones.
          </p>
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
