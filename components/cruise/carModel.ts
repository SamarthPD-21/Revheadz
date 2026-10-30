import * as THREE from "three";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { loftBody, type BodyOptions, type Part } from "./carBody";
import {
  FORMULA_WHEELS,
  LIVERY,
  area,
  bikeLayout,
  bikeParts,
  carShape,
  exhaustTips,
  formulaParts,
  hexRgb,
  rearXAt,
  type Solid,
  type V,
} from "../drag/scene25d";

/** How each body style is shaped: ride height, how round its nose is, how wide its roof. */
const BODY_STYLE: Record<string, BodyOptions> = {
  coupe: { clearance: 0.13, noseRound: 0.5, roofWidth: 0.7 },
  sport: { clearance: 0.12, noseRound: 0.6, roofWidth: 0.68 },
  rally: { clearance: 0.17, noseRound: 0.45, roofWidth: 0.72 },
  supercar: { clearance: 0.1, noseRound: 0.75, roofWidth: 0.62 },
  gtcar: { clearance: 0.09, noseRound: 0.7, roofWidth: 0.62 },
  muscle: { clearance: 0.14, noseRound: 0.2, roofWidth: 0.72 },
  gt: { clearance: 0.12, noseRound: 0.6, roofWidth: 0.66 },
  hatch: { clearance: 0.15, noseRound: 0.45, roofWidth: 0.74 },
};

let shadowTex: THREE.CanvasTexture | null = null;
/** A dark, soft-edged patch for under a vehicle (one texture shared by all). */
function contactShadow(): THREE.MeshBasicMaterial {
  if (!shadowTex) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    grad.addColorStop(0, "rgba(0,0,0,0.75)");
    grad.addColorStop(0.55, "rgba(0,0,0,0.45)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    shadowTex = new THREE.CanvasTexture(c);
  }
  return std("contact", () => new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })) as THREE.MeshBasicMaterial;
}

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

/**
 * A part from the strip's kit, rounded off: each four-cornered section becomes a rounded
 * rectangle (a superellipse inside its corners), lofted between the two ends and capped, so
 * fairings, tanks, limbs and wings come out moulded instead of boxy. Helmets become spheres.
 */
function addRounded(b: Builder, s: Solid, m: THREE.Material, into: THREE.Object3D): boolean {
  // a helmet: the white solid round the rider's or driver's head
  const [r0, g0, b0] = s.color;
  if (r0 > 220 && g0 > 220 && b0 > 220 && !s.flat) {
    const pts = s.faces.flat();
    const ext = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k])));
    const r = Math.max(0.12, Math.min(ext[0], ext[1]) / 2);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), m);
    helmet.position.set(s.center[0], s.center[1], s.center[2]);
    into.add(helmet);
    return true;
  }
  if (s.faces.length !== 6 || s.faces[0].length !== 4 || s.faces[1].length !== 4 || s.flat) return false;
  const A = s.faces[0];
  // the far end, its corners matched to the near end's: a loft keeps them in order; a box's far
  // face runs the other way round
  const F = s.faces[1];
  const B = s.faces[2][1] === A[1] ? F : [F[0], F[3], F[2], F[1]];
  const K = 16;
  const ring = (Q: V[]): V[] =>
    Array.from({ length: K }, (_, k) => {
      const t = (k / K) * Math.PI * 2;
      // a superellipse (power 4): squarish with round corners
      const c = Math.cos(t);
      const sn = Math.sin(t);
      const u = 0.5 + 0.5 * Math.sign(c) * Math.pow(Math.abs(c), 0.5);
      const v = 0.5 + 0.5 * Math.sign(sn) * Math.pow(Math.abs(sn), 0.5);
      // bilinear across the section's four corners
      return [0, 1, 2].map((i) => (1 - u) * (1 - v) * Q[0][i] + u * (1 - v) * Q[1][i] + u * v * Q[2][i] + (1 - u) * v * Q[3][i]) as V;
    });
  const ra = ring(A);
  const rb = ring(B);
  const out = (p: V): V => [p[0] - s.center[0], p[1] - s.center[1], p[2] - s.center[2]];
  for (let k = 0; k < K; k++) {
    const k1 = (k + 1) % K;
    const mid: V = [(ra[k][0] + rb[k1][0]) / 2, (ra[k][1] + rb[k1][1]) / 2, (ra[k][2] + rb[k1][2]) / 2];
    b.quad(m, ra[k], ra[k1], rb[k1], rb[k], out(mid));
  }
  for (const [r, end] of [[ra, A], [rb, B]] as const) {
    const c = end.reduce<V>((acc, p) => [acc[0] + p[0] / 4, acc[1] + p[1] / 4, acc[2] + p[2] / 4], [0, 0, 0]);
    for (let k = 0; k < K; k++) b.tri(m, c, r[k], r[(k + 1) % K], out(c));
  }
  return true;
}

