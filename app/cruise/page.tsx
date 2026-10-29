import type { Metadata } from "next";
import Link from "next/link";
import { GarageGrid } from "../../components/GarageGrid";
import { Logo } from "../../components/Logo";
import { garageList } from "../../lib/vehicles/garage";

export const metadata: Metadata = {
  title: "Cruise",
  description: "Pick a machine and take it down an endless road: hills, forest, desert and mountains, from sunrise to the stars.",
};

export default function CruiseGarage() {
  const list = garageList();
  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="cruise-backdrop pointer-events-none absolute inset-x-0 top-0 h-[460px]" />
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
          <p className="mt-8 text-xs font-bold uppercase tracking-[0.24em] text-amber-300">Cruise</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">No timer. Just the road.</h1>
          <p className="mt-3 max-w-2xl text-zinc-400">
            An endless road through hills, forest, desert and mountains that never runs the same way twice. Watch the day go by from sunrise to the
            stars, bring in fog or rain, and switch on the <b className="text-zinc-200">autopilot</b> to just sit back and listen.
          </p>
        </header>
        <GarageGrid vehicles={list} base="/cruise" />
      </div>
    </div>
  );
}
