import * as THREE from "three";
import type { VehicleConfig } from "../../lib/vehicles/types";
import {
  FORMULA_WHEELS,
  LIVERY,
  area,
  bikeLayout,
  bikeParts,
  carShape,
  clipY,
  exhaustTips,
  formulaParts,
  hexRgb,
  rearXAt,
  type Solid,
  type V,
  type XY,
} from "../drag/scene25d";

/**
 * The garage's cars in real 3D, built from the same shapes the drag strip draws: a car's side
 * profile extruded across its width (with the cabin leaning in above the beltline and the
 * corners rounded off in plan), or for single-seaters and bikes, the strip's part-by-part
 * models. Car space: x from the rear (0) to the nose, y up, z to the right.
 */
export interface CarModel {
  root: THREE.Group;
  /** Pitches and rolls on the springs; the wheels stay put. */
  body: THREE.Group;
  /** Each turns about its own z axis; radius for working out its spin from the distance. */
  wheels: { node: THREE.Object3D; r: number; front: boolean }[];
  tail: THREE.MeshStandardMaterial;
  head: THREE.MeshStandardMaterial;
  /** Where the headlights sit, for the beams (car space). */
  headlights: THREE.Vector3[];
  exhausts: THREE.Vector3[];
  length: number;
  width: number;
  /** Height of the axles' centre off the road. */
  wheelbaseMid: number;
  dispose(): void;
}

type RGB = [number, number, number];
const toColor = (c: RGB) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);

/** Collects triangles per material, then makes one mesh for each. */
class Builder {
  private readonly buckets = new Map<THREE.Material, number[]>();
  /** A triangle, wound so its front faces along `out` (whatever order the corners came in). */
  tri(m: THREE.Material, a: V, b: V, c: V, out: V) {
    let list = this.buckets.get(m);
    if (!list) this.buckets.set(m, (list = []));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] >= 0) list.push(...a, ...b, ...c);
    else list.push(...a, ...c, ...b);
  }
  /** A planar polygon as a fan (convex, or near enough). */
  poly(m: THREE.Material, pts: V[], out: V) {
    for (let i = 1; i + 1 < pts.length; i++) this.tri(m, pts[0], pts[i], pts[i + 1], out);
  }
  quad(m: THREE.Material, a: V, b: V, c: V, d: V, out: V) {
    this.tri(m, a, b, c, out);
    this.tri(m, a, c, d, out);
  }
  build(into: THREE.Object3D, smooth = false) {
    for (const [m, list] of this.buckets) {
      let g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(list, 3));
      if (smooth) {
        g = mergeClose(g);
        g.computeVertexNormals();
      } else g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      into.add(mesh);
    }
    this.buckets.clear();
  }
}

/** Welds vertices that share a position (for smooth shading across a panel's strips). */
function mergeClose(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute("position");
  const map = new Map<string, number>();
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = verts.length / 3;
      verts.push(x, y, z);
      map.set(key, k);
    }
    index.push(k);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(index);
  return out;
}

const materialCache = new Map<string, THREE.Material>();
function std(key: string, make: () => THREE.Material) {
  let m = materialCache.get(key);
  if (!m) materialCache.set(key, (m = make()));
  return m;
}

function paint(rgb: RGB) {
  return new THREE.MeshPhysicalMaterial({ color: toColor(rgb), metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 });
}

/** A solid from the drag strip's model kit, added face by face. */
function addSolid(b: Builder, s: Solid, mat: (s: Solid) => THREE.Material) {
  const m = mat(s);
  for (const f of s.faces) {
    // faces point away from the solid's middle
    const c = f.reduce<V>((acc, p) => [acc[0] + p[0] / f.length, acc[1] + p[1] / f.length, acc[2] + p[2] / f.length], [0, 0, 0]);
    b.poly(m, f, [c[0] - s.center[0], c[1] - s.center[1], c[2] - s.center[2]]);
  }
}

