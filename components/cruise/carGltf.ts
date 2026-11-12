import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { MODELS, type ModelEntry } from "../../lib/cruise/models";
import { specOf } from "../../lib/cruise/specs";
import type { VehicleConfig } from "../../lib/vehicles/types";
import type { CarModel } from "./carModel";

/**
 * Loads an authored car (a .glb) and turns it into the same CarModel the procedural builder
 * makes, so the scene, physics, lights and flames don't know the difference.
 *
 * What the file needs (see INTEGRATION.md for the Blender side):
 *   wheel_FL, wheel_FR, wheel_RL, wheel_RR   one object (or empty) per wheel; origin at the hub
 *   headlight_*                              empties where the beams start (optional)
 *   exhaust_*                                empties at each pipe's exit (optional)
 *   materials named head*, tail*, paint*     lamps that light up, and paint to recolour
 *
 * It's oriented, scaled to the real car's length and sat on the ground automatically:
 * nose to +x, rear at x = 0, tyres on y = 0, centred on z.
 */

let loader: GLTFLoader | null = null;
function gltfLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader();
    // Draco needs its decoder files in public/draco/ (only if you compress with Draco)
    const draco = new DRACOLoader();
    draco.setDecoderPath("/draco/");
    loader.setDRACOLoader(draco);
    // meshopt needs nothing hosted: the recommended compression
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

export const hasAuthoredModel = (cfg: VehicleConfig) => Boolean(MODELS[cfg.id]);

/** The car's authored model, or null (none listed, failed to load, or no wheels found). */
export async function loadCarModel(cfg: VehicleConfig): Promise<CarModel | null> {
  const entry = MODELS[cfg.id];
  if (!entry) return null;
  try {
    const gltf = await gltfLoader().loadAsync(`/vehicles/${cfg.id}/${entry.file}`);
    return fromScene(gltf.scene, cfg, entry);
  } catch (err) {
    console.warn(`[cruise] couldn't load the model for ${cfg.id}; using the built-in body`, err);
    return null;
  }
}

/** The highest nodes whose names match (a wheel's own tyre and rim children are left inside it). */
function topmost(root: THREE.Object3D, re: RegExp): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const walk = (o: THREE.Object3D) => {
    if (o !== root && re.test(o.name)) {
      out.push(o);
      return;
    }
    o.children.forEach(walk);
  };
  walk(root);
  return out;
}

function isEmpty(o: THREE.Object3D): boolean {
  let mesh = false;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) mesh = true;
  });
  return !mesh;
}

function disposeMaterial(m: THREE.Material) {
  for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
  m.dispose();
}

function contactShadowMaterial(): THREE.MeshBasicMaterial {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,0.75)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.45)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
}

function fromScene(scene: THREE.Group, cfg: VehicleConfig, entry: ModelEntry): CarModel | null {
  // 1. into car space: turned if asked, scaled to the real length, sat on the ground, centred
  if (entry.yawDeg) scene.rotation.y += THREE.MathUtils.degToRad(entry.yawDeg);
  scene.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(scene);
  const realLength = specOf(cfg)?.dims?.[0];
  const size = box.getSize(new THREE.Vector3());
  if (realLength && size.x > 0.01) {
    scene.scale.multiplyScalar(realLength / size.x);
    scene.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(scene);
  }
  scene.position.x -= box.min.x;
  scene.position.y -= box.min.y;
  scene.position.z -= (box.min.z + box.max.z) / 2;
  scene.updateMatrixWorld(true);
  box.setFromObject(scene);
  const length = box.max.x - box.min.x;
  const width = box.max.z - box.min.z;

  // 2. find the named parts before anything moves
  const wheelNodes = topmost(scene, /^wheel_?(fl|fr|rl|rr)/i);
  if (wheelNodes.length < 2) {
    console.warn(`[cruise] ${cfg.id}: no wheel_FL / wheel_RL... nodes found; using the built-in body`);
    return null;
  }
  // markers are empties; a mesh that happens to be called "Headlights_Glass" is part of the car
  const headNodes = topmost(scene, /^headlight/i).filter(isEmpty);
  const exhaustNodes = topmost(scene, /^exhaust/i).filter(isEmpty);

  // 3. rebuild as the scene expects: a root holding the body (which pitches and rolls) and
  //    one pivot per wheel at its hub, at rest with no rotation (the scene sets spin and steer)
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  root.updateMatrixWorld(true);

  const wheels: CarModel["wheels"] = [];
  const wb = new THREE.Box3();
  const centre = new THREE.Vector3();
  const extent = new THREE.Vector3();
  for (const w of wheelNodes) {
    wb.setFromObject(w);
    wb.getCenter(centre);
    wb.getSize(extent);
    const pivot = new THREE.Group();
    pivot.name = w.name;
    pivot.position.copy(centre);
    root.add(pivot);
    pivot.updateMatrixWorld(true);
    pivot.attach(w); // keeps it exactly where it was
    wheels.push({ node: pivot, r: extent.y / 2, front: /^wheel_?f/i.test(w.name) });
  }

  const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
  const headlights = headNodes.map(at);
  const exhausts = exhaustNodes.map(at);
  for (const o of [...headNodes, ...exhaustNodes]) o.removeFromParent();
  // everything else is bodywork
  for (const child of [...scene.children]) body.attach(child);
  if (!headlights.length) headlights.push(new THREE.Vector3(length - 0.15, 0.65, -0.55), new THREE.Vector3(length - 0.15, 0.65, 0.55));
  if (!exhausts.length) exhausts.push(new THREE.Vector3(0.02, 0.28, -0.4), new THREE.Vector3(0.02, 0.28, 0.4));

  // 4. materials: lamps the scene can light up, paint in the car's colour, shadows on
  const head = new THREE.MeshStandardMaterial({ color: 0xf2efe6, emissive: 0xfff6e0, emissiveIntensity: 0.6, roughness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0606, emissive: 0xff1a12, emissiveIntensity: 0.5, roughness: 0.3 });
  const paint = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(cfg.ui.accent), metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 });
  const own = new Set<THREE.Material>([head, tail, paint]);
  const replaced = new Set<THREE.Material>();
  const swap = (m: THREE.Material): THREE.Material => {
    const n = m.name.toLowerCase();
    const next = n.startsWith("tail") ? tail : n.startsWith("head") ? head : entry.repaint && n.startsWith("paint") ? paint : m;
    if (next !== m) replaced.add(m);
    else own.add(m);
    return next;
  };
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    o.castShadow = true;
    o.receiveShadow = true;
  });
  for (const m of replaced) if (!own.has(m)) disposeMaterial(m);

  // 5. a soft patch of shadow under it
  const blobMat = contactShadowMaterial();
  own.add(blobMat);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(length * 1.08, width * 1.2), blobMat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(length / 2, 0.012, 0);
  blob.renderOrder = -1;
  blob.castShadow = false;
  root.add(blob);

  return {
    root,
    body,
    wheels,
    head,
    tail,
    headlights,
    exhausts,
    length,
    width,
    wheelbaseMid: wheels.reduce((s, w) => s + w.r, 0) / wheels.length,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      own.forEach(disposeMaterial);
    },
  };
}
