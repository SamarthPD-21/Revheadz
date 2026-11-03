import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS } from "../lib/cruise/models";
import { vehicles } from "../lib/vehicles";

const root = join(__dirname, "..");

describe("cruise: the Blender-built car models", () => {
  it("every car (not the single-seaters or bikes) has a model, and every listed model is there", () => {
    const cars = vehicles.filter((v) => v.type === "car" && v.ui.silhouette !== "formula");
    for (const v of cars) expect(MODELS[v.id], v.id).toBeDefined();
    for (const [id, m] of Object.entries(MODELS)) {
      const file = join(root, "public/vehicles", id, m.file);
      expect(existsSync(file), file).toBe(true);
      // a binary glTF, under a megabyte (they're Draco-compressed)
      const head = readFileSync(file).subarray(0, 4).toString("latin1");
      expect(head, file).toBe("glTF");
      expect(readFileSync(file).length, file).toBeLessThan(1024 * 1024);
    }
  });

  it("the Draco decoder the loader asks for is served", () => {
    for (const f of ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"]) expect(existsSync(join(root, "public/draco", f)), f).toBe(true);
  });
});
