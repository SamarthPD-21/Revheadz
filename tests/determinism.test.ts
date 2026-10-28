import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replay, type DriveLog } from "../lib/drag/race";
import { pexp } from "../lib/sim/portableMath";
import { loadConfig } from "./helpers";

describe("determinism", () => {
  it("pexp matches Math.exp to within a few ulps", () => {
    for (let x = -60; x <= 60; x += 0.0137) {
      const want = Math.exp(x);
      expect(Math.abs(pexp(x) - want) / want).toBeLessThan(4e-15);
    }
    expect(pexp(0)).toBe(1);
    expect(pexp(-1000)).toBe(0);
  });

  it("the replayed physics uses no engine-dependent Math functions", () => {
    // Math.exp/pow/sin/... are implementation-defined and differ between browsers; use portableMath
    const files = [
      ...readdirSync("lib/sim").filter((f) => f.endsWith(".ts") && f !== "portableMath.ts").map((f) => path.join("lib/sim", f)),
      "lib/drag/race.ts",
      "lib/drag/classes.ts",
    ];
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/Math\.(exp|expm1|pow|sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|log|log2|log10|log1p|cbrt|hypot)\b|\*\*/);
    }
  });

  // Finish times for fixed drive logs, to the last bit. Every browser and the server must get
  // exactly these, or PvP results and verified leaderboards could disagree. If a physics change
  // moves them on purpose, update them here and bump the replay version.
  // one car per kind of gearbox: manual, torque-converter auto, sequential, bike quickshifter,
  // dual-clutch and single-clutch automated manual
  const GOLDEN: [string, DriveLog["events"], number][] = [
    ["supra_mk4", [[183.4, "launch"], [3153.7, "up"], [6204.7, "up"], [10667.7, "up"]], 13702.653139899581],
    ["hellcat", [[183.4, "launch"], [1920.7, "up"], [3422.7, "up"], [6479.7, "up"], [9993.7, "up"]], 11251.252501970072],
    ["ferrari_f2004", [[183.4, "launch"], [1942.7, "up"], [2696.7, "up"], [3635.7, "up"], [4859.7, "up"], [6654.7, "up"]], 8284.894577653857],
    ["panigale_v4", [[183.4, "launch"], [2675.7, "up"], [3914.7, "up"], [5595.7, "up"], [7481.7, "up"]], 8831.022795555875],
    ["bugatti_chiron", [[183.4, "launch"], [1931.7, "up"], [3066.7, "up"], [4818.7, "up"], [7305.7, "up"]], 9065.63961042117],
    ["lexus_lfa", [[183.4, "launch"], [2610.7, "up"], [4402.7, "up"], [6608.7, "up"], [9204.7, "up"]], 11116.706266336916],
  ];
  it("replays fixed drive logs to exactly the recorded finish times", () => {
    for (const [id, events, elapsed] of GOLDEN) expect(replay(loadConfig(id), { assist: true, events }).elapsedMs, id).toBe(elapsed);
  });
});
