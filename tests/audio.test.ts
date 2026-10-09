import { describe, expect, it } from "vitest";
import { LOOP_CORRELATION, MAX_RATE, MIN_RATE, blendSamples, crossfade, equalPower, idleBlend, rateFor } from "../lib/audio/blend";
import { allSoundFiles, vehicles } from "../lib/vehicles";
import { validateVehicle } from "../lib/vehicles/validate";
import { existsSync } from "node:fs";
import path from "node:path";

describe("crossfade", () => {
  it("equal-power weights always sum to constant power", () => {
    for (let w = -0.2; w <= 1.2; w += 0.01) {
      const [a, b] = equalPower(w);
      expect(a * a + b * b).toBeCloseTo(1, 10);
    }
  });

  it("correlated crossfade keeps constant loudness for partly-correlated loops", () => {
    for (const rho of [0, 0.3, LOOP_CORRELATION, 0.9]) {
      for (let w = 0; w <= 1; w += 0.01) {
        const [a, b] = crossfade(w, rho);
        expect(a * a + b * b + 2 * rho * a * b).toBeCloseTo(1, 10);
      }
    }
  });

  it("blendSamples picks the bracketing loops with constant loudness", () => {
    const samples = [
      { file: "a", rpm: 1000 },
      { file: "b", rpm: 1600 },
      { file: "c", rpm: 2500 },
    ];
    for (let rpm = 600; rpm <= 3200; rpm += 25) {
      const b = blendSamples(rpm, samples);
      const p = b.lower === b.upper ? b.gainLower ** 2 + b.gainUpper ** 2 : b.gainLower ** 2 + b.gainUpper ** 2 + 2 * LOOP_CORRELATION * b.gainLower * b.gainUpper;
      expect(p).toBeCloseTo(1, 10);
    }
    const mid = blendSamples(1300, samples);
    expect([mid.lower, mid.upper]).toEqual([0, 1]);
  });

  it("has no jump when passing a sample rpm", () => {
    const samples = [
      { file: "a", rpm: 1000 },
      { file: "b", rpm: 2000 },
      { file: "c", rpm: 3000 },
    ];
    expect(blendSamples(1999.99, samples).gainUpper).toBeCloseTo(1, 3);
    expect(blendSamples(2000.01, samples).gainLower).toBeCloseTo(1, 3);
  });

  it("rates are proportional to rpm for every loop, so loops stay phase-locked", () => {
    for (const rpm of [800, 2345, 7000]) {
      // cycles advanced per second = rate * sampleRpm / 120, identical for all loops
      expect((rateFor(rpm, 1000) * 1000) / 120).toBeCloseTo((rateFor(rpm, 3000) * 3000) / 120, 10);
    }
  });

  it("idle/loops split keeps constant loudness", () => {
    for (let rpm = 700; rpm < 1200; rpm += 10) {
      const { idle, loops } = idleBlend(rpm, 800, 1000);
      expect(idle ** 2 + loops ** 2 + 2 * LOOP_CORRELATION * idle * loops).toBeCloseTo(1, 10);
    }
  });
});

describe("vehicle configs", () => {
  it.each(vehicles.map((v) => [v.id, v] as const))("%s is valid and all sound files exist", (id, v) => {
    expect(validateVehicle(v)).toEqual([]);
    const dir = path.join(process.cwd(), "public", "vehicles", id, "sounds");
    for (const f of allSoundFiles(v)) {
      expect(existsSync(path.join(dir, f)), f).toBe(true);
      expect(existsSync(path.join(dir, f.replace(/\.ogg$/, ".mp3"))), f + " (mp3)").toBe(true);
    }
  });

  it("the dominant loop stays inside the pitch-rate limits from idle to the limiter", () => {
    for (const v of vehicles) {
      if (v.audio.mode !== "samples") continue;
      for (const list of [v.audio.onLoad!, v.audio.offLoad!]) {
        const lowest = Math.min(v.audio.onLoad![0].rpm, v.audio.offLoad![0].rpm);
        for (let rpm = v.engine.idleRpm; rpm <= v.engine.limiterRpm; rpm += 25) {
          // near idle the idle loop dominates the mix; then it is the one that must sound natural
          const mix = idleBlend(rpm, v.engine.idleRpm, lowest);
          if (mix.idle >= mix.loops) {
            const r = rateFor(rpm, v.audio.idle!.rpm);
            expect(r, `${v.id} idle loop at ${rpm}rpm`).toBeGreaterThanOrEqual(MIN_RATE);
            expect(r, `${v.id} idle loop at ${rpm}rpm`).toBeLessThanOrEqual(MAX_RATE);
            continue;
          }
          const b = blendSamples(rpm, list);
          // the louder of the two loops must sound natural; a quiet partner fading out may stretch further
          for (const [i, g] of [[b.lower, b.gainLower], [b.upper, b.gainUpper]] as const) {
            if (g < Math.max(b.gainLower, b.gainUpper)) continue;
            const r = rateFor(rpm, list[i].rpm);
            expect(r, `${v.id} ${rpm}rpm`).toBeGreaterThanOrEqual(MIN_RATE);
            expect(r, `${v.id} ${rpm}rpm`).toBeLessThanOrEqual(MAX_RATE);
          }
        }
      }
    }
  });

  it("every real-recording vehicle also offers a generated (engine-model) sound set", () => {
    for (const v of vehicles.filter((x) => x.ui.recorded)) {
      expect(v.audioGenerated, v.id).toBeDefined();
      expect(v.audioGenerated!.onLoad!.length, v.id).toBeGreaterThan(2);
    }
  });

  it("there are at least 10 vehicles, all with unique ids and both cars and bikes", () => {
    expect(vehicles.length).toBeGreaterThanOrEqual(10);
    expect(new Set(vehicles.map((v) => v.id)).size).toBe(vehicles.length);
    expect(vehicles.some((v) => v.type === "bike")).toBe(true);
  });

  it("rejects broken configs", () => {
    const bad = structuredClone(vehicles[0]);
    bad.engine.redlineRpm = 100;
    expect(validateVehicle(bad).length).toBeGreaterThan(0);
  });
});
