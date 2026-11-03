/**
 * Writes what Blender needs to model each car (scripts/blender/cars.json): its real size, the
 * side profile and window outline the game draws it from, where its wheels are, and the
 * details that make it that car. Run with:
 *
 *   npx jiti scripts/blender/export-cars.ts
 *
 * then build the models with scripts/blender/build-cars.sh.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cruiseShape, featuresOf } from "../../components/cruise/carShapes";
import { area } from "../../components/drag/scene25d";
import { specOf } from "../../lib/cruise/specs";
import { vehicles } from "../../lib/vehicles";

const here = dirname(fileURLToPath(import.meta.url));

const cars = vehicles
  .filter((v) => v.type === "car" && v.ui.silhouette !== "formula")
  .map((cfg) => {
    const shape = cruiseShape(cfg);
    const spec = specOf(cfg);
    const main = shape.bodies.reduce((a, c) => (Math.abs(area(c)) > Math.abs(area(a)) ? c : a));
    return {
      id: cfg.id,
      name: cfg.name,
      silhouette: cfg.ui.silhouette,
      accent: cfg.ui.accent,
      year: parseInt(cfg.ui.year ?? "2000", 10),
      front: spec.front,
      dims: spec.dims ?? [shape.len, shape.width, shape.height, 2.6],
      wheelRadius: cfg.gearbox.wheelRadiusM,
      len: shape.len,
      width: shape.width,
      height: shape.height,
      belt: shape.belt,
      profile: main,
      windows: shape.windows,
      wheels: shape.wheels,
      wheelZ: shape.wheelZ,
      features: featuresOf(cfg),
    };
  });

writeFileSync(join(here, "cars.json"), JSON.stringify(cars, null, 1));
console.log(`wrote ${cars.length} cars to scripts/blender/cars.json`);
