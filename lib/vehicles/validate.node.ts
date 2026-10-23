import { existsSync } from "node:fs";
import path from "node:path";
import { allSoundFiles, vehicles } from "./index";

/**
 * Build-time check, run from Server Components: every sound a config references
 * must exist as both .ogg and its .mp3 fallback, or the build fails.
 */
export function assertVehicleFilesExist(): void {
  const missing: string[] = [];
  for (const v of vehicles) {
    const dir = path.join(process.cwd(), "public", "vehicles", v.id, "sounds");
    for (const file of allSoundFiles(v)) {
      for (const f of [file, file.replace(/\.ogg$/, ".mp3")]) {
        if (!existsSync(path.join(dir, f))) missing.push(`${v.id}/sounds/${f}`);
      }
    }
  }
  if (!missing.length) return;
  const message = `Missing sound files:\n - ${missing.join("\n - ")}`;
  // in dev, a sound set being rebuilt shouldn't take the whole site down: warn (that vehicle falls back to synthesis)
  if (process.env.NODE_ENV === "development") console.warn(message);
  else throw new Error(message);
}
