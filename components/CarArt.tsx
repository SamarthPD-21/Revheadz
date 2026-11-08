import type { VehicleConfig } from "../lib/vehicles/types";
import { Silhouette } from "./Silhouette";

/** Whether a vehicle has a studio render of its 3D model (cars do; the bikes and F1 cars don't yet). */
export const hasRender = (v: Pick<VehicleConfig, "type" | "ui">) => v.type === "car" && v.ui.silhouette !== "formula";

/**
 * A vehicle's picture: the studio render of its model where there is one, or a plain grey
 * outline. `flip` turns it to face left.
 */
export function CarArt({ v, className = "", flip = false }: { v: Pick<VehicleConfig, "id" | "type" | "ui">; className?: string; flip?: boolean }) {
  if (hasRender(v)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`/vehicles/${v.id}/card.webp`} alt="" loading="lazy" decoding="async" className={`object-contain ${flip ? "-scale-x-100" : ""} ${className}`} />
    );
  }
  return <Silhouette kind={v.ui.silhouette} accent="#a1a1aa" className={`${flip ? "-scale-x-100" : ""} ${className}`} />;
}
