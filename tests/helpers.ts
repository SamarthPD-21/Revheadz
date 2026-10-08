import { readFileSync } from "node:fs";
import path from "node:path";
import { Simulation } from "../lib/sim/Simulation";
import type { VehicleConfig } from "../lib/vehicles/types";

export function loadConfig(id: string): VehicleConfig {
  const file = path.join(process.cwd(), "public", "vehicles", id, "config.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Seeded RNG so event tests are deterministic. */
export function seeded(seed = 1): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function run(sim: Simulation, seconds: number) {
  const steps = Math.round(seconds * 120);
  for (let i = 0; i < steps; i++) sim.step(1 / 120);
}

export function startedSim(id = "muscle_v8", seed = 1) {
  const sim = new Simulation(loadConfig(id), seeded(seed));
  sim.toggleIgnition();
  run(sim, 1.2);
  return sim;
}
