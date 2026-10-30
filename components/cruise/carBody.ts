import * as THREE from "three";
import type { CarShape, XY } from "../drag/scene25d";

/**
 * A car's body as one smooth skin, lofted through cross-sections along its length the way a
 * clay model is shaped: each section runs from the floor, in round the wheel well, up a gently
 * curved flank that tucks under at the sill, over the shoulder at the beltline, up the glass
 * (leaning in: tumblehome) and over a crowned roof. The side profile sets each section's
 * height, the plan rounds off the nose and tail, and arches open round each wheel.
 *
 * Car space: x from the rear (0) to the nose, y up, z to the right.
 */
export type Part = "paint" | "roof" | "glass" | "dark";

export interface BodyOptions {
  /** Ground clearance under the sills, m. */
  clearance: number;
  /** How round the nose is in plan (0 square .. 1 very round). */
  noseRound: number;
  /** Roof width as a share of the body's. */
  roofWidth: number;
}

/** Highest and lowest points of a closed profile on the vertical line at x. */
function spanAt(poly: XY[], x: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    if ((ax - x) * (bx - x) > 0 || ax === bx) continue;
    const y = ay + ((x - ax) / (bx - ax)) * (by - ay);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return hi > lo ? [lo, hi] : null;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Points per half-section (from the middle of the floor round to the middle of the roof). */
const SIDE = 6;
const TOP = 8;

export interface Body {
  geometries: Map<Part, THREE.BufferGeometry>;
  /** Half-width of the body at a point along it (for placing lamps and mirrors). */
  halfWidth(x: number): number;
  /** Top of the body at a point along it. */
  topAt(x: number): number;
  x0: number;
  x1: number;
}

export function loftBody(shape: CarShape, main: XY[], o: BodyOptions): Body {
  const xs = main.map((p) => p[0]);
  const x0 = Math.min(...xs) + 0.01;
  const x1 = Math.max(...xs) - 0.01;
  const len = x1 - x0;
  const W = shape.width;
  const belt = shape.belt;
  const hwIn = shape.wheelZ[0] - 0.06; // inside face of the wheel wells

  const halfWidth = (x: number) => {
    // rounded off towards the nose and the tail, in plan
    const ef = (x1 - x) / (len * (0.1 + 0.1 * o.noseRound));
    const er = (x - x0) / (len * 0.09);
    const f = (e: number, min: number) => (e >= 1 ? 1 : min + (1 - min) * Math.sqrt(Math.max(0, 1 - (1 - e) * (1 - e))));
    return (W / 2) * Math.min(f(ef, 0.7 - 0.12 * o.noseRound), f(er, 0.82));
  };
  const topAt = (x: number) => spanAt(main, Math.min(x1, Math.max(x0, x)))?.[1] ?? belt;
  // the sills sit low; the overhangs lift a little at the very ends (approach and departure)
  const floorAt = (x: number) => o.clearance + 0.08 * (1 - smooth(0, 0.3, x - x0)) + 0.05 * (1 - smooth(0, 0.3, x1 - x));
  // over each wheel the flank stops at its arch
  const archAt = (x: number) => {
    let y = -Infinity;
    for (const w of shape.wheels) {
      const R = w.r + 0.075;
      const dx = x - w.x;
      if (Math.abs(dx) < R) y = Math.max(y, w.r + Math.sqrt(R * R - dx * dx));
    }
    return y;
  };

  // stations along the car, closer together where the shape changes fastest (the ends)
  const N = 150;
  const stations: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    stations.push(x0 + len * (0.5 - 0.5 * Math.cos(Math.PI * t)));
  }
  // wheel arch edges exactly on a station each, so the arch is a clean curve
  for (const w of shape.wheels) for (let k = -6; k <= 6; k++) stations.push(w.x + (k / 6) * (w.r + 0.075) * 0.999);
  stations.sort((a, b) => a - b);

  type Pt = { z: number; y: number };
  const rings: { x: number; pts: Pt[]; parts: Part[] }[] = [];
  for (const x of stations) {
    const top = topAt(x);
    const floor = floorAt(x);
    const hw = halfWidth(x);
    // where the flank stops: the arch over a wheel, else the floor
    const arch = archAt(x);
    const sideBot = Math.min(Math.max(floor, arch), Math.min(top, belt) - 0.05);
    const yS = Math.max(sideBot + 0.04, Math.min(top, belt));
    const cabin = smooth(0.02, 0.2, top - belt);
    const pts: Pt[] = [];
    const parts: Part[] = [];
    // floor, and the well's inner wall and roof (all collapse to nothing away from the wheels)
    const wellIn = Math.min(hwIn, hw * 0.92);
    pts.push({ z: 0, y: floor }, { z: wellIn, y: floor }, { z: wellIn, y: sideBot }, { z: hw * 0.985, y: sideBot });
    parts.push("dark", "dark", "dark");
    // the flank: tucked in at the sill, fullest a third of the way up, rolling into the shoulder
    for (let i = 1; i <= SIDE; i++) {
      const s = i / SIDE;
      const y = sideBot + (yS - sideBot) * s;
      const z = hw * (1 - 0.045 * Math.pow(1 - s, 3) - 0.025 * Math.pow(s, 5));
      pts.push({ z, y });
      parts.push("paint");
    }
    // the top: a bonnet or boot lid (crowned, rounded at its edges) blending into the glasshouse and roof
    const roofW = hw * o.roofWidth;
    for (let i = 1; i <= TOP; i++) {
      const t = i / TOP;
      // bonnet: rounds over the edge then runs flat to the middle with a little crown
      const hz = hw * 0.97 * (1 - Math.pow(t, 1.35));
      const hy = yS + 0.035 * Math.sin(Math.min(1, t * 3) * Math.PI * 0.5) + 0.02 * (1 - (hz / hw) ** 2) * t;
      // cabin: a step in at the shoulder, glass leaning in to the roof's edge, then a crowned roof
      let cz: number;
      let cy: number;
      if (t <= 0.5) {
        const u = t / 0.5;
        cz = hw * 0.93 + (roofW - hw * 0.93) * u;
        cy = yS + (top - 0.045 - yS) * (1 - Math.pow(1 - u, 1.6));
      } else {
        const u = (t - 0.5) / 0.5;
        cz = roofW * (1 - u);
        cy = top - 0.045 * Math.pow(cz / roofW, 2);
      }
      pts.push({ z: hz + (cz - hz) * cabin, y: hy + (cy - hy) * cabin });
      parts.push("paint");
    }
    rings.push({ x, pts, parts });
  }

  // the skin is all paint (a darker roof on some liveries); the glass is laid over it afterwards
  const geometries = new Map<Part, THREE.BufferGeometry>();
  const buckets = new Map<Part, number[]>();
  const push = (part: Part, ...v: number[]) => {
    let b = buckets.get(part);
    if (!b) buckets.set(part, (b = []));
    b.push(...v);
  };
  const firstTop = 3 + SIDE; // index of the last flank point (the shoulder)
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r];
    const B = rings[r + 1];
    if (B.x - A.x < 1e-4) continue;
    const xm = (A.x + B.x) / 2;
    const inCabin = topAt(xm) - belt > 0.12;
    for (let k = 0; k + 1 < A.pts.length; k++) {
      let part = A.parts[k];
      if (k >= firstTop + TOP / 2 && inCabin) part = "roof";
      for (const s of [1, -1]) {
        const a: number[] = [A.x, A.pts[k].y, s * A.pts[k].z];
        const b: number[] = [A.x, A.pts[k + 1].y, s * A.pts[k + 1].z];
        const c: number[] = [B.x, B.pts[k + 1].y, s * B.pts[k + 1].z];
        const d: number[] = [B.x, B.pts[k].y, s * B.pts[k].z];
        // the right side's quads face out with this winding; the mirror image flips them
        if (s === 1) push(part, ...a, ...c, ...b, ...a, ...d, ...c);
        else push(part, ...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  }
  // close the nose and tail: each end section pulled in to a point a few centimetres further out
  for (const [ring, dir] of [[rings[0], -1], [rings[rings.length - 1], 1]] as const) {
    const pts = ring.pts;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const tip = [ring.x + dir * 0.035, cy, 0];
    for (let k = 0; k + 1 < pts.length; k++) {
      for (const s of [1, -1]) {
        const a = [ring.x, pts[k].y, s * pts[k].z];
        const b = [ring.x, pts[k + 1].y, s * pts[k + 1].z];
        const flip = (dir === 1) === (s === 1);
        const part: Part = "paint";
        if (flip) push(part, ...a, ...b, ...tip);
        else push(part, ...a, ...tip, ...b);
      }
    }
  }
  // ---- glass, laid just proud of the skin ----
  /** The section at any x, between stations. */
  const ringAt = (x: number): Pt[] => {
    let i = 0;
    while (i + 2 < rings.length && rings[i + 1].x < x) i++;
    const A = rings[i];
    const B = rings[i + 1];
    const t = B.x > A.x ? Math.min(1, Math.max(0, (x - A.x) / (B.x - A.x))) : 0;
    return A.pts.map((p, k) => ({ z: p.z + (B.pts[k].z - p.z) * t, y: p.y + (B.pts[k].y - p.y) * t }));
  };
  /** The glasshouse's side at a height: how far out it is (searching the cabin's side points). */
  const sideZ = (x: number, y: number) => {
    const pts = ringAt(x);
    // up the glass, then on over the roof's edge (the outline's top corners reach it)
    for (let k = firstTop; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) return a.z + ((y - a.y) / (b.y - a.y)) * (b.z - a.z);
    }
    return y < pts[firstTop].y ? pts[firstTop].z : pts[firstTop + TOP / 2].z;
  };
  /** The top of the body at a point across it. */
  const topY = (x: number, z: number) => {
    const pts = ringAt(x);
    const az = Math.abs(z);
    for (let k = firstTop; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if ((a.z - az) * (b.z - az) <= 0 && a.z !== b.z) return a.y + ((az - a.z) / (b.z - a.z)) * (b.y - a.y);
    }
    return az >= pts[firstTop].z ? pts[firstTop].y : pts[pts.length - 1].y;
  };
  const glass: number[] = [];
  // side windows: the window outline, finely triangulated and wrapped onto the glasshouse
  if (shape.windows.length >= 3) {
    const win = shape.windows;
    const tris = THREE.ShapeUtils.triangulateShape(win.map(([x, y]) => new THREE.Vector2(x, y)), []);
    const split = (a: XY, b: XY, c: XY, depth: number, out: XY[][]) => {
      if (depth === 0) return void out.push([a, b, c]);
      const m = (p: XY, q: XY): XY => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      split(a, ab, ca, depth - 1, out);
      split(ab, b, bc, depth - 1, out);
      split(ca, bc, c, depth - 1, out);
      split(ab, bc, ca, depth - 1, out);
    };
    const fine: XY[][] = [];
    for (const [i, j, k] of tris) split(win[i], win[j], win[k], 3, fine);
    for (const [a, b, c] of fine) {
      for (const sgn of [1, -1]) {
        const P = (p: XY) => [p[0], p[1], sgn * (sideZ(p[0], p[1]) + 0.009)];
        // wound to face out on each side (the outline runs counter-clockwise seen from the right)
        if (sgn === 1) glass.push(...P(a), ...P(b), ...P(c));
        else glass.push(...P(a), ...P(c), ...P(b));
      }
    }
  }
  // windscreen and rear screen: where the roof line drops steeply through the cabin
  const cabinXs = stations.filter((x) => topAt(x) - belt > 0.1);
  if (cabinXs.length) {
    const c0 = cabinXs[0];
    const c1 = cabinXs[cabinXs.length - 1];
    const slopeAt = (x: number) => (topAt(x + 0.06) - topAt(x - 0.06)) / 0.12;
    // the longest steep run at each end of the cabin
    const run = (from: number, step: number, want: (s: number) => boolean) => {
      let a = from;
      while ((step > 0 ? a < c1 : a > c0) && !want(slopeAt(a))) a += step;
      let b = a;
      while ((step > 0 ? b < c1 : b > c0) && want(slopeAt(b))) b += step;
      return [Math.min(a, b), Math.max(a, b)] as const;
    };
    const screens = [run(c1, -0.01, (sl) => sl < -0.4), run(c0, 0.01, (sl) => sl > 0.3)];
    for (const [sa, sb] of screens) {
      if (sb - sa < 0.15) continue;
      const nx = 24;
      const nz = 16;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const cell = (ii: number, jj: number) => {
            const x = sa + 0.03 + ((sb - sa - 0.06) * ii) / nx;
            // as wide as the glasshouse there, less the pillars; the corners rounded
            const edge = Math.abs(ii / nx - 0.5) * 2;
            // (never wider than the roof's edge there: the screen sits inside its pillars)
            const roofEdge = ringAt(x)[firstTop + TOP / 2].z;
            const w = Math.min(roofEdge * 1.08, sideZ(x, topAt(x) - 0.05)) * (1 - 0.1 * Math.pow(edge, 6)) - 0.07;
            const z = -w + (2 * w * jj) / nz;
            return [x, topY(x, z) + 0.006, z];
          };
          const a = cell(i, j), b = cell(i + 1, j), c = cell(i + 1, j + 1), d = cell(i, j + 1);
          // upward-facing whichever way the screen leans
          glass.push(...a, ...c, ...b, ...a, ...d, ...c);
        }
      }
    }
  }
  if (glass.length) buckets.set("glass", glass);

  for (const [part, list] of buckets) {
    const g = weld(list);
    g.computeVertexNormals();
    geometries.set(part, g);
  }
  return { geometries, halfWidth, topAt, x0, x1 };
}

/** One shared vertex per position, so the skin shades smoothly across its strips. */
function weld(list: number[]): THREE.BufferGeometry {
  const map = new Map<string, number>();
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < list.length; i += 3) {
    const key = `${Math.round(list[i] * 2000)},${Math.round(list[i + 1] * 2000)},${Math.round(list[i + 2] * 2000)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = verts.length / 3;
      verts.push(list[i], list[i + 1], list[i + 2]);
      map.set(key, k);
    }
    index.push(k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(index);
  return g;
}
