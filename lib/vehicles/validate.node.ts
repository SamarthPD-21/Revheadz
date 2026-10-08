import { existsSync } from "node:fs";
import path from "node:path";
import { referencedSoundFiles, vehicles } from "./index";

/**
 * Build-time check, run from Server Components: every sound a config references
 * must exist as both .ogg and its .mp3 fallback, or the build fails.
 */
export function assertVehicleFilesExist(): void {
  const missing: string[] = [];
  for (const v of vehicles) {
    const dir = path.join(process.cwd(), "public", "vehicles", v.id, "sounds");
    for (const file of referencedSoundFiles(v)) {
      for (const f of [file, file.replace(/\.ogg$/, ".mp3")]) {
        if (!existsSync(path.join(dir, f))) missing.push(`${v.id}/sounds/${f}`);
      }
    }
  }
  if (missing.length) throw new Error(`Missing sound files:\n - ${missing.join("\n - ")}`);
}
