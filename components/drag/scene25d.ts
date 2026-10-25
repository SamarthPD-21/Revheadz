import { EIGHTH_MILE_M, QUARTER_MILE_M, SIXTY_FT_M } from "../../lib/drag/race";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { BODIES } from "../Silhouette";
import type { SceneCar, SceneFrame } from "./scene";

/**
 * The drag strip in 2.5D, isometric-style (like Project Zomboid or a top-down action RPG):
 * an orthographic camera turned diagonally and tilted down, so the strip runs from the lower
 * left to the upper right and you look down on everything at an angle. Cars and scenery are
 * small solid models (boxes, tapered cabins, wheel cylinders) drawn face by face with flat
 * shading, back to front.
 *
 * Plain canvas 2D only, no WebGL: a few hundred filled polygons a frame, glows as
 * pre-rendered sprites (no shadowBlur), text only on cached canvases.
 */

type V = [number, number, number];
type Canvas = HTMLCanvasElement;

const LANE_Z = { me: 2, opp: -2 }; // + is the near side
const WALL_Z = 6.3;
const LINE_Z = 4.1;

// camera: turned about the vertical axis, then tilted down (degrees)
const YAW = (28 * Math.PI) / 180;
const PITCH = (36 * Math.PI) / 180;
const R: V = [Math.cos(YAW), 0, Math.sin(YAW)]; // screen right
const FWD: V = [Math.sin(YAW), 0, -Math.cos(YAW)]; // horizontal "into the screen"
const VIEW: V = [Math.sin(YAW) * Math.cos(PITCH), -Math.sin(PITCH), -Math.cos(YAW) * Math.cos(PITCH)]; // camera looks along this
const LIGHT: V = norm([-0.35, 0.85, 0.45]);

function norm(v: V): V {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const makeCanvas = (w: number, h: number): [Canvas, CanvasRenderingContext2D] => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return [c, c.getContext("2d")!];
};

function glowSprite(color: string, size = 128): Canvas {
  const [c, x] = makeCanvas(size, size);
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, color);
  g.addColorStop(0.25, color.replace(/[\d.]+\)$/, "0.45)"));
  g.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return c;
}

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbStr = (c: [number, number, number], k = 1) => `rgb(${Math.min(255, Math.round(c[0] * k))},${Math.min(255, Math.round(c[1] * k))},${Math.min(255, Math.round(c[2] * k))})`;

/** A solid made of planar faces (each listed counter-clockwise from outside, or flipped by `fix`). */
interface Solid {
  faces: V[][];
  color: [number, number, number];
  /** Faces drawn unlit (lamps, glass highlights). */
  flat?: boolean;
  center: V;
}

/** Axis-aligned box from two corners. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: [number, number, number], flat = false): Solid {
  const p = (x: number, y: number, z: number): V => [x, y, z];
  const a = p(x0, y0, z0), b = p(x1, y0, z0), c = p(x1, y1, z0), d = p(x0, y1, z0);
  const e = p(x0, y0, z1), f = p(x1, y0, z1), g = p(x1, y1, z1), h = p(x0, y1, z1);
  return { faces: [[a, d, c, b], [e, f, g, h], [a, e, h, d], [b, c, g, f], [d, h, g, c], [a, b, f, e]], color, flat, center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] };
}

/** A wheel: an n-sided cylinder along z, rotated by `spin`. */
function wheel(cx: number, cy: number, r: number, z0: number, z1: number, spin: number, color: [number, number, number]): Solid {
  const n = 10;
  const ring = (z: number) => Array.from({ length: n }, (_, i): V => {
    const a = spin + (i * Math.PI * 2) / n;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
  });
  const A = ring(z0);
  const B = ring(z1);
  const faces: V[][] = [A.slice().reverse(), B];
  for (let i = 0; i < n; i++) faces.push([A[i], A[(i + 1) % n], B[(i + 1) % n], B[i]]);
  return { faces, color, center: [cx, cy, (z0 + z1) / 2] };
}

type XY = [number, number];

