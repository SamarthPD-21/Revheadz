import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSES } from "../lib/drag/classes";
import PARITY from "../lib/drag/parity.json";
import { cueRpm, perfectRun } from "../lib/drag/race";
import { vehicles } from "../lib/vehicles";
import { loadConfig } from "./helpers";

const GEN = Boolean(process.env.GEN_PARITY);

describe("drag classes and performance parity", () => {
  it("every vehicle is in exactly one class", () => {
    for (const v of vehicles) expect(CLASSES.filter((c) => c.cars.includes(v.id)).length, v.id).toBe(1);
    for (const c of CLASSES) for (const id of c.cars) expect(vehicles.some((v) => v.id === id), id).toBe(true);
  });

  it.runIf(GEN)("generates lib/drag/parity.json (GEN_PARITY=1)", () => {
    const out: { classes: Record<string, number>; cars: Record<string, { cue: number; trim: number; stockMs: number }> } = { classes: {}, cars: {} };
    for (const c of CLASSES) {
      const base = c.cars.map((id) => {
        const cfg = loadConfig(id);
        const cue = cueRpm(cfg);
        return { id, cfg, cue, ms: perfectRun(cfg, cue) };
      });
      const sorted = [...base].sort((a, b) => a.ms - b.ms);
      const target = sorted[Math.floor((sorted.length - 1) / 2)].ms; // the median car runs stock
      out.classes[c.id] = Math.round(target * 10) / 10;
      for (const b of base) {
        // bisect the torque trim that makes this car's perfect run hit the target
        let lo = 0.5;
        let hi = 2;
        for (let i = 0; i < 30 && hi - lo > 1e-4; i++) {
          const mid = (lo + hi) / 2;
          if (perfectRun(b.cfg, b.cue, mid) > target) lo = mid;
          else hi = mid;
        }
        out.cars[b.id] = { cue: Math.round(b.cue), trim: Math.round(((lo + hi) / 2) * 10000) / 10000, stockMs: Math.round(b.ms) };
      }
    }
    writeFileSync(path.join(process.cwd(), "lib/drag/parity.json"), JSON.stringify(out, null, 2) + "\n");
  });

  it.skipIf(GEN)("within each class every car's perfect run matches the target", () => {
    const P = PARITY as { classes: Record<string, number>; cars: Record<string, { cue: number; trim: number }> };
    for (const c of CLASSES) {
      const target = P.classes[c.id];
      expect(target, c.id).toBeGreaterThan(0);
      for (const id of c.cars) {
        const p = P.cars[id];
        const ms = perfectRun(loadConfig(id), p.cue, p.trim);
        expect(Math.abs(ms - target), `${id} in ${c.id}`).toBeLessThan(5);
        expect(p.trim, `${id} trim`).toBeGreaterThan(0.6);
        expect(p.trim, `${id} trim`).toBeLessThan(1.8);
      }
    }
  });
});
