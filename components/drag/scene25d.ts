import { EIGHTH_MILE_M, QUARTER_MILE_M, SIXTY_FT_M } from "../../lib/drag/race";
import type { VehicleConfig } from "../../lib/vehicles/types";
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

/** A tapered block (bottom x0..x1 wide w0, top x2..x3 wide w1), centred on z = 0. */
function frustum(x0: number, x1: number, x2: number, x3: number, y0: number, y1: number, w0: number, w1: number, color: [number, number, number]): Solid {
  const a: V = [x0, y0, -w0 / 2], b: V = [x1, y0, -w0 / 2], c: V = [x3, y1, -w1 / 2], d: V = [x2, y1, -w1 / 2];
  const e: V = [x0, y0, w0 / 2], f: V = [x1, y0, w0 / 2], g: V = [x3, y1, w1 / 2], h: V = [x2, y1, w1 / 2];
  return { faces: [[a, d, c, b], [e, f, g, h], [a, e, h, d], [b, c, g, f], [d, h, g, c], [a, b, f, e]], color, center: [(x0 + x1 + x2 + x3) / 4, (y0 + y1) / 2, 0] };
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

/** The car as parts, in car space: x from the rear (0) to the nose (len), y up, z across. */
function carModel(cfg: VehicleConfig, spin: number): { parts: Solid[]; len: number; width: number; rims: { x: number; y: number; r: number; z: number }[] } {
  const acc = hexRgb(cfg.ui.accent);
  const dark = acc.map((v) => v * 0.55) as [number, number, number];
  const tyre: [number, number, number] = [14, 14, 17];
  const glass: [number, number, number] = [16, 20, 30];
  const kind = cfg.ui.silhouette;
  const parts: Solid[] = [];
  const rims: { x: number; y: number; r: number; z: number }[] = [];
  if (cfg.type === "bike") {
    const len = 2.1;
    const r = 0.32;
    for (const x of [0.38, 1.72]) {
      parts.push(wheel(x, r, r, -0.07, 0.07, spin, tyre));
      rims.push({ x, y: r, r: r * 0.6, z: 0.08 });
    }
    parts.push(box(0.35, 1.75, 0.35, 0.7, -0.17, 0.17, acc)); // frame and fairing
    parts.push(box(1.35, 1.8, 0.6, 0.95, -0.2, 0.2, acc)); // nose fairing
    parts.push(box(0.5, 1.0, 0.7, 0.85, -0.14, 0.14, dark)); // seat
    parts.push(box(0.75, 1.15, 0.85, 1.35, -0.2, 0.2, [24, 24, 30])); // rider
    parts.push(box(1.05, 1.35, 1.25, 1.55, -0.15, 0.15, acc)); // helmet
    return { parts, len, width: 0.45, rims };
  }
  if (kind === "formula") {
    const len = 4.8;
    const r = 0.34;
    for (const x of [0.75, 3.85]) {
      for (const s of [-1, 1]) {
        parts.push(wheel(x, r, r, s > 0 ? 0.62 : -0.98, s > 0 ? 0.98 : -0.62, spin, tyre));
        if (s > 0) rims.push({ x, y: r, r: r * 0.6, z: 0.99 });
      }
    }
    parts.push(box(0.4, 4.6, 0.12, 0.5, -0.38, 0.38, acc)); // tub
    parts.push(box(1.2, 2.6, 0.12, 0.45, -0.62, 0.62, dark)); // sidepods
    parts.push(box(4.4, 4.9, 0.06, 0.14, -0.9, 0.9, dark)); // front wing
    parts.push(box(-0.05, 0.35, 0.75, 0.95, -0.55, 0.55, dark)); // rear wing
    parts.push(box(0.05, 0.25, 0.3, 0.75, -0.08, 0.08, dark));
    parts.push(box(2.2, 2.75, 0.5, 0.78, -0.18, 0.18, [24, 24, 30])); // driver
    return { parts, len, width: 1.9, rims };
  }
  const len = 4.6;
  const w = 1.86;
  const r = 0.33;
  for (const x of [0.85, 3.7]) {
    for (const s of [-1, 1]) {
      parts.push(wheel(x, r, r, s * (w / 2 - 0.27), s * (w / 2 + 0.03), spin, tyre));
      if (s > 0) rims.push({ x, y: r, r: r * 0.62, z: w / 2 + 0.035 });
    }
  }
  const low = kind === "supercar" || kind === "gtcar";
  const beltY = low ? 0.78 : 0.86;
  parts.push(box(0.05, len, 0.26, beltY, -w / 2, w / 2, acc)); // lower body
  // cabin: glass sides, with the roof on top
  const cab = low ? [1.25, 3.55, 1.65, 3.05] : [1.05, 3.4, 1.4, 2.95];
  const roofY = low ? 1.14 : 1.32;
  parts.push(frustum(cab[0], cab[1], cab[2], cab[3], beltY, roofY, w * 0.86, w * 0.7, glass));
  parts.push(frustum(cab[2] + 0.05, cab[3] - 0.05, cab[2] + 0.12, cab[3] - 0.12, roofY, roofY + 0.04, w * 0.7, w * 0.66, acc)); // roof
  // lamps (unlit = bright)
  parts.push(box(-0.02, 0.06, beltY - 0.24, beltY - 0.1, -w / 2 + 0.12, -w / 2 + 0.5, [200, 30, 26], true));
  parts.push(box(-0.02, 0.06, beltY - 0.24, beltY - 0.1, w / 2 - 0.5, w / 2 - 0.12, [200, 30, 26], true));
  parts.push(box(len - 0.06, len + 0.02, beltY - 0.2, beltY - 0.08, -w / 2 + 0.12, -w / 2 + 0.45, [245, 245, 235], true));
  parts.push(box(len - 0.06, len + 0.02, beltY - 0.2, beltY - 0.08, w / 2 - 0.45, w / 2 - 0.12, [245, 245, 235], true));
  if (kind === "rally" || kind === "gtcar" || kind === "supercar") {
    parts.push(box(-0.05, 0.4, beltY + 0.28, beltY + 0.36, -w / 2 + 0.05, w / 2 - 0.05, dark)); // wing
    for (const s of [-1, 1]) parts.push(box(0.12, 0.24, beltY, beltY + 0.3, s * 0.55 - 0.04, s * 0.55 + 0.04, dark));
  }
  return { parts, len, width: w, rims };
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

  private crowdTex() {
    if (!this.crowd) {
      const [c, x] = makeCanvas(256, 64);
      x.fillStyle = "#15141c";
      x.fillRect(0, 0, 256, 64);
      for (let i = 0; i < 520; i++) {
        x.fillStyle = `hsla(${Math.floor(Math.random() * 360)},38%,${42 + Math.random() * 25}%,0.9)`;
        x.fillRect(Math.random() * 256, 4 + Math.random() * 56, 2.5, 3.5);
      }
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

  private poly(pts: V[], fill: string) {
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
      this.poly(w, rgbStr(s.color, light));
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
    const target = launched ? myX + (portrait ? 3 : 6) : 1;
    this.camX += (target - this.camX) * Math.min(1, dt * 7);
    if (Math.abs(target - this.camX) > 40) this.camX = target;
    this.zoom += (1 - Math.min(0.25, me.speedKmh / 900) - this.zoom) * Math.min(1, dt * 2);
    this.k = (portrait ? w / 11.5 : Math.min(w / 30, h / 15)) * this.zoom;
    this.cx = w / 2 + (Math.random() - 0.5) * 6 * f.shake * f.shake;
    this.cy = h * (portrait ? 0.6 : 0.52) + (Math.random() - 0.5) * 4 * f.shake * f.shake;
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
          this.image(this.crowdTex(), 256, 64, [xa, y1, z1 + 0.01], [xb, y1, z1 + 0.01], [xa, y1 - 0.85, z1 + 0.01]);
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
      const a = (c.speedKmh - this.prevSpeed[lane]) / 3.6 / Math.max(dt, 1e-3);
      this.prevSpeed[lane] = c.speedKmh;
      this.braking[lane] += ((a < -2 ? 1 : 0) - this.braking[lane]) * Math.min(1, dt * 6);
      this.pitch[lane] += (Math.max(-1, Math.min(1, a / 12)) - this.pitch[lane]) * Math.min(1, dt * 7);
      const nose = c.distM - c.rollBackM;
      const len = c.cfg.type === "bike" ? 2.1 : c.cfg.ui.silhouette === "formula" ? 4.8 : 4.6;
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
        [l.green || l.win, l.win ? "rgba(255,255,255,1)" : "rgba(74,222,128,1)"],
        [l.red, "rgba(239,68,68,1)"],
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
    const spin = -(c.distM - c.rollBackM) / 0.33;
    const model = carModel(c.cfg, spin);
    const pitch = this.pitch[lane] * 0.035; // rear squats under power, nose dives on the brakes
    const axle = model.len * 0.18;
    const toWorld =
      (pitchable: boolean) =>
      (v: V): V => {
        let [x, y] = v;
        if (pitchable && pitch) {
          const dx = x - axle;
          const dy = y - 0.33;
          x = axle + dx * Math.cos(pitch) - dy * Math.sin(pitch);
          y = 0.33 + dx * Math.sin(pitch) + dy * Math.cos(pitch);
        }
        return [rear + x, y, z + v[2]];
      };
    // shadow and underglow on the ground
    this.poly([[rear - 0.15, 0, z - model.width / 2 - 0.15], [rear + model.len + 0.15, 0, z - model.width / 2 - 0.15], [rear + model.len + 0.35, 0, z + model.width / 2 + 0.35], [rear + 0.05, 0, z + model.width / 2 + 0.35]], "rgba(0,0,0,0.55)");
    this.sprite(this.glow(`rgba(${hexRgb(c.cfg.ui.accent).join(",")},1)`), [rear + model.len / 2, 0, z], model.len * 1.1, 0.28, true);
    // headlight beam on the track ahead
    this.poly([[rear + model.len, 0.01, z - 0.6], [rear + model.len + 10, 0.01, z - 1.6], [rear + model.len + 10, 0.01, z + 1.6], [rear + model.len, 0.01, z + 0.6]], "rgba(255,250,235,0.05)");
    // parts, back to front within the car
    const ordered = model.parts
      .map((s) => {
        const isWheel = s.faces.length > 6;
        return { s, xf: toWorld(!isWheel), d: this.depth(toWorld(!isWheel)(s.center)) };
      })
      .sort((a, b) => b.d - a.d);
    for (const o of ordered) this.solid(o.s, o.xf);
    // rims with turning spokes on the near-side wheels
    const ctx = this.ctx;
    for (const rim of model.rims) {
      const centre: V = [rear + rim.x, rim.y, z + rim.z];
      const [cxp, cyp] = this.p(centre);
      ctx.strokeStyle = c.cfg.ui.accent;
      ctx.lineWidth = Math.max(1, 0.05 * this.k);
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = spin + (i * Math.PI * 2) / 5;
        const [ex, ey] = this.p([centre[0] + Math.cos(a) * rim.r, centre[1] + Math.sin(a) * rim.r, centre[2]]);
        ctx.moveTo(cxp, cyp);
        ctx.lineTo(ex, ey);
      }
      ctx.stroke();
    }
    // taillight glow (brighter on the brakes) and exhaust flames
    const brake = this.braking[lane];
    const tail = this.glow("rgba(255,40,30,1)");
    const sides = c.cfg.type === "bike" ? [0] : [-0.62, 0.62];
    for (const s of sides) this.sprite(tail, [rear - 0.05, 0.65, z + s], 0.7 + 1.1 * brake, 0.55 + 0.45 * brake, true);
    if (c.flame > 0.02) {
      const fl = this.glow("rgba(120,170,255,1)");
      for (const s of c.cfg.type === "bike" ? [0] : [-0.45, 0.45]) {
        this.sprite(fl, [rear - 0.35 - 0.3 * c.flame, 0.35, z + s], (0.8 + 1.2 * c.flame) * (0.85 + 0.15 * Math.sin(time * 80)), Math.min(1, c.flame * 1.2), true);
      }
    }
    // headlamp glow
    const head = this.glow("rgba(255,250,235,1)");
    for (const s of c.cfg.type === "bike" ? [0] : [-0.6, 0.6]) this.sprite(head, [rear + model.len + 0.05, 0.65, z + s], 0.9, 0.7, true);
  }
}
