import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Barlow_Condensed, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// Plex for reading, Barlow Condensed for headings (timing-board narrow), Plex Mono for times.
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex" });
const display = Barlow_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-barlow" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono" });

const description = "Rev, drive and race real engine recordings in your browser, from a Toyota Supra to a Ferrari F1 car. Free, no install.";

// Absolute URLs for share images. Set NEXT_PUBLIC_SITE_URL for a custom domain.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "Revheadz: real engines you can drive", template: "%s | Revheadz" },
  description,
  openGraph: {
    title: "Revheadz: real engines you can drive",
    description,
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Revheadz: real engines you can drive" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0b0b0f",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${sans.variable} ${display.variable} ${mono.variable}`}>
      <body className="min-h-full">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
