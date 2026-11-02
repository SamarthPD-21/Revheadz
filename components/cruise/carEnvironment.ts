import * as THREE from "three";
// three r179+ renamed RGBELoader to HDRLoader; on an older three, import RGBELoader instead
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";

/**
 * Real reflections for the car. Paint looks like paint because of what it reflects: a real
 * horizon, sky and ground. The procedural Sky has no ground and little contrast, so the car's
 * own materials get a photographed environment (an HDRI) instead, faded down as night falls so
 * a sunny reflection never shows on a dark road.
 *
 * Put a 1k or 2k outdoor .hdr (Poly Haven's are CC0) at public/env/car.hdr.
 */
const envs = new WeakMap<THREE.WebGLRenderer, Promise<THREE.Texture | null>>();

export function loadCarEnvironment(renderer: THREE.WebGLRenderer, url = "/env/car.hdr"): Promise<THREE.Texture | null> {
  let p = envs.get(renderer);
  if (!p) {
    p = new HDRLoader()
      .loadAsync(url)
      .then((hdr) => {
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const pmrem = new THREE.PMREMGenerator(renderer);
        const env = pmrem.fromEquirectangular(hdr).texture;
        hdr.dispose();
        pmrem.dispose();
        return env;
      })
      .catch((err) => {
        console.warn("[cruise] no car environment map; the sky's reflections are used", err);
        return null;
      });
    envs.set(renderer, p);
  }
  return p;
}

/** Hands the environment to a car's materials and keeps their reflections in step with the light. */
export class CarReflections {
  private mats: { m: THREE.MeshStandardMaterial; base: number }[] = [];

  attach(root: THREE.Object3D, env: THREE.Texture): void {
    this.mats = [];
    const seen = new Set<THREE.Material>();
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (seen.has(m) || !(m instanceof THREE.MeshStandardMaterial) || (m.transparent && m.opacity < 0.3)) continue;
        seen.add(m);
        m.envMap = env;
        m.needsUpdate = true;
        this.mats.push({ m, base: m.envMapIntensity || 1 });
      }
    });
  }

  /** 1 at noon, 0 at night. */
  setDaylight(day: number): void {
    const k = 0.12 + 0.88 * Math.min(1, Math.max(0, day));
    for (const { m, base } of this.mats) m.envMapIntensity = base * k;
  }
}
