import type { Metadata } from "next";
import Link from "next/link";
import credits from "../../credits.json";
import { Logo } from "../../components/Logo";

export const metadata: Metadata = { title: "Sound credits", description: "Who made every sound in Revheadz, and under which license." };

export default function Credits() {
  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 py-10">
      <Link href="/" aria-label="Back to garage" className="inline-block transition hover:brightness-110">
        <Logo size="md" />
      </Link>
      <h1 className="mt-8 text-3xl font-bold">Sound credits</h1>
      <p className="mt-2 text-zinc-400">Only original, CC0 or CC-BY sounds are used. Vehicle names are generic on purpose.</p>
      <ul className="mt-6 space-y-4">
        {credits.map((c) => (
          <li key={c.vehicle + c.files} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <h2 className="font-semibold">{c.vehicle}</h2>
            <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-y-1 text-sm text-zinc-300">
              <dt className="text-zinc-500">Files</dt><dd>{c.files}</dd>
              <dt className="text-zinc-500">Author</dt><dd>{c.author}</dd>
              <dt className="text-zinc-500">Source</dt>
              <dd>{/^https?:/.test(c.source) ? <a className="underline" href={c.source}>{c.source}</a> : c.source}</dd>
              <dt className="text-zinc-500">License</dt><dd>{c.license}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
