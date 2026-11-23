import * as THREE from "three";

const PAINT = /paint|body/i;
const GLASS = /glass|window|windscreen|windshield|lens/i;

/** Area of a mesh's triangles, in its own units. */
function meshArea(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute("position");
  if (!pos) return 0;
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let sum = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

const isGlass = (m: THREE.MeshStandardMaterial) => (m.transparent && m.opacity < 0.7) || GLASS.test(m.name);
const isDark = (m: THREE.MeshStandardMaterial) => !m.map && m.color.r + m.color.g + m.color.b < 0.15;

/** The same material with a clear coat on top, like a car's lacquer. */
function lacquered(m: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  const coat = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(coat, m);
  // the standard copy leaves only STANDARD defined; the clear coat needs PHYSICAL too
  (coat as unknown as { defines: Record<string, string> }).defines = { STANDARD: "", PHYSICAL: "" };
  coat.clearcoat = 1;
  coat.clearcoatRoughness = 0.05;
  coat.roughness = Math.min(coat.roughness, 0.45);
  return coat;
}

/**
 * Makes a downloaded car read like a real one: its paint gets a clear coat (the materials named
 * paint or body, or else the brightest-coloured one covering the most of it) and its glass turns
 * smooth and reflective. `skip` holds materials the game owns (lamps, its own paint).
 * Returns the paint materials it replaced and the coats that replaced them.
 */
export function finishBody(body: THREE.Object3D, skip: Set<THREE.Material>): { replaced: THREE.Material[]; added: THREE.Material[] } {
  const area = new Map<THREE.MeshStandardMaterial, number>();
  const scale = new THREE.Vector3();
  body.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
    const m = o.material;
    if (!(m instanceof THREE.MeshStandardMaterial) || skip.has(m)) return;
    o.getWorldScale(scale);
    area.set(m, (area.get(m) ?? 0) + meshArea(o.geometry) * scale.x * scale.y);
  });

  for (const m of area.keys()) {
    if (!isGlass(m)) continue;
    m.roughness = Math.min(m.roughness, 0.05);
    m.metalness = 0;
  }

  const solid = [...area.keys()].filter((m) => !isGlass(m) && !(m instanceof THREE.MeshPhysicalMaterial && m.clearcoat > 0));
  let paints = solid.filter((m) => PAINT.test(m.name));
  if (!paints.length) {
    const bright = solid.filter((m) => !isDark(m));
    if (bright.length) paints = [bright.reduce((x, y) => (area.get(y)! > area.get(x)! ? y : x))];
  }
  const coats = new Map(paints.map((m) => [m as THREE.Material, lacquered(m)]));
  body.traverse((o) => {
    if (o instanceof THREE.Mesh && !Array.isArray(o.material) && coats.has(o.material)) o.material = coats.get(o.material)!;
  });
  return { replaced: [...coats.keys()], added: [...coats.values()] };
}