/** A wheel: tyre, rim with spokes, brake disc, turning about z. */
function makeWheel(r: number, width: number, accent: RGB, outward: 1 | -1, spokes = 7): THREE.Group {
  const g = new THREE.Group();
  const tyreM = std("tyre", () => new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.92 }));
  const rimM = std("rim", () => new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.85, roughness: 0.28 }));
  const hubM = std("hub", () => new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.6, roughness: 0.5 }));
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, width, 28, 1, false), tyreM);
  tyre.rotation.x = Math.PI / 2;
  g.add(tyre);
  // the rim on the outer face: a barrel, spokes and a centre cap
  const rimR = r * 0.68;
  const face = (width / 2 + 0.004) * outward;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, 0.012, 24), hubM);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = face;
  g.add(barrel);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.022, 6, 28), rimM);
  ring.position.z = face + 0.006 * outward;
  g.add(ring);
  for (let i = 0; i < spokes; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(rimR * 0.95, 0.045, 0.03), rimM);
    const a = (i / spokes) * Math.PI * 2;
    spoke.position.set(Math.cos(a) * rimR * 0.48, Math.sin(a) * rimR * 0.48, face + 0.008 * outward);
    spoke.rotation.z = a;
    g.add(spoke);
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.18, rimR * 0.18, 0.03, 12), std(`cap${accent}`, () => new THREE.MeshStandardMaterial({ color: toColor(accent), metalness: 0.5, roughness: 0.3 })));
  cap.rotation.x = Math.PI / 2;
  cap.position.z = face + 0.012 * outward;
  g.add(cap);
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  return g;
}

