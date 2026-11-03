/**
 * Cars with an authored 3D model (a .glb made in Blender or downloaded) in
 * public/vehicles/<id>/. Every car not listed here keeps its procedural body, so models can be
 * added one car at a time. Only listed cars are fetched, so there are no 404s for the rest.
 */
export interface ModelEntry {
  /** File name inside public/vehicles/<id>/. */
  file: string;
  /** Extra turn about the vertical axis, degrees, if the model was exported facing the wrong way. */
  yawDeg?: number;
  /** Repaint every material whose name starts with "paint" in the car's accent colour. */
  repaint?: boolean;
}

/**
 * Every car (not the single-seaters or the bikes) has a model built in Blender from its real
 * dimensions and details by scripts/blender/build-cars.sh. They're made in its own colour, so
 * they aren't repainted.
 */
export const MODELS: Record<string, ModelEntry> = {
  supra_mk4: { file: "model.glb" },
  skyline_r34: { file: "model.glb" },
  twin_turbo_v6: { file: "model.glb" },
  rx7_fd: { file: "model.glb" },
  honda_s2000: { file: "model.glb" },
  subaru_sti: { file: "model.glb" },
  jdm_i6_turbo: { file: "model.glb" },
  synth_v6: { file: "model.glb" },
  ferrari_f40: { file: "model.glb" },
  lexus_lfa: { file: "model.glb" },
  porsche_gt3rs: { file: "model.glb" },
  v10_supercar: { file: "model.glb" },
  aventador_svj: { file: "model.glb" },
  pagani_zonda: { file: "model.glb" },
  bugatti_chiron: { file: "model.glb" },
  gt_racer: { file: "model.glb" },
  audi_r8_v10: { file: "model.glb" },
  corvette_z06: { file: "model.glb" },
  mustang_gt: { file: "model.glb" },
  hellcat: { file: "model.glb" },
  muscle_v8: { file: "model.glb" },
  twin_turbo_i6: { file: "model.glb" },
  bmw_m3_e46: { file: "model.glb" },
  amg_c63: { file: "model.glb" },
  flat6_sports: { file: "model.glb" },
  v12_gt: { file: "model.glb" },
  hot_hatch: { file: "model.glb" },
  rotary_twin: { file: "model.glb" },
  boxer4_rally: { file: "model.glb" },
};
