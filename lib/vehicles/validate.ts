import type { SampleRef, VehicleConfig } from "./types";

/** Pure structural validation (no filesystem). Returns a list of problems. */
export function validateVehicle(v: VehicleConfig): string[] {
  const p: string[] = [];
  const e = v.engine;
  if (!v.id || !/^[a-z0-9_]+$/.test(v.id)) p.push("id must be lowercase letters, digits or _");
  if (!v.name) p.push("name missing");
  if (!(e.idleRpm > 0 && e.idleRpm < e.redlineRpm && e.redlineRpm <= e.limiterRpm)) {
    p.push("need 0 < idleRpm < redlineRpm <= limiterRpm");
  }
  if (!(e.cylinders >= 1)) p.push("cylinders must be >= 1");
  if (!(e.inertia > 0)) p.push("inertia must be > 0");
  if (!v.gearbox.ratios.length) p.push("gearbox.ratios is empty");
  if (v.gearbox.ratios.some((r, i, a) => r <= 0 || (i > 0 && r >= a[i - 1]))) {
    p.push("gear ratios must be positive and strictly decreasing");
  }
  if (v.audio.mode === "samples") {
    const a = v.audio;
    const checkLoops = (name: string, list?: SampleRef[]) => {
      if (!list?.length) return p.push(`audio.${name} needs at least one loop`);
      for (let i = 1; i < list.length; i++) {
        if (list[i].rpm <= list[i - 1].rpm) p.push(`audio.${name} must be sorted by ascending rpm`);
      }
    };
    checkLoops("onLoad", a.onLoad);
    checkLoops("offLoad", a.offLoad);
    if (!a.idle) p.push("audio.idle missing");
  } else if (!v.audio.synth) {
    p.push("audio.synth missing for mode 'synth'");
  }
  return p;
}
