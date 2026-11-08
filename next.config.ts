import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // every page as page/index.html, so plain static hosts (Render) serve /cruise as well as Vercel does
  trailingSlash: true,
  images: { unoptimized: true },
  // the playground runs edge to edge, so the dev badge would sit on top of the controls
  // (compile and runtime errors still show)
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