export function buildCar(cfg: VehicleConfig): CarModel {
  const acc = hexRgb(cfg.ui.accent);
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const own: THREE.Material[] = [];
  const paintM = paint(acc);
  own.push(paintM);
  const darkRoofM = paint(acc.map((v) => v * 0.42 + 10) as RGB);
  own.push(darkRoofM);
  const glassM = std("glass", () => new THREE.MeshPhysicalMaterial({ color: 0x0b0f17, metalness: 0.1, roughness: 0.04, clearcoat: 1 }));
  const trimM = std("trim", () => new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 0.75 }));
  const wingM = std("wing", () => new THREE.MeshStandardMaterial({ color: 0x2c2c34, roughness: 0.55, metalness: 0.2 }));
  const chromeM = std("chrome", () => new THREE.MeshStandardMaterial({ color: 0xa8a8b0, metalness: 0.9, roughness: 0.25 }));
  const head = new THREE.MeshStandardMaterial({ color: 0xf2efe6, emissive: 0xfff6e0, emissiveIntensity: 0.6, roughness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0606, emissive: 0xff1a12, emissiveIntensity: 0.5, roughness: 0.3 });
  own.push(head, tail);

  const kind = cfg.ui.silhouette;
  const wheels: CarModel["wheels"] = [];
  const headlights: THREE.Vector3[] = [];
  const b = new Builder();
  /** The panels round the profile: shaded smoothly across their strips, never into the flat sides. */
  const round = new Builder();
  let length: number;
  let width: number;

  const solidMat = (s: Solid) => {
    const [r, g, bl] = s.color;
    if (s.flat) return r > 150 ? head : glassM;
    if (r === acc[0] && g === acc[1] && bl === acc[2]) return paintM;
    const key = `solid${r},${g},${bl}`;
    return std(key, () => new THREE.MeshStandardMaterial({ color: toColor(s.color), roughness: 0.55, metalness: r > 100 && r === g ? 0.6 : 0.15 }));
  };

  if (kind === "formula") {
    for (const s of formulaParts(acc)) addSolid(b, s, solidMat);
    b.build(body);
    for (const w of FORMULA_WHEELS) {
      for (const side of [1, -1] as const) {
        const wh = makeWheel(w.r, w.z[1] - w.z[0], acc, side, 6);
        wh.position.set(w.x, w.r, ((w.z[0] + w.z[1]) / 2) * side);
        root.add(wh);
        wheels.push({ node: wh, r: w.r, front: w.x > 2 });
      }
    }
    // rain light on the crash structure
    const rain = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.12), tail);
    rain.position.set(0.04, 0.42, 0);
    body.add(rain);
    headlights.push(new THREE.Vector3(4.6, 0.3, 0));
    length = 4.9;
    width = 2.0;
  } else if (cfg.type === "bike") {
    const sport = kind !== "cruiser";
    const { R, RX, FX } = bikeLayout(sport);
    for (const s of bikeParts(sport, acc)) addSolid(b, s, solidMat);
    b.build(body);
    for (const [x, front] of [[RX, false], [FX, true]] as const) {
      const wh = makeWheel(R, front ? 0.12 : 0.14, acc, 1, 5);
      wh.position.set(x, R, 0);
      root.add(wh);
      wheels.push({ node: wh, r: R, front });
    }
    const lampX = sport ? 1.96 : FX - 0.2;
    const lampY = sport ? 0.8 : 0.94;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), head);
    lamp.position.set(lampX, lampY, 0);
    body.add(lamp);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.14), tail);
    tl.position.set(0.22, 0.98, 0);
    body.add(tl);
    headlights.push(new THREE.Vector3(lampX, lampY, 0));
    length = 2.2;
    width = 0.8;
  } else {
    const shape = carShape(cfg);
    const W = shape.width;
    length = shape.len;
    width = W;
    const livery = LIVERY[kind] ?? {};
    const cabinH = Math.max(0.01, shape.height - shape.belt);
    // half-width at a point of the profile: tumblehome above the belt, rounded corners in plan
    const hwAt = (x: number, y: number) => {
      let hw = W / 2;
      if (y > shape.belt) hw -= ((y - shape.belt) / cabinH) * W * 0.17;
      const e = Math.min(x, shape.len - x) / (shape.len * 0.12);
      if (e < 1) hw *= 0.88 + 0.12 * Math.sqrt(Math.max(0, e));
      return hw;
    };
    const side = (x: number, y: number, s: number, out = 0): V => [x, y, s * (hwAt(x, y) + out)];

    const prism = (poly: XY[], hw: (x: number, y: number) => number, mat: THREE.Material, glassy: boolean, paintable: boolean) => {
      // the strips round the profile: bonnet, screen, roof, tail, underside
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        const ha = hw(ax, ay);
        const hb = hw(bx, by);
        const glass = glassy && ay > shape.belt + 0.02 && by > shape.belt + 0.02 && Math.abs(by - ay) > 0.35 * Math.abs(bx - ax);
        const roof = paintable && livery.darkRoof && ay > shape.belt + 0.05 && by > shape.belt + 0.05;
        const m = glass ? glassM : roof ? darkRoofM : mat;
        round.quad(m, [ax, ay, ha], [bx, by, hb], [bx, by, -hb], [ax, ay, -ha], [by - ay, ax - bx, 0]);
      }
      // the two sides: the profile triangulated, at each point's own half-width
      const contour = poly.map(([x, y]) => new THREE.Vector2(x, y));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const [i, j, k] of tris) {
        const P = (n: number, s: number): V => [poly[n][0], poly[n][1], s * hw(poly[n][0], poly[n][1])];
        b.tri(mat, P(i, 1), P(j, 1), P(k, 1), [0, 0, 1]);
        b.tri(mat, P(i, -1), P(j, -1), P(k, -1), [0, 0, -1]);
      }
    };
    for (const poly of shape.bodies) prism(poly, hwAt, paintM, true, true);
    round.build(body, true);
    for (const poly of shape.wings) prism(poly, () => W / 2 - 0.14, wingM, false, false);
    round.build(body, true);

    // side glass, sills, lamps: thin panels just proud of the body on both sides
    const panel = (poly: XY[], m: THREE.Material, out: number) => {
      if (poly.length < 3) return;
      const tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, y]) => new THREE.Vector2(x, y)), []);
      for (const s of [1, -1]) {
        for (const [i, j, k] of tris) {
          const P = (n: number) => side(poly[n][0], poly[n][1], s, out);
          b.tri(m, P(i), P(j), P(k), [0, 0, s]);
        }
      }
    };
    if (shape.windows.length) panel(shape.windows, glassM, 0.006);
    for (const poly of shape.bodies) panel(clipY(poly, shape.height * 0.16, false), trimM, 0.004);
    const ly = Math.min(shape.height * 0.5, 0.68);
    panel([[shape.len - 0.42, ly - 0.07], [shape.len - 0.08, ly - 0.07], [shape.len - 0.08, ly + 0.06], [shape.len - 0.42, ly + 0.06]], head, 0.006);
    panel([[0.06, ly - 0.07], [0.36, ly - 0.07], [0.36, ly + 0.06], [0.06, ly + 0.06]], tail, 0.006);

    // the tail and nose faces: taillights and diffuser at the back, headlights at the front
    const main = shape.bodies.reduce((a, c) => (Math.abs(area(c)) > Math.abs(area(a)) ? c : a));
    const frontXAt = (y: number) => {
      let best: number | null = null;
      for (let i = 0; i < main.length; i++) {
        const [ax, ay] = main[i];
        const [bx, by] = main[(i + 1) % main.length];
        if ((ay - y) * (by - y) > 0 || ay === by) continue;
        const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
        if (best === null || x > best) best = x;
      }
      return best;
    };
    const endQuad = (atX: (y: number) => number | null, dir: -1 | 1, y0: number, y1: number, z0: number, z1: number, m: THREE.Material) => {
      const xa = atX(y0);
      const xb = atX(y1);
      if (xa === null || xb === null) return;
      const o = 0.008 * dir;
      const pts: V[] = [[xa + o, y0, z0], [xa + o, y0, z1], [xb + o, y1, z1], [xb + o, y1, z0]];
      b.poly(m, pts, [dir, 0, 0]);
    };
    const tailHw = (y: number) => hwAt(rearXAt(main, y) ?? 0, y);
    const th = tailHw(ly);
    endQuad((y) => rearXAt(main, y), -1, 0.1, 0.27, -tailHw(0.2) + 0.06, tailHw(0.2) - 0.06, trimM);
    endQuad((y) => rearXAt(main, y), -1, ly - 0.06, ly + 0.05, th - 0.48, th - 0.04, tail);
    endQuad((y) => rearXAt(main, y), -1, ly - 0.06, ly + 0.05, -th + 0.04, -th + 0.48, tail);
    if (livery.darkRoof) endQuad((y) => rearXAt(main, y), -1, ly - 0.015, ly + 0.01, -th + 0.48, th - 0.48, tail);
    const hy = Math.min(shape.height * 0.42, 0.62);
    const fh = hwAt(frontXAt(hy) ?? shape.len, hy);
    endQuad(frontXAt, 1, hy - 0.06, hy + 0.06, fh - 0.5, fh - 0.08, head);
    endQuad(frontXAt, 1, hy - 0.06, hy + 0.06, -fh + 0.08, -fh + 0.5, head);
    endQuad(frontXAt, 1, 0.12, 0.3, -fh * 0.55, fh * 0.55, trimM); // grille
    const fx = frontXAt(hy) ?? shape.len;
    headlights.push(new THREE.Vector3(fx, hy, fh - 0.3), new THREE.Vector3(fx, hy, -fh + 0.3));

    // twin stripes over the bonnet, roof and boot
    if (livery.stripes) {
      const stripeM = std("stripe", () => new THREE.MeshPhysicalMaterial({ color: 0xececf0, roughness: 0.3, clearcoat: 1 }));
      for (let i = 0; i < main.length; i++) {
        const [ax, ay] = main[i];
        const [bx, by] = main[(i + 1) % main.length];
        const nUp = bx - ax; // the edge faces up if it runs nose-wards along the top (ccw profile: top runs rear-wards)
        if (nUp > -0.02 || ay < shape.belt * 0.7 || by < shape.belt * 0.7) continue;
        for (const [z0, z1] of [[0.1, 0.3], [-0.3, -0.1]]) b.quad(stripeM, [ax, ay + 0.004, z1], [bx, by + 0.004, z1], [bx, by + 0.004, z0], [ax, ay + 0.004, z0], [by - ay, ax - bx, 0]);
      }
    }
    b.build(body);

    // exhaust tips
    for (const ez of [-0.42, 0.42]) {
      const x = (rearXAt(main, 0.22) ?? 0) - 0.02;
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 14, 1, true), chromeM);
      tip.rotation.z = Math.PI / 2;
      tip.position.set(x, 0.22, ez);
      body.add(tip);
    }

    for (const w of shape.wheels) {
      for (const s of [1, -1] as const) {
        const z0 = shape.wheelZ[0];
        const z1 = shape.wheelZ[1];
        const wh = makeWheel(w.r, z1 - z0, acc, s);
        wh.position.set(w.x, w.r, s * (z0 + z1) / 2);
        root.add(wh);
        wheels.push({ node: wh, r: w.r, front: w.x > shape.len / 2 });
      }
      // a dark wheel well over each axle, so the arch shows shadow, never the inside of the body
      const well = new THREE.Mesh(new THREE.BoxGeometry(2 * w.r + 0.16, w.r + 0.12, W - 0.3), trimM);
      well.position.set(w.x, w.r + (w.r + 0.12) / 2, 0);
      body.add(well);
    }
  }

  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  const exhausts = exhaustTips(cfg).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const wheelbaseMid = wheels.length ? wheels.reduce((s, w) => s + w.r, 0) / wheels.length : 0.33;
  return {
    root,
    body,
    wheels,
    tail,
    head,
    headlights,
    exhausts,
    length,
    width,
    wheelbaseMid,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      own.forEach((m) => m.dispose());
    },
  };
}