/** The silhouette path syntax (absolute M / L / Q / Z) as polygons, curves sampled; open subpaths dropped. */
function pathPolys(d: string): XY[][] {
  const tok = d.match(/[MLQZ]|-?\d+(\.\d+)?/g) ?? [];
  const out: XY[][] = [];
  let cur: XY[] = [];
  let i = 0;
  const n = () => Number(tok[i++]);
  while (i < tok.length) {
    const c = tok[i++];
    if (c === "M") {
      cur = [[n(), n()]];
    } else if (c === "L") cur.push([n(), n()]);
    else if (c === "Q") {
      const [x0, y0] = cur[cur.length - 1];
      const cx = n(), cy = n(), x1 = n(), y1 = n();
      for (let t = 1; t <= 4; t++) {
        const u = t / 4;
        cur.push([(1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * x1, (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * cy + u * u * y1]);
      }
    } else if (c === "Z") {
      if (cur.length >= 3) out.push(cur);
      cur = [];
    }
  }
  return out;
}

/** Keeps the part of a polygon above (keepAbove) or below a horizontal line (Sutherland-Hodgman). */
function clipY(poly: XY[], yCut: number, keepAbove: boolean): XY[] {
  const inside = (p: XY) => (keepAbove ? p[1] >= yCut : p[1] <= yCut);
  const out: XY[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const t = (yCut - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, yCut]);
    }
  }
  return out;
}

