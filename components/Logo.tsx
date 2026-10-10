import { useId } from "react";

/**
 * The Revheadz mark: a forward-leaning R whose bowl is a rev-counter arc running into the
 * red, with the leg as the needle on its pivot. Same artwork as app/icon.svg.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 64" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d1d25" />
          <stop offset="1" stopColor="#0b0b0f" />
        </linearGradient>
        <radialGradient id={`${id}glow`} cx="0.72" cy="0.74" r="0.62">
          <stop offset="0" stopColor="#f97316" stopOpacity="0.42" />
          <stop offset="1" stopColor="#f97316" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}arc`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0.42" stopColor="#f4f4f5" />
          <stop offset="0.6" stopColor="#fb923c" />
          <stop offset="0.9" stopColor="#ef4444" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id}bg)`} />
      <rect width="64" height="64" rx="15" fill={`url(#${id}glow)`} />
      <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="14.25" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="1.5" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" transform="translate(6.5 0) skewX(-8)">
        <path d="M17 50V14h15a11 11 0 0 1 0 22H24" stroke={`url(#${id}arc)`} strokeWidth="7" />
        <path className="logo-needle" d="M30 36L45 50.5" stroke="#f97316" strokeWidth="6" />
        <circle cx="30" cy="36" r="2" fill="#0b0b0f" />
      </g>
    </svg>
  );
}

/** Mark plus the REVHEADZ wordmark. */
export function Logo({ size = "md", className = "" }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const mark = size === "lg" ? "h-14 w-14 sm:h-16 sm:w-16" : size === "md" ? "h-9 w-9" : "h-7 w-7";
  const text = size === "lg" ? "text-4xl sm:text-5xl" : size === "md" ? "text-xl" : "text-base";
  return (
    <span className={`logo inline-flex items-center gap-3 ${className}`}>
      <LogoMark className={`${mark} shrink-0 drop-shadow-[0_6px_18px_rgba(249,115,22,0.25)]`} />
      <span className={`${text} font-black italic leading-none tracking-tight`}>
        <span className="text-zinc-50">REV</span>
        <span className="bg-gradient-to-r from-orange-400 to-red-500 bg-clip-text pr-1 text-transparent">HEADZ</span>
      </span>
    </span>
  );
}
