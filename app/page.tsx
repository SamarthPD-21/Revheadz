import Link from "next/link";
import { Logo } from "../components/Logo";
import { Parade } from "../components/Parade";
import { Silhouette } from "../components/Silhouette";
import { garageList } from "../lib/vehicles/garage";

const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL;

/** Cars shown drifting across the Playground card (first that exist, in this order). */
const SHOWCASE = ["supra_mk4", "ferrari_f40", "skyline_r34", "lexus_lfa", "porsche_gt3rs", "mustang_gt", "rx7_fd", "gp_racer"];

export default function Home() {
  const list = garageList();
  const recorded = list.filter((v) => v.recorded).length;
  const showcase = SHOWCASE.map((id) => list.find((v) => v.id === id)).filter((v) => v !== undefined);

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="garage-backdrop pointer-events-none absolute inset-x-0 top-0 h-[560px]" />
      <div className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-8 sm:py-12">
        <header className="mb-10 sm:mb-14">
          <Logo size="lg" />
          <h1 className="mt-6 max-w-2xl text-3xl font-bold tracking-tight text-zinc-50 sm:text-5xl">
            Rev it. Shift it. <span className="text-zinc-400">Hear it.</span>
          </h1>
          <p className="mt-4 max-w-xl text-zinc-400">
            {list.length} real machines, from the 2JZ Supra to a screaming Formula 1 car, with engine sound built from recordings of each one. In
            your browser, keyboard or thumbs.
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]" aria-label="Modes">
          <Link href="/playground" className="mode-card group" style={{ "--accent": "#f97316" } as React.CSSProperties}>
            <div className="relative flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.24em] text-orange-400">Free play</p>
                <h2 className="mt-2 text-3xl font-black italic tracking-tight text-white sm:text-4xl">Playground</h2>
                <p className="mt-2 max-w-sm text-sm text-zinc-400">
                  Every machine in the garage. No timer, no rules: start it, rev it, bounce it off the limiter.
                </p>
              </div>
              <span className="mode-go" aria-hidden>
                <svg viewBox="0 0 16 16" className="h-5 w-5">
                  <path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </div>
            <div className="mode-parade relative mt-6" aria-hidden>
              <Parade>
                {[...showcase, ...showcase].map((v, i) => (
                  <div key={`${v.id}-${i}`} className="shrink-0 pr-6">
                    <div className="w-40 sm:w-48">
                      <Silhouette kind={v.silhouette} accent={v.accent} className="h-16 w-full" />
                      <p className="mt-1 truncate text-center text-[11px] font-medium text-zinc-500">{v.name}</p>
                    </div>
                  </div>
                ))}
              </Parade>
            </div>
            <ul className="relative mt-5 flex flex-wrap gap-2 text-xs text-zinc-300">
              <li className="stat-pill">
                <b>{list.length}</b> machines
              </li>
              <li className="stat-pill">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                <b>{recorded}</b> real recordings
              </li>
            </ul>
          </Link>

          <div className="mode-card mode-card-soon" style={{ "--accent": "#a3e635" } as React.CSSProperties} aria-disabled="true">
            <div className="relative flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.24em] text-lime-300">Head to head</p>
                <h2 className="mt-2 text-3xl font-black italic tracking-tight text-white sm:text-4xl">Drag Racing</h2>
                <p className="mt-2 max-w-sm text-sm text-zinc-400">Launch on the green, nail your shifts, beat the other car to the quarter mile.</p>
              </div>
              <span className="tag shrink-0 border-lime-300/30 text-lime-200">Coming soon</span>
            </div>
            <div className="tree relative mt-8 flex justify-center gap-3" aria-hidden>
              {["#facc15", "#facc15", "#facc15", "#22c55e"].map((c, i) => (
                <span key={i} className="tree-light" style={{ "--c": c, animationDelay: `${i * 0.45}s` } as React.CSSProperties} />
              ))}
            </div>
          </div>
        </section>

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
            Engine sounds are recordings of each machine; see credits for sources. Not affiliated with any manufacturer.
          </span>
        </footer>
      </div>
    </div>
  );
}
