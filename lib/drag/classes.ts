import PARITY from "./parity.json";

/**
 * Heads-up drag classes. Cars of similar pace race each other, and within a class each car's
 * engine is trimmed slightly (performance parity, like spec racing's balance of performance)
 * so every car's perfect quarter mile matches the class target to within a few milliseconds.
 * The cars keep their own sound, gearing, launch and shift points; the driver decides it.
 *
 * Why parity: two typical drivers in identical cars finish about ±80 ms apart. With a 100 ms
 * car gap the slower car wins only ~9% of races, at 200 ms ~1% (Monte Carlo over the real
 * physics), so without it the quicker car nearly always wins. Regenerate the trims with
 * `GEN_PARITY=1 npx vitest run tests/drag-parity.test.ts` after changing any car's physics.
 */
export interface DragClass {
  id: string;
  name: string;
  blurb: string;
  cars: string[];
}

export const CLASSES: DragClass[] = [
  { id: "street", name: "Street", blurb: "JDM legends, sports cars and a Harley", cars: ["supra_mk4", "skyline_r34", "rx7_fd", "jdm_i6_turbo", "synth_v6", "bmw_m3_e46", "subaru_sti", "honda_s2000", "vtwin_cruiser"] },
  { id: "muscle", name: "Muscle", blurb: "V8 muscle and a hot hatch", cars: ["mustang_gt", "muscle_v8", "hot_hatch"] },
  { id: "gt", name: "Grand Touring", blurb: "Twin-turbo icons and big GTs", cars: ["ferrari_f40", "twin_turbo_v6", "flat6_sports", "v12_gt", "amg_c63"] },
  { id: "supercar", name: "Supercar", blurb: "The modern supercar pack", cars: ["corvette_z06", "aventador_svj", "v10_supercar", "hellcat", "porsche_gt3rs", "lexus_lfa", "twin_turbo_i6", "audi_r8_v10"] },
  { id: "track", name: "Track", blurb: "Race-bred and screaming", cars: ["superbike_i4", "gt_racer", "boxer4_rally", "pagani_zonda"] },
  { id: "hyper", name: "Hyper", blurb: "Hypercar, Le Mans and hyperbikes", cars: ["bugatti_chiron", "rotary_twin", "ninja_h2", "panigale_v4"] },
  { id: "formula", name: "Formula", blurb: "Formula 1, 19,000 rpm", cars: ["ferrari_f2004", "gp_racer"] },
];

export const classOf = (carId: string): DragClass => CLASSES.find((c) => c.cars.includes(carId)) ?? CLASSES[0];

/** The class's target quarter mile (perfect run), ms. */
export const classTarget = (c: DragClass): number | undefined => (PARITY.classes as Record<string, number>)[c.id];