const wheelGeo = new Map<string, THREE.BufferGeometry>();
/** Geometry shared between wheels of the same size. */
function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = wheelGeo.get(key);
  if (!g) wheelGeo.set(key, (g = make()));
  return g;
}

/**
 * A wheel, turning about z: a tyre with rounded shoulders and sidewalls, a dished rim of
 * tapered spokes round a centre cap, and a brake disc behind it.
 */
function makeWheel(r: number, width: number, accent: RGB, outward: 1 | -1, spokes = 7): THREE.Group {
  const g = new THREE.Group();
  const tyreM = std("tyre", () => new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9 }));
  const rimM = std("rim", () => new THREE.MeshStandardMaterial({ color: 0xc4c8d0, metalness: 0.9, roughness: 0.22 }));
  const barrelM = std("barrel", () => new THREE.MeshStandardMaterial({ color: 0x2c2d33, metalness: 0.7, roughness: 0.45, side: THREE.DoubleSide }));
  const discM = std("disc", () => new THREE.MeshStandardMaterial({ color: 0x6d6e74, metalness: 0.8, roughness: 0.38 }));
  const hw = width / 2;
  const rimR = r * 0.7;
  // the tyre: its cross-section turned round the axle (lathe turns about y; then laid on z)
  const tyre = new THREE.Mesh(
    cached(`tyre${r.toFixed(3)},${width.toFixed(3)}`, () => {
      const pts: THREE.Vector2[] = [];
      const shoulder = Math.min(0.045, hw * 0.4);
      pts.push(new THREE.Vector2(rimR, -hw * 0.92));
      for (let i = 0; i <= 6; i++) {
        const a = (i / 6) * Math.PI * 0.5;
        pts.push(new THREE.Vector2(r - shoulder + Math.sin(a) * shoulder, -hw + shoulder - Math.cos(a) * shoulder));
      }
      for (let i = 0; i <= 6; i++) {
        const a = (i / 6) * Math.PI * 0.5;
        pts.push(new THREE.Vector2(r - shoulder + Math.cos(a) * shoulder, hw - shoulder + Math.sin(a) * shoulder));
      }
      pts.push(new THREE.Vector2(rimR, hw * 0.92));
      return new THREE.LatheGeometry(pts, 36).rotateX(Math.PI / 2);
    }),
    tyreM,
  );
  g.add(tyre);
  const face = hw * 0.9 * outward;
  // the barrel inside the rim, and the disc behind the spokes
  const barrel = new THREE.Mesh(cached(`barrel${rimR.toFixed(3)},${width.toFixed(3)}`, () => new THREE.CylinderGeometry(rimR, rimR, width * 0.9, 28, 1, true).rotateX(Math.PI / 2)), barrelM);
  g.add(barrel);
  const disc = new THREE.Mesh(cached(`disc${rimR.toFixed(3)}`, () => new THREE.CylinderGeometry(rimR * 0.8, rimR * 0.8, 0.028, 28).rotateX(Math.PI / 2)), discM);
  disc.position.z = face * 0.25;
  g.add(disc);
  // the lip round the face
  const lip = new THREE.Mesh(cached(`lip${rimR.toFixed(3)}`, () => new THREE.TorusGeometry(rimR - 0.008, 0.016, 8, 36)), rimM);
  lip.position.z = face;
  g.add(lip);
  // spokes: wide at the hub, narrowing to the rim, dished back towards the hub
  const spokeGeo = cached(`spoke${rimR.toFixed(3)},${spokes}`, () => {
    const w0 = Math.min(0.07, (rimR * 2.2) / spokes);
    const sh = new THREE.Shape();
    sh.moveTo(rimR * 0.18, -w0 / 2);
    sh.lineTo(rimR * 0.98, -w0 * 0.28);
    sh.lineTo(rimR * 0.98, w0 * 0.28);
    sh.lineTo(rimR * 0.18, w0 / 2);
    sh.closePath();
    return new THREE.ExtrudeGeometry(sh, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 1 });
  });
  for (let i = 0; i < spokes; i++) {
    const spoke = new THREE.Mesh(spokeGeo, rimM);
    spoke.rotation.z = (i / spokes) * Math.PI * 2;
    spoke.position.z = face - (outward === 1 ? 0.03 : -0.008);
    g.add(spoke);
  }
  const cap = new THREE.Mesh(cached(`cap${rimR.toFixed(3)}`, () => new THREE.CylinderGeometry(rimR * 0.2, rimR * 0.22, 0.04, 18).rotateX(Math.PI / 2)), std(`cap${accent}`, () => new THREE.MeshStandardMaterial({ color: toColor(accent), metalness: 0.6, roughness: 0.3 })));
  cap.position.z = face;
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
  const glassM = std("glass", () => new THREE.MeshPhysicalMaterial({ color: 0x0b0f17, metalness: 0.1, roughness: 0.04, clearcoat: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  const trimM = std("trim", () => new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 0.75 }));
  const wingM = std("wing", () => new THREE.MeshStandardMaterial({ color: 0x2c2c34, roughness: 0.55, metalness: 0.2 }));
  const chromeM = std("chrome", () => new THREE.MeshStandardMaterial({ color: 0xa8a8b0, metalness: 0.9, roughness: 0.25 }));
  const wellM = std("well", () => new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.95, side: THREE.DoubleSide }));
  const head = new THREE.MeshStandardMaterial({ color: 0xf2efe6, emissive: 0xfff6e0, emissiveIntensity: 0.6, roughness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0606, emissive: 0xff1a12, emissiveIntensity: 0.5, roughness: 0.3 });
  own.push(head, tail);

  const kind = cfg.ui.silhouette;
  /** Where the exhausts come out (for the flames), when the body sets them. */
  const tips: THREE.Vector3[] = [];
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
    for (const s of formulaParts(acc)) if (!addRounded(round, s, solidMat(s), body)) addSolid(b, s, solidMat);
    b.build(body);
    round.build(body, true);
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
    for (const s of bikeParts(sport, acc)) if (!addRounded(round, s, solidMat(s), body)) addSolid(b, s, solidMat);
    b.build(body);
    round.build(body, true);
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
    const main = shape.bodies.reduce((a, c) => (Math.abs(area(c)) > Math.abs(area(a)) ? c : a));
    const style = BODY_STYLE[kind] ?? BODY_STYLE.coupe;
    const skin = loftBody(shape, main, style);
    const partMat: Record<Part, THREE.Material> = { paint: paintM, roof: livery.darkRoof ? darkRoofM : paintM, glass: glassM, dark: wellM };
    for (const [part, g] of skin.geometries) {
      const mesh = new THREE.Mesh(g, partMat[part]);
      mesh.castShadow = part !== "dark";
      mesh.receiveShadow = true;
      body.add(mesh);
    }
    // wings and spoilers: the strip's outlines, extruded thin and shaded smoothly
    for (const poly of shape.wings) {
      const hw = W / 2 - 0.14;
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        round.quad(wingM, [ax, ay, hw], [bx, by, hw], [bx, by, -hw], [ax, ay, -hw], [by - ay, ax - bx, 0]);
      }
      const tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, y]) => new THREE.Vector2(x, y)), []);
      for (const [i, j, k] of tris) {
        const P = (n: number, sz: number): V => [poly[n][0], poly[n][1], sz * hw];
        b.tri(wingM, P(i, 1), P(j, 1), P(k, 1), [0, 0, 1]);
        b.tri(wingM, P(i, -1), P(j, -1), P(k, -1), [0, 0, -1]);
      }
    }
    round.build(body, true);

    // twin stripes over the bonnet, roof and boot, laid on the skin
    if (livery.stripes) {
      const stripeM = std("stripe", () => new THREE.MeshPhysicalMaterial({ color: 0xececf0, roughness: 0.3, clearcoat: 1 }));
      const steps = 90;
      for (let i = 0; i < steps; i++) {
        const xa = skin.x0 + ((skin.x1 - skin.x0) * i) / steps;
        const xb = skin.x0 + ((skin.x1 - skin.x0) * (i + 1)) / steps;
        const ya = skin.topAt(xa) + 0.006;
        const yb = skin.topAt(xb) + 0.006;
        if (Math.abs(yb - ya) / (xb - xa) > 0.42 && skin.topAt((xa + xb) / 2) > shape.belt + 0.12) continue; // not over the glass
        for (const [z0, z1] of [[0.1, 0.28], [-0.28, -0.1]]) b.quad(stripeM, [xa, ya, z1], [xb, yb, z1], [xb, yb, z0], [xa, ya, z0], [0, 1, 0]);
      }
    }

    // lamps: lenses set into the nose, a light bar and clusters across the tail
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
    const hy = Math.min(skin.topAt(skin.x1 - 0.3) - 0.07, 0.66);
    const hx = (frontXAt(hy) ?? shape.len) - 0.2;
    const lensGeo = new THREE.SphereGeometry(1, 20, 12);
    for (const sz of [1, -1]) {
      const lens = new THREE.Mesh(lensGeo, head);
      const hz = skin.halfWidth(hx) * 0.7;
      lens.scale.set(0.2, 0.055, 0.17);
      lens.position.set(hx + 0.08, hy, sz * hz);
      lens.rotation.y = sz * 0.35;
      body.add(lens);
      // the dark housing it sits in
      const bezel = new THREE.Mesh(lensGeo, trimM);
      bezel.scale.set(0.2, 0.068, 0.2);
      bezel.position.set(hx + 0.06, hy, sz * hz);
      bezel.rotation.y = sz * 0.35;
      body.add(bezel);
      headlights.push(new THREE.Vector3(hx + 0.2, hy, sz * hz));
    }
    // grille and splitter
    const gy = Math.max(style.clearance + 0.12, hy - 0.22);
    const gx = (frontXAt(gy) ?? shape.len) - 0.04;
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, skin.halfWidth(gx) * 1.1), trimM);
    grille.position.set(gx, gy, 0);
    body.add(grille);
    const ty = Math.min(skin.topAt(skin.x0 + 0.25) - 0.08, 0.78);
    const tx = (rearXAt(main, ty) ?? 0) - 0.005;
    const thw = skin.halfWidth(tx + 0.05);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, thw * 1.75), tail);
    bar.position.set(tx, ty, 0);
    body.add(bar);
    for (const sz of [1, -1]) {
      const cluster = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.42), tail);
      cluster.position.set(tx + 0.01, ty - 0.02, sz * (thw - 0.27));
      body.add(cluster);
    }
    // diffuser under the tail
    const dif = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, thw * 1.4), trimM);
    dif.position.set(skin.x0 + 0.17, style.clearance + 0.1, 0);
    body.add(dif);

    // door mirrors at the foot of the windscreen
    const win = shape.windows.length ? Math.max(...shape.windows.map((p) => p[0])) : shape.len * 0.62;
    const mx = Math.min(win - 0.12, shape.len * 0.7);
    for (const sz of [1, -1]) {
      const my = shape.belt + 0.07;
      const mz = skin.halfWidth(mx) * 0.9 + 0.09;
      const mirror = new THREE.Mesh(lensGeo, paintM);
      mirror.scale.set(0.08, 0.05, 0.085);
      mirror.position.set(mx, my, sz * mz);
      body.add(mirror);
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.12), trimM);
      stalk.position.set(mx + 0.01, my - 0.03, sz * (mz - 0.07));
      body.add(stalk);
      const glassFace = new THREE.Mesh(new THREE.CircleGeometry(0.042, 12), chromeM);
      glassFace.position.set(mx - 0.065, my, sz * mz);
      glassFace.rotation.y = -Math.PI / 2;
      body.add(glassFace);
    }
    b.build(body);

    // exhaust tips through the diffuser
    for (const ez of [-0.42, 0.42]) {
      tips.push(new THREE.Vector3(skin.x0 - 0.05, style.clearance + 0.1, ez));
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.14, 16, 1, true), chromeM);
      tip.rotation.z = Math.PI / 2;
      tip.position.set(skin.x0 + 0.02, style.clearance + 0.1, ez);
      body.add(tip);
    }

    for (const w of shape.wheels) {
      for (const s of [1, -1] as const) {
        const z0 = shape.wheelZ[0];
        const z1 = shape.wheelZ[1] - 0.04;
        const wh = makeWheel(w.r, z1 - z0, acc, s, kind === "muscle" ? 5 : kind === "rally" ? 6 : 10);
        wh.position.set(w.x, w.r, s * (z0 + z1) / 2);
        root.add(wh);
        wheels.push({ node: wh, r: w.r, front: w.x > shape.len / 2 });
        // the brake caliper, holding still while the wheel turns past it
        const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.07), std(`caliper${acc}`, () => new THREE.MeshStandardMaterial({ color: toColor(kind === "muscle" || kind === "coupe" ? [200, 30, 30] : acc), roughness: 0.4, metalness: 0.3 })));
        caliper.position.set(w.x - w.r * 0.42 * (w.x > shape.len / 2 ? -1 : 1), w.r + w.r * 0.3, s * ((z0 + z1) / 2 - s * 0.0 + (z1 - z0) * 0.12));
        root.add(caliper);
      }
    }
  }

  // a soft shadow on the road under it, so it sits down even where the sun's shadow doesn't reach
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(length * 1.08, width * 1.25), contactShadow());
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(length / 2, 0.012, 0);
  blob.renderOrder = -1;
  root.add(blob);

  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o !== blob && o.material !== wellM) o.castShadow = true;
  });
  const exhausts = tips.length ? tips : exhaustTips(cfg).map(([x, y, z]) => new THREE.Vector3(x, y, z));
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
        if (o instanceof THREE.Mesh && ![...wheelGeo.values()].includes(o.geometry)) o.geometry.dispose();
      });
      own.forEach((m) => m.dispose());
    },
  };
}
