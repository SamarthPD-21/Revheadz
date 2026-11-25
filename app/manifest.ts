import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Revheadz: real engines you can drive",
    short_name: "Revheadz",
    description: "Rev, drive and race real engine recordings in your browser. Free, no install.",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0b0f",
    theme_color: "#0b0b0f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