const area = (poly: XY[]) => poly.reduce((s, p, i) => {
  const q = poly[(i + 1) % poly.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0) / 2;

/** A car built from its garage side profile: x from the rear (0) to the nose (len), y up. */
interface CarShape {
  len: number;
  width: number;
  height: number;
  /** Body prisms (closed profiles, counter-clockwise). */
  bodies: XY[][];
  /** Near-side window glass, if any. */
  windows: XY[];
  /** Wings and spoilers, extruded thinner. */
  wings: XY[][];
  wheels: { x: number; r: number }[];
  /** Wheel tread span across the car, from the centre line. */
  wheelZ: [number, number];
  belt: number;
  bike: boolean;
}

const WIDTH: Record<string, number> = { muscle: 1.95, coupe: 1.85, sport: 1.8, supercar: 2.0, gt: 1.95, hatch: 1.8, rally: 1.85, gtcar: 2.05, formula: 0.8, superbike: 0.36, cruiser: 0.5 };
const shapeCache = new Map<string, CarShape>();

function carShape(cfg: VehicleConfig): CarShape {
  const kind = cfg.ui.silhouette;
  const hit = shapeCache.get(kind);
  if (hit) return hit;
  const b = BODIES[kind];
  const bike = cfg.type === "bike";
  const formula = kind === "formula";
  const raw = pathPolys(b.body);
  const all = raw.flat();
  const minX = Math.min(...all.map((p) => p[0]));
  const maxX = Math.max(...all.map((p) => p[0]));
  const ground = Math.max(...b.wheels.map(([, wy]) => wy + b.r));
  const len = bike ? 2.2 : formula ? 4.8 : 4.6;
  const k = len / (maxX - minX);
  // the silhouettes face left (nose at small x): mirror so the nose is at +x
  const toCar = ([x, y]: XY): XY => [(maxX - x) * k, (ground - y) * k];
  const ccw = (poly: XY[]) => (area(poly) < 0 ? [...poly].reverse() : poly);
  const bodies = raw.map((poly) => ccw(poly.map(toCar)));
  const height = Math.max(...bodies.flat().map((p) => p[1]));
  const belt = height * (kind === "hatch" || kind === "rally" ? 0.55 : 0.6);
  const main = bodies.reduce((a, c) => (Math.abs(area(c)) > Math.abs(area(a)) ? c : a));
  // side glass: the body above the beltline, pulled in from the edges
  let windows: XY[] = [];
  if (!bike && !formula) {
    const top = clipY(main, belt + 0.04, true);
    if (top.length >= 3) {
      const cx = top.reduce((s, p) => s + p[0], 0) / top.length;
      const cy = top.reduce((s, p) => s + p[1], 0) / top.length;
      windows = top.map(([x, y]) => [cx + (x - cx) * 0.86, cy + (y - cy) * 0.8]);
    }
  }
  const wings = b.extra ? pathPolys(b.extra).map((poly) => ccw(poly.map(toCar))) : [];
  const wheels = b.wheels.map(([wx]) => ({ x: (maxX - wx) * k, r: b.r * k }));
  const width = WIDTH[kind] ?? 1.85;
  const wheelZ: [number, number] = bike ? [-0.06, 0.06] : formula ? [0.62, 0.98] : [width / 2 - 0.26, width / 2 + 0.03];
  const shape = { len, width, height, bodies, windows, wings, wheels, wheelZ, belt, bike };
  shapeCache.set(kind, shape);
  return shape;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  r: number;
  life: number;
  max: number;
  vx: number;
  vz: number;
}
interface Item {
  depth: number;
  draw: () => void;
}

export class DragScene25D {
  private readonly glows = new Map<string, Canvas>();
  private readonly boards = new Map<string, Canvas>();
  private timing: { canvas: Canvas; ctx: CanvasRenderingContext2D; key: string } | null = null;
  private crowd: Canvas | null = null;
  private puffs: Puff[] = [];
  private lastTime = 0;
  private prevSpeed = { me: 0, opp: 0 };
  private braking = { me: 0, opp: 0 };
  private pitch = { me: 0, opp: 0 };
  private camX = -6;
  /** Camera position relative to your car (eased), m. */
  private lead = 7;
  /** Smoothed acceleration per lane, m/s². */
  private accel = { me: 0, opp: 0 };
  private zoom = 1;
  // per-frame projection state
  private cx = 0;
  private cy = 0;
  private k = 1;
  private cam: V = [0, 0, 0];

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  private glow(color: string) {
    let g = this.glows.get(color);
    if (!g) this.glows.set(color, (g = glowSprite(color)));
    return g;
  }

  private board(label: string) {
    let b = this.boards.get(label);
    if (!b) {
      const [c, x] = makeCanvas(256, 96);
      x.fillStyle = "#f4f4f5";
      x.fillRect(0, 0, 256, 96);
      x.fillStyle = "#0b0b0f";
      x.font = "900 46px system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(label, 128, 50);
      this.boards.set(label, (b = c));
    }
    return b;
  }

  /**
   * The grandstand front: rows of seating with a sparse, soft crowd. Low contrast and no
   * pixel-sized detail, so it doesn't shimmer when scaled down and scrolled.
   */
  private crowdTex() {
    if (!this.crowd) {
      // one tier = 12 m of seating, drawn at a realistic scale (~40 px per metre) so heads are
      // big enough not to shimmer, and softened slightly for clean downscaling
      const [c, x] = makeCanvas(512, 40);
      x.fillStyle = "#17161e";
      x.fillRect(0, 0, 512, 40);
      x.fillStyle = "#1e1d27";
      x.fillRect(0, 30, 512, 10); // the seat row
      x.filter = "blur(0.8px)";
      let seed = 11;
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let px = 6; px < 506; px += 9 + rand() * 14) {
        if (rand() < 0.22) continue; // empty seats
        const hue = Math.floor(rand() * 360);
        x.fillStyle = `hsl(${hue},16%,${30 + rand() * 12}%)`;
        x.beginPath();
        x.ellipse(px, 26, 6, 8, 0, 0, Math.PI * 2); // shoulders
        x.fill();
        x.fillStyle = `hsl(${20 + rand() * 20},20%,${28 + rand() * 18}%)`;
        x.beginPath();
        x.arc(px, 13, 4.5, 0, Math.PI * 2); // head
        x.fill();
      }
      x.filter = "none";
      this.crowd = c;
    }
    return this.crowd;
  }

  private timingBoard(me: SceneCar, opp: SceneCar) {
    if (!this.timing) {
      const [canvas, ctx] = makeCanvas(512, 200);
      this.timing = { canvas, ctx, key: "" };
    }
    const key = `${me.et}|${opp.et}`;
    if (key !== this.timing.key) {
      this.timing.key = key;
      const c = this.timing.ctx;
      c.fillStyle = "#050508";
      c.fillRect(0, 0, 512, 200);
      c.font = "700 20px system-ui, sans-serif";
      c.fillStyle = "#71717a";
      c.fillText("ET", 24, 36);
      c.fillText("KM/H", 24, 130);
      c.font = "700 56px ui-monospace, monospace";
      const lane = (car: SceneCar, x0: number) => {
        c.fillStyle = car.et !== null ? car.cfg.ui.accent : "#26252e";
        c.fillText(car.et !== null ? car.et.toFixed(3) : "-.---", x0, 92);
        c.fillText(car.trapKmh !== null ? String(Math.round(car.trapKmh)) : "---", x0, 184);
      };
      lane(opp, 24);
      lane(me, 270);
    }
    return this.timing.canvas;
  }

  // ---------------------------------------------------------------- projection

  private p(v: V): [number, number] {
    const d = sub(v, this.cam);
    const x = dot(d, R);
    const up = dot(d, FWD) * Math.sin(PITCH) + d[1] * Math.cos(PITCH);
    return [this.cx + x * this.k, this.cy - up * this.k];
  }

  private depth(v: V) {
    return dot(sub(v, this.cam), VIEW);
  }

  /** `seal` also strokes the edge in the fill colour, closing antialiasing seams between touching faces. */
  private poly(pts: V[], fill: string, seal = false) {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.beginPath();
    pts.forEach((v, i) => {
      const [x, y] = this.p(v);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    if (seal) {
      ctx.strokeStyle = fill;
      ctx.lineWidth = 0.9;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
  }

  /** Draws a solid's visible faces with flat shading. */
  private solid(s: Solid, xf: (v: V) => V) {
    const c = xf(s.center);
    for (const face of s.faces) {
      const w = face.map(xf);
      let n = norm(cross(sub(w[1], w[0]), sub(w[2], w[0])));
      const fc = w.reduce<V>((a, v) => [a[0] + v[0] / w.length, a[1] + v[1] / w.length, a[2] + v[2] / w.length], [0, 0, 0]);
      if (dot(n, sub(fc, c)) < 0) n = [-n[0], -n[1], -n[2]]; // make it face outwards
      if (dot(n, VIEW) >= 0) continue; // facing away from the camera
      const light = s.flat ? 1.25 : 0.42 + 0.7 * Math.max(0, dot(n, LIGHT));
      this.poly(w, rgbStr(s.color, light), true);
    }
  }

  /** Maps an image onto a vertical face: top-left, top-right, bottom-left corners in world space. */
  private image(img: CanvasImageSource, iw: number, ih: number, tl: V, tr: V, bl: V) {
    const [ax, ay] = this.p(tl);
    const [bx, by] = this.p(tr);
    const [cx, cy] = this.p(bl);
    const ctx = this.ctx;
    ctx.save();
    ctx.transform((bx - ax) / iw, (by - ay) / iw, (cx - ax) / ih, (cy - ay) / ih, ax, ay);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  private sprite(img: Canvas, at: V, size: number, alpha = 1, add = false) {
    const [x, y] = this.p(at);
    const s = size * this.k;
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    if (add) ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- frame

  draw(f: SceneFrame, w: number, h: number) {
    const ctx = this.ctx;
    const dt = Math.min(0.05, Math.max(0, f.time - this.lastTime));
    this.lastTime = f.time;
    const me = f.me;
    const portrait = h > w;

    // follow your car (it sits a little below and left of centre so you see the strip ahead)
    const myX = me.distM - me.rollBackM;
    const launched = me.distM > 0.05;
    // The camera is locked to the car; only the framing offset eases. (Chasing the car with a
    // lag made the gap between them wobble with every uneven frame: that was the jitter.)
    const leadTarget = launched ? (portrait ? 3 : 6) : 1 - myX;
    this.lead += (leadTarget - this.lead) * Math.min(1, dt * 2.5);
    this.camX = myX + this.lead;
    this.zoom += (1 - Math.min(0.25, me.speedKmh / 900) - this.zoom) * Math.min(1, dt * 2);
    this.k = (portrait ? w / 11.5 : Math.min(w / 30, h / 15)) * this.zoom;
    // shake as smooth noise (summed sines), not a fresh random offset every frame
    const sh = f.shake * f.shake;
    const t = f.time;
    this.cx = w / 2 + (Math.sin(t * 47) + Math.sin(t * 31.7) * 0.6) * 3 * sh;
    this.cy = h * (portrait ? 0.6 : 0.52) + (Math.sin(t * 39.3) + Math.sin(t * 57.1) * 0.5) * 2.2 * sh;
    this.cam = [this.camX, 0, 0];
    const x0 = this.camX - (portrait ? 40 : 55);
    const x1 = this.camX + (portrait ? 55 : 75);

    // night backdrop
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#07060d");
    bg.addColorStop(1, "#0e0d14");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // ---- ground (flat, drawn first) ----
    const G = (xa: number, xb: number, za: number, zb: number, fill: string, y = 0) =>
      this.poly([[xa, y, za], [xb, y, za], [xb, y, zb], [xa, y, zb]], fill);
    G(x0, x1, -60, 60, "#0b0a10");
    for (let k = Math.floor(x0 / 8); k < Math.ceil(x1 / 8); k++) G(k * 8, k * 8 + 8, -WALL_Z, WALL_Z, k % 2 ? "#1c1b22" : "#19181f");
    for (const lz of [LANE_Z.me, LANE_Z.opp]) for (let k = 0; k < 10; k++) G(-4 + k * 8, 4 + k * 8, lz - 0.9, lz + 0.9, `rgba(0,0,0,${0.5 * (1 - k / 10)})`);
    G(x0, x1, -0.06, 0.06, "#c99a1c");
    G(x0, x1, LINE_Z - 0.05, LINE_Z + 0.05, "#bdbdc6");
    G(x0, x1, -LINE_Z - 0.05, -LINE_Z + 0.05, "#bdbdc6");
    for (let k = Math.floor(x0 / 6); k < Math.ceil(x1 / 6); k++) {
      G(k * 6, k * 6 + 2.4, 3.36, 3.44, "#5c5b66");
      G(k * 6, k * 6 + 2.4, -3.44, -3.36, "#5c5b66");
    }
    G(-0.15, 0.15, -WALL_Z, WALL_Z, "#f4f4f5");
    for (let k = 0; k < 14; k++) {
      const za = -WALL_Z + (k * 2 * WALL_Z) / 14;
      const zb = za + (2 * WALL_Z) / 14;
      G(QUARTER_MILE_M - 0.5, QUARTER_MILE_M, za, zb, k % 2 ? "#f4f4f5" : "#0b0b0f");
      G(QUARTER_MILE_M, QUARTER_MILE_M + 0.5, za, zb, k % 2 ? "#0b0b0f" : "#f4f4f5");
    }
    // light pools under the towers
    const pool = this.glow("rgba(255,241,214,1)");
    for (let k = Math.floor((x0 - 10) / 34); k <= Math.ceil(x1 / 34); k++) this.sprite(pool, [k * 34 + 10, 0, -1], 20, 0.06, true);

    // ---- everything with height, sorted back to front ----
    const items: Item[] = [];
    const add = (center: V, draw: () => void) => items.push({ depth: this.depth(center), draw });
    const id = (v: V) => v;
    const wallC: [number, number, number] = [52, 51, 60];
    for (let k = Math.floor(x0 / 12); k < Math.ceil(x1 / 12); k++) {
      const xa = k * 12;
      const xb = xa + 12;
      // far wall with ad panels on its inner face
      add([xa + 6, 0.5, -WALL_Z], () => {
        this.solid(box(xa, xb, 0, 1.1, -WALL_Z - 0.35, -WALL_Z, wallC), id);
        const panel = ((Math.floor(xa / 24) % 3) + 3) % 3;
        if (k % 2 === 0) this.poly([[xa + 0.4, 0.95, -WALL_Z + 0.01], [xa + 23.6, 0.95, -WALL_Z + 0.01], [xa + 23.6, 0.2, -WALL_Z + 0.01], [xa + 0.4, 0.2, -WALL_Z + 0.01]], panel === 0 ? "#c2580f" : panel === 1 ? "#2a2834" : "#7fae1f");
      });
      // near wall (low, in front of everything else)
      add([xa + 6, 0.5, WALL_Z], () => this.solid(box(xa, xb, 0, 0.9, WALL_Z, WALL_Z + 0.35, wallC), id));
      // grandstand tiers behind the far wall, crowd on the front faces
      for (let t = 0; t < 5; t++) {
        const z1 = -8.2 - t * 2.2;
        const y1 = 0.9 + t * 0.9;
        add([xa + 6, y1 / 2, z1 - 1.1], () => {
          this.solid(box(xa, xb, 0, y1, z1 - 2.2, z1, [21, 20, 28]), id);
          this.image(this.crowdTex(), 512, 40, [xa, y1 + 0.05, z1 + 0.01], [xb, y1 + 0.05, z1 + 0.01], [xa, y1 - 0.85, z1 + 0.01]);
        });
      }
    }
    // distance boards on the far wall
    for (const [m, label] of [[SIXTY_FT_M, "60 FT"], [100.584, "330 FT"], [EIGHTH_MILE_M, "1/8 MILE"], [304.8, "1000 FT"]] as [number, string][]) {
      if (m < x0 || m > x1) continue;
      add([m, 2, -WALL_Z - 0.2], () => {
        this.solid(box(m - 0.06, m + 0.06, 1.1, 1.6, -WALL_Z - 0.25, -WALL_Z - 0.15, [40, 40, 48]), id);
        this.image(this.board(label), 256, 96, [m - 1.3, 2.6, -WALL_Z - 0.1], [m + 1.3, 2.6, -WALL_Z - 0.1], [m - 1.3, 1.6, -WALL_Z - 0.1]);
      });
    }
    // light towers on the far side
    const lamp = this.glow("rgba(255,244,214,1)");
    for (let k = Math.floor((x0 - 10) / 34); k <= Math.ceil(x1 / 34); k++) {
      const x = k * 34 + 10;
      add([x, 6, -7.4], () => {
        this.solid(box(x - 0.15, x + 0.15, 0, 13, -7.55, -7.25, [40, 39, 48]), id);
        this.solid(box(x - 0.9, x + 0.9, 13, 13.5, -7.8, -7.0, [235, 230, 210], true), id);
        this.sprite(lamp, [x, 13.2, -7.4], 6, 0.9, true);
      });
    }
    // finish gantry with the timing board
    if (QUARTER_MILE_M > x0 - 10 && QUARTER_MILE_M < x1 + 10) {
      const gx = QUARTER_MILE_M + 6;
      add([gx, 3, -WALL_Z - 1], () => {
        this.solid(box(gx - 0.2, gx + 0.2, 0, 3.6, -WALL_Z - 1.2, -WALL_Z - 0.8, [40, 39, 48]), id);
        this.solid(box(gx - 3.4, gx + 3.4, 3.6, 6.4, -WALL_Z - 1.2, -WALL_Z - 0.9, [10, 10, 14]), id);
        this.image(this.timingBoard(f.me, f.opp), 512, 200, [gx - 3.3, 6.3, -WALL_Z - 0.89], [gx + 3.3, 6.3, -WALL_Z - 0.89], [gx - 3.3, 3.7, -WALL_Z - 0.89]);
      });
    }
    // the tree, on the centre line just past the start, lights facing the cars
    add([5, 2, 0], () => this.tree(f));

    // cars and their smoke
    for (const lane of ["opp", "me"] as const) {
      const c = f[lane];
      // acceleration from frame-to-frame speed is noisy (uneven frames, gear changes): smooth it
      // over ~0.25 s before it moves the body, or the cars twitch
      if (dt > 0) {
        const raw = Math.max(-15, Math.min(15, (c.speedKmh - this.prevSpeed[lane]) / 3.6 / dt));
        this.accel[lane] += (raw - this.accel[lane]) * Math.min(1, dt / 0.25);
      }
      this.prevSpeed[lane] = c.speedKmh;
      const a = this.accel[lane];
      this.braking[lane] += ((a < -2 ? 1 : 0) - this.braking[lane]) * Math.min(1, dt * 4);
      this.pitch[lane] += (Math.max(-1, Math.min(1, a / 12)) - this.pitch[lane]) * Math.min(1, dt * 4);
      const nose = c.distM - c.rollBackM;
      const len = carShape(c.cfg).len;
      const rear = nose - len;
      const z = LANE_Z[lane];
      if (c.distM > 0.05 && c.distM < 24) {
        const n = Math.random() < 1 - c.distM / 24 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          this.puffs.push({ x: rear + 0.4, y: 0.3, z: z + (Math.random() < 0.5 ? -0.8 : 0.8), r: 0.5, life: 0, max: 1.2 + Math.random(), vx: -2 - Math.random() * 2.5, vz: (Math.random() - 0.5) * 2 });
        }
      }
      add([rear + len / 2, 0.6, z], () => this.car(c, lane, rear, f.time));
    }
    const smoke = this.glow("rgba(205,205,214,1)");
    for (const p of this.puffs) {
      add([p.x, p.y, p.z], () => this.sprite(smoke, [p.x, p.y, p.z], p.r * 2, 0.34 * (1 - p.life / p.max)));
      p.life += dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.y += 0.7 * dt;
      p.r += 1.7 * dt;
    }
    this.puffs = this.puffs.filter((p) => p.life < p.max).slice(-200);

    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) it.draw();

    // speed streaks, along the strip's direction on screen
    if (me.speedKmh > 80) {
      const kk = Math.min(1, (me.speedKmh - 80) / 220);
      const [ax, ay] = this.p([0, 0, 0]);
      const [bx, by] = this.p([1, 0, 0]);
      const dl = Math.hypot(bx - ax, by - ay) || 1;
      const ux = (bx - ax) / dl;
      const uy = (by - ay) / dl;
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + 0.1 * kk})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 24; i++) {
        const t = ((i * 0.618 + f.time * (1.2 + 2 * kk)) % 1) * (w + h);
        const off = ((i * 97) % 100) / 100;
        const sx = -h * 0.5 + t * 0.9;
        const sy = h * off + 0.0;
        const len = 40 + 140 * kk;
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx - ux * len, sy - uy * len);
      }
      ctx.stroke();
    }
  }

  private tree(f: SceneFrame) {
    const x = 5;
    const id = (v: V) => v;
    this.solid(box(x - 0.08, x + 0.08, 0, 2.4, -0.08, 0.08, [32, 31, 38]), id);
    this.solid(box(x - 0.2, x + 0.2, 2.4, 4.8, -0.5, 0.5, [12, 12, 16]), id);
    const lanes: [SceneCar["lights"], number][] = [
      [f.opp.lights, -0.24],
      [f.me.lights, 0.24],
    ];
    const ctx = this.ctx;
    for (const [l, dz] of lanes) {
      const rows: [boolean, string][] = [
        [l.stage, "rgba(253,230,138,1)"],
        [l.stage, "rgba(253,230,138,1)"],
        [l.ambers[0], "rgba(251,191,36,1)"],
        [l.ambers[1], "rgba(251,191,36,1)"],
        [l.ambers[2], "rgba(251,191,36,1)"],
        l.red ? [true, "rgba(239,68,68,1)"] : [l.ambers[3], "rgba(251,191,36,1)"],
        [l.green || l.win, l.win ? "rgba(255,255,255,1)" : "rgba(74,222,128,1)"],
      ];
      rows.forEach(([on, color], i) => {
        const at: V = [x - 0.21, 4.6 - i * 0.3, dz];
        const [px, py] = this.p(at);
        const r = Math.max(1.2, (i < 2 ? 0.06 : 0.11) * this.k);
        ctx.fillStyle = on ? color : "#1c1c22";
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        if (on) this.sprite(this.glow(color), at, 1.1, 1, true);
      });
    }
  }

  private car(c: SceneCar, lane: "me" | "opp", rear: number, time: number) {
    const z = LANE_Z[lane];
    const shape = carShape(c.cfg);
    const W = shape.width;
    const spin = -(c.distM - c.rollBackM) / (shape.wheels[0]?.r ?? 0.33);
    const acc = hexRgb(c.cfg.ui.accent);
    const pitch = this.pitch[lane] * 0.035; // rear squats under power, nose dives on the brakes
    const axle = shape.len * 0.2;
    const xf = (pitchable: boolean) => (v: V): V => {
      let [x, y] = v;
      if (pitchable && pitch) {
        const dx = x - axle;
        const dy = y - 0.33;
        x = axle + dx * Math.cos(pitch) - dy * Math.sin(pitch);
        y = 0.33 + dx * Math.sin(pitch) + dy * Math.cos(pitch);
      }
      return [rear + x, y, z + v[2]];
    };
    const body = xf(true);
    const flat = xf(false);
    const shade = (n: V, base: [number, number, number], lit = 1) => rgbStr(base, (0.42 + 0.7 * Math.max(0, dot(n, LIGHT))) * lit);

    // ground: shadow, underglow, headlight beam
    const halfW = Math.max(W, shape.bike ? 0.5 : W) / 2;
    this.poly([flat([-0.15, 0, -halfW - 0.1]), flat([shape.len + 0.15, 0, -halfW - 0.1]), flat([shape.len + 0.35, 0, halfW + 0.35]), flat([0.05, 0, halfW + 0.35])], "rgba(0,0,0,0.55)");
    this.sprite(this.glow(`rgba(${acc.join(",")},1)`), flat([shape.len / 2, 0, 0]), shape.len * 1.1, 0.26, true);
    this.poly([flat([shape.len, 0.01, -0.6]), flat([shape.len + 10, 0.01, -1.6]), flat([shape.len + 10, 0.01, 1.6]), flat([shape.len, 0.01, 0.6])], "rgba(255,250,235,0.05)");

    const tyre: [number, number, number] = [14, 14, 17];
    const wheelSolids = (side: 1 | -1) =>
      shape.wheels.map((w) => wheel(w.x, w.r, w.r, side > 0 ? shape.wheelZ[0] : -shape.wheelZ[1], side > 0 ? shape.wheelZ[1] : -shape.wheelZ[0], spin, tyre));
    // far wheels first (behind the body)
    if (!shape.bike) for (const s of wheelSolids(-1)) this.solid(s, flat);
    else for (const s of wheelSolids(1)) this.solid(s, flat);

    // a profile extruded across the car: the edge strips (roof, bonnet, screens, tail) back to front
    const prism = (poly: XY[], z0: number, z1: number, base: [number, number, number], glassy: boolean) => {
      const strips: { pts: V[]; n: V; glass: boolean; d: number }[] = [];
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        const pts: V[] = [body([ax, ay, z0]), body([bx, by, z0]), body([bx, by, z1]), body([ax, ay, z1])];
        // outward normal of a counter-clockwise edge in the side plane
        const n = norm([by - ay, -(bx - ax), 0]);
        if (dot(n, VIEW) >= 0 || n[1] < -0.2) continue;
        const glass = glassy && ay > shape.belt + 0.02 && by > shape.belt + 0.02 && Math.abs(by - ay) > 0.35 * Math.abs(bx - ax);
        const mid: V = [(pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2, (pts[0][2] + pts[2][2]) / 2];
        strips.push({ pts, n, glass, d: this.depth(mid) });
      }
      strips.sort((p, q) => q.d - p.d);
      for (const st of strips) this.poly(st.pts, st.glass ? rgbStr([20, 26, 38], 0.5 + 0.6 * Math.max(0, dot(st.n, LIGHT))) : shade(st.n, base), true);
      // the near side face
      this.poly(poly.map(([x, y]) => body([x, y, z1])), shade([0, 0, 1], base), true);
    };
    for (const poly of shape.bodies) prism(poly, -W / 2, W / 2, acc, !shape.bike);

    // near-side details: sills, window glass with a pillar, wheel arches
    const side = W / 2 + 0.005;
    for (const poly of shape.bodies) {
      const sill = clipY(poly, shape.height * 0.18, false);
      if (sill.length >= 3) this.poly(sill.map(([x, y]) => body([x, y, side])), rgbStr(acc, 0.32));
    }
    if (shape.windows.length) {
      this.poly(shape.windows.map(([x, y]) => body([x, y, side + 0.002])), "rgb(17,21,31)");
      const xs = shape.windows.map((p) => p[0]);
      const pm = (Math.min(...xs) + Math.max(...xs)) / 2;
      this.poly([body([pm - 0.05, shape.belt, side + 0.004]), body([pm + 0.05, shape.belt, side + 0.004]), body([pm + 0.05, shape.height, side + 0.004]), body([pm - 0.05, shape.height, side + 0.004])], rgbStr(acc, 0.6));
    }
    if (!shape.bike && c.cfg.ui.silhouette !== "formula") {
      for (const w of shape.wheels) {
        const arch: V[] = [];
        for (let i = 0; i <= 10; i++) {
          const a = (i / 10) * Math.PI;
          arch.push(body([w.x + Math.cos(a) * w.r * 1.18, w.r + Math.sin(a) * w.r * 1.18, side + 0.006]));
        }
        this.poly(arch, "rgb(8,8,11)");
      }
    }
    // wings and spoilers, dark
    for (const poly of shape.wings) prism(poly, -W / 2 + 0.05, W / 2 - 0.05, [26, 26, 32], false);
    // rider on a bike
    if (shape.bike) {
      this.solid(box(shape.len * 0.4, shape.len * 0.58, 0.85, 1.32, -0.2, 0.2, [24, 24, 30]), body);
      this.solid(box(shape.len * 0.52, shape.len * 0.66, 1.22, 1.5, -0.15, 0.15, acc), body);
    }
    // near wheels, with spokes turning at road speed
    if (!shape.bike) {
      const ctx = this.ctx;
      for (const s of wheelSolids(1)) this.solid(s, flat);
      // spokes strobe at speed (the wagon-wheel effect): fade them into a blurred rim
      const spokeA = Math.max(0, 1 - c.speedKmh / 35);
      if (c.speedKmh > 8) {
        ctx.strokeStyle = c.cfg.ui.accent;
        ctx.globalAlpha = Math.min(0.55, (c.speedKmh - 8) / 60);
        ctx.lineWidth = Math.max(1.5, 0.12 * this.k);
        for (const w of shape.wheels) {
          const ctr = flat([w.x, w.r, shape.wheelZ[1] + 0.005]);
          ctx.beginPath();
          for (let i = 0; i <= 16; i++) {
            const a = (i / 16) * Math.PI * 2;
            const [ex, ey] = this.p([ctr[0] + Math.cos(a) * w.r * 0.45, ctr[1] + Math.sin(a) * w.r * 0.45, ctr[2]]);
            if (i) ctx.lineTo(ex, ey);
            else ctx.moveTo(ex, ey);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = spokeA;
      ctx.strokeStyle = c.cfg.ui.accent;
      ctx.lineWidth = Math.max(1, 0.05 * this.k);
      ctx.beginPath();
      for (const w of shape.wheels) {
        const centre = flat([w.x, w.r, shape.wheelZ[1] + 0.005]);
        const [cxp, cyp] = this.p(centre);
        for (let i = 0; i < 5; i++) {
          const a = spin + (i * Math.PI * 2) / 5;
          const [ex, ey] = this.p([centre[0] + Math.cos(a) * w.r * 0.62, centre[1] + Math.sin(a) * w.r * 0.62, centre[2]]);
          ctx.moveTo(cxp, cyp);
          ctx.lineTo(ex, ey);
        }
      }
      if (spokeA > 0.01) ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // lights: taillights (brighter on the brakes), headlights, exhaust flames
    const brake = this.braking[lane];
    const lampY = Math.min(shape.height * 0.55, 0.7);
    const sides = shape.bike ? [0] : [-W * 0.33, W * 0.33];
    for (const sz of sides) {
      this.sprite(this.glow("rgba(255,40,30,1)"), body([0, lampY, sz]), 0.7 + 1.1 * brake, 0.55 + 0.45 * brake, true);
      this.sprite(this.glow("rgba(255,250,235,1)"), body([shape.len, lampY * 0.85, sz]), 0.9, 0.7, true);
    }
    if (c.flame > 0.02) {
      for (const sz of shape.bike ? [0] : [-W * 0.24, W * 0.24]) {
        this.sprite(this.glow("rgba(120,170,255,1)"), flat([-0.35 - 0.3 * c.flame, 0.35, sz]), (0.8 + 1.2 * c.flame) * (0.85 + 0.15 * Math.sin(time * 80)), Math.min(1, c.flame * 1.2), true);
      }
    }
  }
}
