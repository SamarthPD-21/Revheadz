import Link from "next/link";
import { Logo } from "../components/Logo";
import { Parade } from "../components/Parade";
import { Silhouette } from "../components/Silhouette";
import { CLASSES } from "../lib/drag/classes";
import { StripBackdrop } from "../components/StripBackdrop";
import { getVehicle } from "../lib/vehicles";
import { garageList } from "../lib/vehicles/garage";

const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL;

/** Cars shown drifting across the Playground card (first that exist, in this order). */
const SHOWCASE = ["supra_mk4", "ferrari_f40", "skyline_r34", "lexus_lfa", "porsche_gt3rs", "mustang_gt", "rx7_fd", "gp_racer"];

export default function Home() {
  const list = garageList();
  const recorded = list.filter((v) => v.recorded).length;
  const showcase = SHOWCASE.map((id) => list.find((v) => v.id === id)).filter((v) => v !== undefined);
  const arrow = (
    <span className="mode-go" aria-hidden>
      <svg viewBox="0 0 16 16" className="h-4 w-4">
        <path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );

  // staged at the line behind the hero: a Supra and a Skyline, the old rivals
  const staged = [getVehicle("supra_mk4")!, getVehicle("skyline_r34")!] as const;

  return (
    <div className="relative overflow-hidden">
    <div className="home-backdrop" aria-hidden>
      <StripBackdrop cars={[staged[0], staged[1]]} />
    </div>
    <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:py-8">
      <header className="flex items-center justify-between">
        <Logo size="md" />
        <Link href="/credits" className="text-sm text-zinc-400 hover:text-zinc-100">
          Credits
        </Link>
      </header>

      <section className="mt-14 sm:mt-20">
        <h1 className="display max-w-3xl text-5xl text-zinc-50 sm:text-7xl">Real engines, in your browser</h1>
        <p className="mt-5 max-w-xl text-lg text-zinc-400">
          Start them, rev them, shift through the gears. Each car&apos;s sound is built from recordings of that car, from a Toyota Supra to a 2004
          Ferrari Formula 1 car.
        </p>
        <p className="mt-6 text-sm text-zinc-500">
          {list.length} machines, {recorded} of them recorded from the real thing. {CLASSES.length} drag classes.
        </p>
      </section>

      <section className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Modes">
        <Link href="/playground" className="mode-card group">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow">Free play</p>
              <h2 className="display mt-2 text-4xl text-white">Playground</h2>
              <p className="mt-2 max-w-sm text-sm text-zinc-400">Pick any car and drive it: throttle, gears, brakes and the rev limiter. No timer.</p>
            </div>
            {arrow}
          </div>
          <div className="mode-parade relative mt-6" aria-hidden>
            <Parade>
              {[...showcase, ...showcase].map((v, i) => (
                <div key={`${v.id}-${i}`} className="shrink-0 pr-6">
                  <div className="w-36 sm:w-44">
                    <Silhouette kind={v.silhouette} accent={v.accent} className="h-14 w-full" />
                    <p className="mt-1 truncate text-center text-[11px] text-zinc-500">{v.name}</p>
                  </div>
                </div>
              ))}
            </Parade>
          </div>
        </Link>

        <Link href="/drag" className="mode-card group">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow">Head to head</p>
              <h2 className="display mt-2 text-4xl text-white">Drag racing</h2>
              <p className="mt-2 max-w-sm text-sm text-zinc-400">
                A quarter mile against a friend online or the CPU. Cars race in classes, so the launch and the shifts decide it.
              </p>
            </div>
            {arrow}
          </div>
          <div className="mt-8 flex justify-center gap-2.5" aria-hidden>
            {["#facc15", "#facc15", "#facc15", "#22c55e"].map((c, i) => (
              <span key={i} className="tree-light" style={{ "--c": c, animationDelay: `${i * 0.45}s` } as React.CSSProperties} />
            ))}
          </div>
        </Link>

        <Link href="/cruise" className="mode-card group md:col-span-2 xl:col-span-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow">Sit back</p>
              <h2 className="display mt-2 text-4xl text-white">Cruise</h2>
              <p className="mt-2 max-w-sm text-sm text-zinc-400">
                An endless 3D road through hills, forest and mountains. Watch the day turn to night, bring in the rain, or let the autopilot drive.
              </p>
            </div>
            {arrow}
          </div>
          <div className="cruise-mini mt-6" aria-hidden>
            <span className="cruise-mini-sun" />
            <span className="cruise-mini-hills" />
            <span className="cruise-mini-road" />
          </div>
        </Link>
      </section>

      <footer className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[#1c1c22] pt-6 text-sm text-zinc-500 sm:mt-20">
        <Link href="/credits" className="hover:text-zinc-200">
          Sound credits
        </Link>
        {FEEDBACK_URL && (
          <a href={FEEDBACK_URL} className="hover:text-zinc-200" target="_blank" rel="noreferrer">
            Send feedback
          </a>
        )}
        <span className="text-xs text-zinc-600">Not affiliated with any manufacturer.</span>
      </footer>
    </div>
    </div>
  );
}
