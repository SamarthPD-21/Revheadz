import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { vehicles } from "../lib/vehicles";

describe("start sounds", () => {
  it("every vehicle has a start sound, in both sound sets, as .ogg and .mp3", () => {
    for (const v of vehicles) {
      for (const set of [v.audio, v.audioGenerated].filter((a) => a?.mode === "samples")) {
        const start = set!.oneShots?.start;
        expect(start, `${v.id} start`).toBeTruthy();
        const file = path.join(process.cwd(), "public", "vehicles", v.id, "sounds", start!);
        expect(existsSync(file), file).toBe(true);
        expect(existsSync(file.replace(/\.ogg$/, ".mp3")), file).toBe(true);
      }
    }
  });
});
