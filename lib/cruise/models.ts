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

export const MODELS: Record<string, ModelEntry> = {
  // supra_mk4: { file: "model.glb", repaint: true },
};
