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

/** A rectangular cross-section across the car at `x`: y0..y1 tall, ±hw wide. */
const sec = (x: number, y0: number, y1: number, hw: number): V[] => [[x, y0, -hw], [x, y0, hw], [x, y1, hw], [x, y1, -hw]];

/** A solid lofted between two quads (corresponding corners in the same order): nose cones, pods, limbs. */
function loft(a: V[], b: V[], color: [number, number, number], flat = false): Solid {
  const faces: V[][] = [a, b];
  for (let i = 0; i < 4; i++) faces.push([a[i], a[(i + 1) % 4], b[(i + 1) % 4], b[i]]);
  const center = [...a, ...b].reduce<V>((s, v) => [s[0] + v[0] / 8, s[1] + v[1] / 8, s[2] + v[2] / 8], [0, 0, 0]);
  return { faces, color, flat, center };
}

/** Per-silhouette paint details. */
const LIVERY: Record<string, { stripes?: boolean; darkRoof?: boolean; roundel?: boolean }> = {
  muscle: { stripes: true },
  supercar: { darkRoof: true },
  rally: { roundel: true, darkRoof: true },
  gtcar: { roundel: true, stripes: true },
  sport: { darkRoof: true },
};

type XY = [number, number];

/** Where a horizontal line at `y` first meets the polygon from the rear (smallest x), if it does. */
function rearXAt(poly: XY[], y: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    if ((ay - y) * (by - y) > 0 || ay === by) continue;
    const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
    if (best === null || x < best) best = x;
  }
  return best;
}

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
  /** Tyre smoke billows big and pale; exhaust smoke is a small dark wisp. */
  kind: "tyre" | "exhaust";
  rot: number;
  spin: number;
  tex: number;
}

/** Where the exhaust tips are, in car space (x from the rear). */
function exhaustTips(cfg: VehicleConfig): V[] {
  const kind = cfg.ui.silhouette;
  if (kind === "formula") return [[0.25, 0.58, 0]];
  if (cfg.type === "bike") return [[0.42, kind === "cruiser" ? 0.36 : 0.64, 0.22]];
  return [[-0.02, 0.22, -0.42], [-0.02, 0.22, 0.42]];
}
interface Item {
  depth: number;
  draw: () => void;
}

/** The proving ground's timing lines: where the current run started, and its split distances. */
export interface ProvingInfo {
  startX: number | null;
  gates: { m: number; label: string }[];
}

/** A frame for either layout: the strip always has an opponent, the proving ground never does. */
export type FrameIn = Omit<SceneFrame, "opp"> & { opp: SceneCar | null; proving?: ProvingInfo };

export class DragScene25D {
  private readonly glows = new Map<string, Canvas>();
  private readonly boards = new Map<string, Canvas>();
  private timing: { canvas: Canvas; ctx: CanvasRenderingContext2D; key: string } | null = null;
  private crowd: Canvas | null = null;
  private readonly ads = new Map<string, Canvas>();
  private readonly roundels = new Map<string, Canvas>();
  private puffs: Puff[] = [];
  private readonly smokeTexes: Canvas[] = [];
  private lastTime = 0;
  private prevSpeed = { me: 0, opp: 0 };
  private braking = { me: 0, opp: 0 };
  private pitch = { me: 0, opp: 0 };
  /** Wheel angle last frame per lane, and how far the wheels turned this frame (rad). */
  private prevSpin = { me: 0, opp: 0 };
  private dSpin = 0;
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

  /**
   * "strip": the drag strip with its stands, tree and finish gantry.
   * "proving": an endless drag strip for one car, with timing lines from wherever it launched.
   */
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly layout: "strip" | "proving" = "strip",
  ) {}

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

  /** A race number on a white disc. */
  private roundel(num: string) {
    let r = this.roundels.get(num);
    if (!r) {
      const [c, x] = makeCanvas(96, 96);
      x.fillStyle = "#f4f4f5";
      x.beginPath();
      x.arc(48, 48, 46, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#111";
      x.font = "800 52px system-ui, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(num, 48, 52);
      this.roundels.set(num, (r = c));
    }
    return r;
  }

  /** A soft, billowy smoke puff (a few overlapping blobs), white or dark, three variants each. */
  private smokeTex(i: number) {
    if (!this.smokeTexes.length) {
      let seed = 5;
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (const tone of ["232,232,238", "70,70,78"]) {
        for (let v = 0; v < 3; v++) {
          const [c, x] = makeCanvas(128, 128);
          for (let b = 0; b < 9; b++) {
            const a = rand() * Math.PI * 2;
            const d = rand() * 26;
            const r = 22 + rand() * 24;
            const cx = 64 + Math.cos(a) * d;
            const cy = 64 + Math.sin(a) * d;
            const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
            g.addColorStop(0, `rgba(${tone},0.42)`);
            g.addColorStop(0.6, `rgba(${tone},0.2)`);
            g.addColorStop(1, `rgba(${tone},0)`);
            x.fillStyle = g;
            x.fillRect(0, 0, 128, 128);
          }
          this.smokeTexes.push(c);
        }
      }
    }
    return this.smokeTexes[i];
  }

  private puff(p: Puff) {
    const t = p.life / p.max;
    const alpha = (p.kind === "tyre" ? 0.75 : 0.6) * Math.min(1, p.life / 0.12) * Math.pow(1 - t, 1.5);
    if (alpha < 0.01) return;
    const [x, y] = this.p([p.x, p.y, p.z]);
    const size = p.r * 2 * this.k;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(p.rot);
    ctx.drawImage(this.smokeTex((p.kind === "tyre" ? 0 : 3) + p.tex), -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  /**
   * A flame jetting back out of an exhaust tip: an orange outer flame, a yellow body and a
   * blue-white core, each a flickering teardrop, drawn additively, with a warm glow around it.
   */
  private flameJet(tip: V, flame: number, scale = 1) {
    const ctx = this.ctx;
    const flicker = 0.75 + Math.random() * 0.45;
    const len = (0.3 + 1.0 * flame) * scale * flicker;
    const [bx, by] = this.p(tip);
    const [ex, ey] = this.p([tip[0] - len, tip[1] + 0.06 * len, tip[2] + (Math.random() - 0.5) * 0.08]);
    const dx = ex - bx;
    const dy = ey - by;
    const dl = Math.hypot(dx, dy) || 1;
    const nx = -dy / dl;
    const ny = dx / dl;
    const w0 = 0.09 * this.k * scale * (0.6 + 0.6 * flame);
    const layer = (reach: number, width: number, inner: string, outer: string) => {
      const tx = bx + dx * reach;
      const ty = by + dy * reach;
      const mx = bx + dx * reach * 0.35;
      const my = by + dy * reach * 0.35;
      const w = w0 * width;
      const g = ctx.createLinearGradient(bx, by, tx, ty);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(bx + nx * w * 0.6, by + ny * w * 0.6);
      ctx.quadraticCurveTo(mx + nx * w * 1.5, my + ny * w * 1.5, tx, ty);
      ctx.quadraticCurveTo(mx - nx * w * 1.5, my - ny * w * 1.5, bx - nx * w * 0.6, by - ny * w * 0.6);
      ctx.closePath();
      ctx.fill();
    };
    ctx.globalCompositeOperation = "lighter";
    layer(1, 1.15, "rgba(255,120,30,0.85)", "rgba(200,40,10,0)");
    layer(0.7, 0.75, "rgba(255,214,110,0.95)", "rgba(255,140,40,0)");
    layer(0.32, 0.45, "rgba(190,215,255,1)", "rgba(120,160,255,0)");
    ctx.globalCompositeOperation = "source-over";
    this.sprite(this.glow("rgba(255,150,60,1)"), [tip[0] - len * 0.3, tip[1], tip[2]], (0.8 + 1.6 * flame) * scale, 0.5 * Math.min(1, flame * 1.3), true);
  }

  /**
   * A multi-spoke alloy on the near face of a wheel: bright lip, dark barrel, spokes and a
   * coloured centre cap. The spokes are drawn several times across the angle the wheel turned
   * this frame (a camera shutter), so they visibly turn when slow and smear into a spinning
   * disc when fast, instead of strobing.
   */
  private rim(xf: (v: V) => V, cx: number, cy: number, z: number, r: number, spin: number, accent: [number, number, number], spokes = 7) {
    const at = (rr: number, a: number) => xf([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z]);
    const disc = (rr: number, fill: string) => this.poly(Array.from({ length: 20 }, (_, i) => at(rr, (i / 20) * Math.PI * 2)), fill);
    disc(r * 0.76, "rgb(190,190,200)");
    disc(r * 0.69, "rgb(26,26,31)");
    const spacing = (Math.PI * 2) / spokes;
    const turn = Math.min(Math.abs(this.dSpin), spacing * 2) * Math.sign(this.dSpin);
    if (Math.abs(turn) > spacing * 0.85) {
      // too fast to follow: a blurred disc with a faint hint of spokes
      disc(r * 0.68, "rgba(160,160,172,0.55)");
    }
    const ghosts = Math.max(1, Math.min(8, Math.ceil(Math.abs(turn) / 0.05)));
    const alpha = Math.abs(turn) > spacing * 0.85 ? 0.12 : Math.min(1, 1.6 / ghosts);
    for (let g = 0; g < ghosts; g++) {
      const base = spin - (turn * g) / ghosts;
      for (let i = 0; i < spokes; i++) {
        const a = base + i * spacing;
        this.poly([at(r * 0.17, a - 0.2), at(r * 0.68, a - 0.075), at(r * 0.68, a + 0.075), at(r * 0.17, a + 0.2)], `rgba(206,206,216,${alpha})`);
      }
    }
    disc(r * 0.19, rgbStr(accent, 0.95));
    disc(r * 0.07, "rgb(20,20,24)");
  }

  /** Draws solids back to front (by centre depth): for models built from separate parts. */
  private assembly(parts: Solid[], xf: (v: V) => V) {
    parts
      .map((s) => ({ s, d: this.depth(xf(s.center)) }))
      .sort((a, b) => b.d - a.d)
      .forEach(({ s }) => this.solid(s, xf));
  }

  /**
   * A modern single-seater, built part by part rather than from the side profile: nose cone,
   * front and rear wings, tub, sidepods, airbox, halo, driver, suspension and exposed wheels.
   */
  private formulaCar(c: SceneCar, lane: "me" | "opp", body: (v: V) => V, flat: (v: V) => V, acc: [number, number, number], spin: number, time: number) {
    const dark: [number, number, number] = [22, 22, 27];
    const carbon: [number, number, number] = [34, 34, 40];
    const tyre: [number, number, number] = [16, 16, 19];
    const white: [number, number, number] = [228, 228, 232];
    const accDark = acc.map((v) => v * 0.7) as [number, number, number];
    const FW = { x: 4.12, r: 0.3, z: [0.6, 0.9] as const };
    const RW = { x: 0.78, r: 0.34, z: [0.58, 0.96] as const };
    const parts: Solid[] = [
      // nose cone and tub
      loft(sec(4.75, 0.2, 0.3, 0.07), sec(3.5, 0.18, 0.52, 0.3), acc),
      loft(sec(3.5, 0.15, 0.52, 0.3), sec(2.0, 0.12, 0.6, 0.38), acc),
      // front wing: main plane, flap, endplates
      box(4.45, 4.9, 0.07, 0.12, -1.0, 1.0, carbon),
      box(4.4, 4.6, 0.12, 0.2, -0.98, 0.98, accDark),
      box(4.4, 4.92, 0.06, 0.32, 0.96, 1.0, carbon),
      box(4.4, 4.92, 0.06, 0.32, -1.0, -0.96, carbon),
      // sidepods, tapering towards the rear
      loft(sec(2.75, 0.12, 0.5, 0.72), sec(1.15, 0.12, 0.34, 0.5), acc),
      // engine cover and airbox rising behind the driver
      loft(sec(2.25, 0.5, 0.98, 0.2), sec(0.75, 0.3, 0.55, 0.14), accDark),
      box(2.12, 2.3, 0.86, 1.04, -0.12, 0.12, dark),
      // floor and diffuser
      box(0.35, 3.6, 0.04, 0.12, -0.82, 0.82, carbon),
      loft(sec(0.75, 0.06, 0.16, 0.5), sec(0.1, 0.06, 0.34, 0.5), carbon),
      // rear wing on a central pillar
      box(0.04, 0.5, 0.86, 0.98, -0.52, 0.52, carbon),
      box(0.12, 0.42, 1.02, 1.09, -0.52, 0.52, accDark),
      box(0.0, 0.55, 0.42, 1.12, 0.52, 0.56, acc),
      box(0.0, 0.55, 0.42, 1.12, -0.56, -0.52, acc),
      box(0.25, 0.33, 0.3, 0.88, -0.03, 0.03, dark),
      // driver: helmet in the cockpit, halo over it
      box(2.42, 2.72, 0.6, 0.86, -0.14, 0.14, white),
      box(2.62, 2.73, 0.66, 0.76, -0.12, 0.12, [18, 22, 30], true),
      box(2.45, 2.95, 0.88, 0.92, 0.2, 0.24, dark),
      box(2.45, 2.95, 0.88, 0.92, -0.24, -0.2, dark),
      box(2.92, 2.98, 0.55, 0.92, -0.03, 0.03, dark),
      box(2.4, 2.48, 0.86, 0.92, -0.24, 0.24, dark),
      // wishbones out to the wheels
      box(FW.x - 0.25, FW.x + 0.05, 0.3, 0.33, 0.28, FW.z[0], dark),
      box(FW.x - 0.25, FW.x + 0.05, 0.3, 0.33, -FW.z[0], -0.28, dark),
      box(RW.x - 0.2, RW.x + 0.15, 0.32, 0.35, 0.3, RW.z[0], dark),
      box(RW.x - 0.2, RW.x + 0.15, 0.32, 0.35, -RW.z[0], -0.3, dark),
    ];
    const wheels: Solid[] = [];
    for (const w of [FW, RW]) {
      wheels.push(wheel(w.x, w.r, w.r, -w.z[1], -w.z[0], spin * (0.33 / w.r), tyre));
      wheels.push(wheel(w.x, w.r, w.r, w.z[0], w.z[1], spin * (0.33 / w.r), tyre));
    }
    // far wheels, then the car, then near wheels with their rims
    this.assembly(wheels.filter((s) => s.center[2] < 0), flat);
    this.assembly(parts, body);
    this.assembly(wheels.filter((s) => s.center[2] > 0), flat);
    for (const w of [FW, RW]) this.rim(flat, w.x, w.r, w.z[1] + 0.004, w.r, spin * (0.33 / w.r), acc, 6);
    // rain light blinking on the crash structure, flames from the single exhaust
    const blink = Math.sin(time * 18) > 0 ? 1 : 0.35;
    this.sprite(this.glow("rgba(255,40,30,1)"), body([0.05, 0.42, 0]), 0.9, 0.5 + 0.4 * blink * (0.5 + this.braking[lane]), true);
    if (c.flame > 0.02) this.flameJet(body([0.2, 0.58, 0]), c.flame, 0.8);
  }

  /**
   * A motorbike and its rider, built part by part: thin wheels with bright rims (black discs
   * vanish on the asphalt), forks, swingarm, engine, exhaust, tank, seat, tail and, on a sports
   * bike, a full fairing with the rider tucked in behind the screen.
   */
  private bike(c: SceneCar, lane: "me" | "opp", body: (v: V) => V, flat: (v: V) => V, acc: [number, number, number], spin: number) {
    const sport = c.cfg.ui.silhouette !== "cruiser";
    const accDark = acc.map((v) => v * 0.6) as [number, number, number];
    const metal: [number, number, number] = [120, 120, 130];
    const engine: [number, number, number] = [44, 44, 52];
    const leathers: [number, number, number] = [30, 30, 36];
    const R = 0.31;
    const RX = 0.32;
    const FX = sport ? 1.86 : 1.95;
    // a limb or tube between two points, `t` thick
    const rod = (a: V, b: V, t: number, color: [number, number, number]) => loft(sec(a[0], a[1] - t, a[1] + t, t).map(([x, y, z]): V => [x, y, z + a[2]]), sec(b[0], b[1] - t, b[1] + t, t).map(([x, y, z]): V => [x, y, z + b[2]]), color);
    const parts: Solid[] = [
      // swingarm, engine, exhaust
      rod([RX, R, 0.1], [0.95, 0.42, 0.1], 0.04, metal),
      rod([RX, R, -0.1], [0.95, 0.42, -0.1], 0.04, metal),
      box(0.82, 1.38, 0.22, 0.62, -0.17, 0.17, engine),
      rod([1.25, 0.26, 0.2], [0.5, sport ? 0.62 : 0.34, 0.22], 0.06, [150, 150, 160]),
      // forks up to the bars
      rod([FX, R, 0.1], [FX - 0.24, sport ? 0.98 : 1.05, 0.1], 0.035, [190, 170, 120]),
      rod([FX, R, -0.1], [FX - 0.24, sport ? 0.98 : 1.05, -0.1], 0.035, [190, 170, 120]),
      // tank, seat and tail
      loft(sec(1.32, 0.78, 1.02, 0.17), sec(0.95, 0.8, 0.94, 0.15), acc),
      box(0.55, 0.98, sport ? 0.86 : 0.74, sport ? 0.93 : 0.8, -0.14, 0.14, [20, 20, 24]),
      sport ? loft(sec(0.95, 0.78, 0.9, 0.14), sec(0.22, 0.96, 1.04, 0.05), acc) : box(0.25, 0.6, 0.6, 0.7, -0.15, 0.15, acc),
      // front mudguard
      box(FX - 0.25, FX + 0.12, R + 0.06, R + 0.1, -0.08, 0.08, sport ? accDark : acc),
    ];
    if (sport) {
      parts.push(
        // fairing: nose with the headlight, flanks over the engine, and a dark screen
        loft(sec(1.95, 0.62, 0.92, 0.07), sec(1.45, 0.4, 1.06, 0.21), acc),
        loft(sec(1.45, 0.34, 0.78, 0.21), sec(1.0, 0.32, 0.62, 0.19), accDark),
        box(1.5, 1.68, 1.02, 1.16, -0.12, 0.12, [24, 30, 42], true),
      );
    } else {
      parts.push(box(FX - 0.32, FX - 0.2, 0.88, 1.0, -0.12, 0.12, [220, 220, 210], true)); // round lamp
      parts.push(rod([FX - 0.3, 1.05, -0.38], [FX - 0.3, 1.05, 0.38], 0.025, [190, 190, 200])); // wide bars
    }
    // the rider: sports bike tucked flat on the tank, cruiser upright with feet forward
    const hip: V = sport ? [0.78, 1.0, 0] : [0.55, 0.88, 0];
    const sh: V = sport ? [1.3, 1.2, 0] : [0.68, 1.42, 0];
    const bars: V = sport ? [1.6, 0.98, 0] : [FX - 0.32, 1.08, 0];
    const knee = sport ? 1.12 : 1.1;
    const peg: V = sport ? [0.88, 0.48, 0] : [1.35, 0.42, 0];
    parts.push(loft(sec(hip[0], hip[1] - 0.1, hip[1] + 0.12, 0.17), sec(sh[0], sh[1] - 0.11, sh[1] + 0.09, 0.2), accDark));
    for (const side of [1, -1]) {
      const z = 0.19 * side;
      parts.push(rod([sh[0] - 0.02, sh[1], z], [bars[0], bars[1], z * 1.1], 0.05, leathers));
      parts.push(rod([hip[0] + 0.05, hip[1], z * 0.9], [knee, sport ? 0.8 : 0.7, z * 1.25], 0.07, leathers));
      parts.push(rod([knee, sport ? 0.8 : 0.7, z * 1.25], [peg[0], peg[1], z * 1.05], 0.06, leathers));
    }
    // round helmet (a short cylinder seen side-on) with a dark visor
    const hx = sh[0] + (sport ? 0.12 : 0.06);
    const hy = sh[1] + (sport ? 0.12 : 0.2);
    parts.push(wheel(hx, hy, 0.15, -0.13, 0.13, 0, [226, 226, 232]));
    parts.push(box(hx + 0.04, hx + 0.16, hy - 0.06, hy + 0.04, -0.1, 0.1, [16, 20, 30], true));
    const wheels = [wheel(RX, R, R, -0.07, 0.07, spin * (0.33 / R), [16, 16, 19]), wheel(FX, R, R, -0.06, 0.06, spin * (0.33 / R), [16, 16, 19])];
    this.assembly([...wheels, ...parts], body);
    // rims and brake discs on the near side, so the wheels read against the track
    for (const wx of [RX, FX]) this.rim(flat, wx, R, 0.075, R, spin * (0.33 / R), acc, 5);
    // lamps and flames
    const brake = this.braking[lane];
    this.sprite(this.glow("rgba(255,40,30,1)"), body([0.22, 0.98, 0]), 0.6 + 0.8 * brake, 0.55 + 0.45 * brake, true);
    this.sprite(this.glow("rgba(255,250,235,1)"), body([sport ? 1.96 : FX - 0.2, sport ? 0.8 : 0.94, 0]), 0.9, 0.75, true);
    if (c.flame > 0.02) this.flameJet(body([0.4, sport ? 0.64 : 0.36, 0.22]), c.flame, 0.7);
  }

  /** A sponsor board for the far wall: dark, one accent bar, plain lettering. */
  private ad(label: string, accent: string) {
    let a = this.ads.get(label);
    if (!a) {
      const [c, x] = makeCanvas(1024, 40);
      x.fillStyle = "#16151c";
      x.fillRect(0, 0, 1024, 40);
      x.fillStyle = accent;
      x.fillRect(0, 0, 10, 40);
      x.fillRect(1014, 0, 10, 40);
      x.fillStyle = "#8b8a96";
      x.font = "600 24px system-ui, sans-serif";
      x.textBaseline = "middle";
      for (let i = 0; i < 3; i++) x.fillText(label, 40 + i * 340, 21);
      this.ads.set(label, (a = c));
    }
    return a;
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
      x.fillStyle = "#121118";
      x.fillRect(0, 0, 512, 40);
      x.fillStyle = "#1a1922";
      x.fillRect(0, 30, 512, 10); // the seat row
      x.filter = "blur(0.8px)";
      let seed = 11;
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let px = 6; px < 506; px += 9 + rand() * 14) {
        if (rand() < 0.3) continue; // empty seats
        const hue = Math.floor(rand() * 360);
        x.fillStyle = `hsl(${hue},12%,${22 + rand() * 9}%)`;
        x.beginPath();
        x.ellipse(px, 26, 6, 8, 0, 0, Math.PI * 2); // shoulders
        x.fill();
        x.fillStyle = `hsl(${20 + rand() * 20},16%,${22 + rand() * 12}%)`;
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
  private poly(pts: V[], fill: string | CanvasGradient, seal = false) {
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

  draw(f: FrameIn, w: number, h: number) {
    const ctx = this.ctx;
    const dt = Math.min(0.05, Math.max(0, f.time - this.lastTime));
    this.lastTime = f.time;
    const me = f.me;
    const portrait = h > w;

    // follow your car (it sits a little below and left of centre so you see the strip ahead)
    const myX = me.distM - me.rollBackM;
    const proving = this.layout === "proving";
    const launched = proving || me.distM > 0.05;
    // The camera is locked to the car; only the framing offset eases. (Chasing the car with a
    // lag made the gap between them wobble with every uneven frame: that was the jitter.)
    // (the proving ground keeps the car nearer the middle: on a phone it would sit half off-screen)
    const leadTarget = proving ? (portrait ? -1.5 : 5) : launched ? (portrait ? 3 : 6) : 1 - myX;
    this.lead += (leadTarget - this.lead) * Math.min(1, dt * 2.5);
    this.camX = myX + this.lead;
    this.zoom += (1 - Math.min(0.25, me.speedKmh / 900) - this.zoom) * Math.min(1, dt * 2);
    this.k = (portrait ? w / 10.5 : Math.min(w / 26, h / 13)) * this.zoom;
    // shake as smooth noise (summed sines), not a fresh random offset every frame
    const sh = f.shake * f.shake;
    const t = f.time;
    this.cx = w / 2 + (Math.sin(t * 47) + Math.sin(t * 31.7) * 0.6) * 3 * sh;
    // (on the endless strip the gauges sit in the bottom corner, so the car rides a little higher)
    this.cy = h * (proving ? (portrait ? 0.44 : 0.47) : portrait ? 0.6 : 0.52) + (Math.sin(t * 39.3) + Math.sin(t * 57.1) * 0.5) * 2.2 * sh;
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
    if (proving) this.provingGround(f.proving, G, x0, x1);
    else {
      // concrete launch pad for the first 100 m, as at real strips, then asphalt
      const PAD = 100;
      if (x1 > PAD) G(Math.max(x0, PAD), x1, -WALL_Z, WALL_Z, "#16151b");
      if (x0 < PAD) {
        G(Math.max(x0, -12), Math.min(PAD, x1), -WALL_Z, WALL_Z, "#222128");
        for (let k = Math.ceil(Math.max(x0, -12) / 5); k * 5 < Math.min(PAD, x1); k++) G(k * 5 - 0.03, k * 5 + 0.03, -WALL_Z, WALL_Z, "#19181e");
      }
      // laid rubber: the two tyre tracks in each lane, heavy off the line and fading out
      for (const lz of [LANE_Z.me, LANE_Z.opp]) {
        for (let k = 0; k < 16; k++) {
          const xa = k * 8 - 2;
          if (xa + 8 < x0 || xa > x1) continue;
          const a = 0.55 * Math.pow(1 - k / 16, 1.6);
          for (const tz of [-0.78, 0.78]) G(xa, xa + 8, lz + tz - 0.24, lz + tz + 0.24, `rgba(4,4,6,${a})`);
          G(xa, xa + 8, lz - 0.55, lz + 0.55, `rgba(4,4,6,${a * 0.3})`);
        }
      }
      G(x0, x1, -0.06, 0.06, "#b08a24");
      G(x0, x1, LINE_Z - 0.05, LINE_Z + 0.05, "#a9a9b3");
      G(x0, x1, -LINE_Z - 0.05, -LINE_Z + 0.05, "#a9a9b3");
      G(-0.15, 0.15, -WALL_Z, WALL_Z, "#f4f4f5");
      for (let k = 0; k < 14; k++) {
        const za = -WALL_Z + (k * 2 * WALL_Z) / 14;
        const zb = za + (2 * WALL_Z) / 14;
        G(QUARTER_MILE_M - 0.5, QUARTER_MILE_M, za, zb, k % 2 ? "#f4f4f5" : "#0b0b0f");
        G(QUARTER_MILE_M, QUARTER_MILE_M + 0.5, za, zb, k % 2 ? "#0b0b0f" : "#f4f4f5");
      }
    }
    // warm pools of light from the towers
    const pool = this.glow("rgba(255,226,180,1)");
    for (let k = Math.floor((x0 - 10) / 34); k <= Math.ceil(x1 / 34); k++) this.sprite(pool, [k * 34 + 10, 0, -1.5], 22, 0.11, true);

    // ---- everything with height, sorted back to front ----
    const items: Item[] = [];
    const add = (center: V, draw: () => void) => items.push({ depth: this.depth(center), draw });
    const id = (v: V) => v;
    const wallC: [number, number, number] = [58, 57, 64];
    const ADS: [string, string][] = proving
      ? [["REVHEADZ", "#f97316"], ["TEST AND TUNE", "#a3a3ad"], ["0–100  ·  1/4 MILE  ·  1 KM", "#65a30d"]]
      : [["REVHEADZ", "#f97316"], ["QUARTER MILE", "#a3a3ad"], ["STAGE  ·  LAUNCH  ·  SHIFT", "#65a30d"]];
    for (let k = Math.floor(x0 / 12); k < Math.ceil(x1 / 12); k++) {
      const xa = k * 12;
      const xb = xa + 12;
      // far wall with sponsor boards on its inner face, a catch fence on top
      add([xa + 6, 0.5, -WALL_Z], () => {
        this.solid(box(xa, xb, 0, 1.1, -WALL_Z - 0.35, -WALL_Z, wallC), id);
        if (k % 2 === 0) {
          const [label, accent] = ADS[((Math.floor(xa / 24) % 3) + 3) % 3];
          this.image(this.ad(label, accent), 1024, 40, [xa + 0.4, 0.95, -WALL_Z + 0.01], [xa + 23.6, 0.95, -WALL_Z + 0.01], [xa + 0.4, 0.2, -WALL_Z + 0.01]);
        }
        this.poly([[xa, 1.1, -WALL_Z - 0.18], [xb, 1.1, -WALL_Z - 0.18], [xb, 3, -WALL_Z - 0.18], [xa, 3, -WALL_Z - 0.18]], "rgba(150,150,170,0.07)");
        for (let px = xa; px < xb; px += 3) this.solid(box(px - 0.03, px + 0.03, 1.1, 3, -WALL_Z - 0.21, -WALL_Z - 0.15, [44, 43, 52]), id);
        this.solid(box(xa, xb, 2.96, 3.02, -WALL_Z - 0.21, -WALL_Z - 0.15, [44, 43, 52]), id);
      });
      // near wall (low, in front of everything else)
      add([xa + 6, 0.5, WALL_Z], () => this.solid(box(xa, xb, 0, 0.9, WALL_Z, WALL_Z + 0.35, wallC), id));
      // grandstand tiers behind the far wall, crowd on the front faces
      for (let t = 0; t < 4; t++) {
        const z1 = -8.6 - t * 2.2;
        const y1 = 1.2 + t * 0.9;
        add([xa + 6, y1 / 2, z1 - 1.1], () => {
          this.solid(box(xa, xb, 0, y1, z1 - 2.2, z1, t % 2 ? [19, 18, 25] : [23, 22, 30]), id);
          this.image(this.crowdTex(), 512, 40, [xa, y1 + 0.05, z1 + 0.01], [xb, y1 + 0.05, z1 + 0.01], [xa, y1 - 0.85, z1 + 0.01]);
        });
      }
    }
    // distance boards on the far wall
    for (const [m, label] of proving ? [] :  [[SIXTY_FT_M, "60 FT"], [100.584, "330 FT"], [EIGHTH_MILE_M, "1/8 MILE"], [304.8, "1000 FT"]] as [number, string][]) {
      if (m < x0 || m > x1) continue;
      add([m, 2, -WALL_Z - 0.2], () => {
        this.solid(box(m - 0.06, m + 0.06, 1.1, 1.6, -WALL_Z - 0.25, -WALL_Z - 0.15, [40, 40, 48]), id);
        this.image(this.board(label), 256, 96, [m - 1.3, 2.6, -WALL_Z - 0.1], [m + 1.3, 2.6, -WALL_Z - 0.1], [m - 1.3, 1.6, -WALL_Z - 0.1]);
      });
    }
    // a sign at each timing line
    if (proving && f.proving?.startX !== null && f.proving) {
      for (const g of f.proving.gates) {
        const m = f.proving.startX! + g.m;
        if (m < x0 - 3 || m > x1 + 3) continue;
        add([m, 2, -WALL_Z - 0.2], () => {
          this.solid(box(m - 0.06, m + 0.06, 1.1, 1.6, -WALL_Z - 0.25, -WALL_Z - 0.15, [40, 40, 48]), id);
          this.image(this.board(g.label), 256, 96, [m - 1.3, 2.6, -WALL_Z - 0.1], [m + 1.3, 2.6, -WALL_Z - 0.1], [m - 1.3, 1.6, -WALL_Z - 0.1]);
        });
      }
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
    if (!proving && f.opp && QUARTER_MILE_M > x0 - 10 && QUARTER_MILE_M < x1 + 10) {
      const opp = f.opp;
      const gx = QUARTER_MILE_M + 6;
      add([gx, 3, -WALL_Z - 1], () => {
        this.solid(box(gx - 0.2, gx + 0.2, 0, 3.6, -WALL_Z - 1.2, -WALL_Z - 0.8, [40, 39, 48]), id);
        this.solid(box(gx - 3.4, gx + 3.4, 3.6, 6.4, -WALL_Z - 1.2, -WALL_Z - 0.9, [10, 10, 14]), id);
        this.image(this.timingBoard(f.me, opp), 512, 200, [gx - 3.3, 6.3, -WALL_Z - 0.89], [gx + 3.3, 6.3, -WALL_Z - 0.89], [gx - 3.3, 3.7, -WALL_Z - 0.89]);
      });
    }
    // the tree, on the centre line just past the start, lights facing the cars
    if (!proving && f.opp) {
      const strip = f as SceneFrame;
      add([5, 2, 0], () => this.tree(strip));
    }

    // cars and their smoke
    for (const lane of f.opp ? (["opp", "me"] as const) : (["me"] as const)) {
      const c = lane === "me" ? f.me : f.opp!;
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
      const spawn = (kind: Puff["kind"], x: number, y: number, pz: number, r: number, max: number, vx: number, vz: number) =>
        this.puffs.push({ kind, x, y, z: pz, r, life: 0, max, vx, vz, rot: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 1.2, tex: Math.floor(Math.random() * 3) });
      // tyre smoke off the line, heaviest in the first few metres
      const run = proving ? (f.proving?.startX !== null && f.proving ? c.distM - f.proving.startX! : 99) : c.distM;
      if (run > 0.05 && run < 24 && c.speedKmh > 1) {
        const n = Math.random() < 1 - run / 24 ? 2 : 1;
        const wheelZ = c.cfg.type === "bike" ? [0] : [-0.8, 0.8];
        for (let i = 0; i < n; i++) {
          spawn("tyre", rear + 0.4, 0.25, z + wheelZ[Math.floor(Math.random() * wheelZ.length)], 0.4, 1.4 + Math.random() * 1.2, -2 - Math.random() * 2.5, (Math.random() - 0.5) * 1.6);
        }
      }
      // a dark wisp after every pop or flame
      if (c.flame > 0.3 && Math.random() < c.flame * 0.6) {
        for (const [tx, ty, tz] of exhaustTips(c.cfg)) spawn("exhaust", rear + tx - 0.2, ty, z + tz, 0.14, 0.7 + Math.random() * 0.5, -1 - Math.random(), (Math.random() - 0.5) * 0.5);
      }
      add([rear + len / 2, 0.6, z], () => this.car(c, lane, rear, f.time));
    }
    for (const p of this.puffs) {
      add([p.x, p.y, p.z], () => this.puff(p));
      const t = p.life / p.max;
      p.life += dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - Math.min(1, dt * 1.1); // the air slows it down
      p.y += (p.kind === "tyre" ? 0.55 : 0.4) * dt;
      p.r += (p.kind === "tyre" ? 1.9 : 0.9) * (1 - 0.6 * t) * dt; // grows fast, then slows as it spreads
      p.rot += p.spin * dt;
    }
    this.puffs = this.puffs.filter((p) => p.life < p.max).slice(-240);

    items.sort((a, b) => b.depth - a.depth);
    for (const it of items) it.draw();

    // vignette: pulls the eye to the cars and hides the hard edge of the world
    const vg = ctx.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.35, w / 2, h * 0.55, Math.max(w, h) * 0.75);
    vg.addColorStop(0, "rgba(4,4,8,0)");
    vg.addColorStop(1, "rgba(4,4,8,0.6)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

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

  /**
   * The endless strip: two lanes of asphalt with no finish line. The run's start line and the
   * rubber it lays down go wherever you launched; its timing lines follow on from there.
   */
  private provingGround(info: ProvingInfo | undefined, G: (xa: number, xb: number, za: number, zb: number, fill: string) => void, x0: number, x1: number) {
    G(x0, x1, -WALL_Z, WALL_Z, "#16151b");
    for (let k = Math.ceil(x0 / 100); k * 100 < x1; k++) G(k * 100 - 0.04, k * 100 + 0.04, -WALL_Z, WALL_Z, "#121116");
    const s = info?.startX ?? null;
    if (s !== null) {
      for (let k = 0; k < 16; k++) {
        const xa = s + k * 8 - 2;
        if (xa + 8 < x0 || xa > x1) continue;
        const a = 0.55 * Math.pow(1 - k / 16, 1.6);
        for (const tz of [-0.78, 0.78]) G(xa, xa + 8, LANE_Z.me + tz - 0.24, LANE_Z.me + tz + 0.24, `rgba(4,4,6,${a})`);
        G(xa, xa + 8, LANE_Z.me - 0.55, LANE_Z.me + 0.55, `rgba(4,4,6,${a * 0.3})`);
      }
    }
    G(x0, x1, -0.06, 0.06, "#b08a24");
    G(x0, x1, LINE_Z - 0.05, LINE_Z + 0.05, "#a9a9b3");
    G(x0, x1, -LINE_Z - 0.05, -LINE_Z + 0.05, "#a9a9b3");
    if (s === null || !info) return;
    if (s > x0 - 1 && s < x1 + 1) G(s - 0.15, s + 0.15, -WALL_Z, WALL_Z, "#f4f4f5");
    for (const g of info.gates) {
      const m = s + g.m;
      if (m < x0 - 1 || m > x1 + 1) continue;
      for (let k = 0; k < 14; k++) {
        const za = -WALL_Z + (k * 2 * WALL_Z) / 14;
        G(m - 0.18, m + 0.18, za, za + (2 * WALL_Z) / 14, k % 2 ? "rgba(244,244,245,0.8)" : "rgba(11,11,15,0.8)");
      }
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
    this.dSpin = Math.max(-3, Math.min(3, spin - this.prevSpin[lane]));
    this.prevSpin[lane] = spin;
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

    if (c.cfg.ui.silhouette === "formula") {
      this.formulaCar(c, lane, body, flat, acc, spin, time);
      return;
    }
    if (shape.bike) {
      this.bike(c, lane, body, flat, acc, spin);
      return;
    }

    const tyre: [number, number, number] = [14, 14, 17];
    const wheelSolids = (side: 1 | -1) =>
      shape.wheels.map((w) => wheel(w.x, w.r, w.r, side > 0 ? shape.wheelZ[0] : -shape.wheelZ[1], side > 0 ? shape.wheelZ[1] : -shape.wheelZ[0], spin, tyre));
    // far wheels first (behind the body)
    if (!shape.bike) for (const s of wheelSolids(-1)) this.solid(s, flat);
    else for (const s of wheelSolids(1)) this.solid(s, flat);

    // Half-width of the body at a point of the profile: the cabin leans in above the beltline
    // (tumblehome) and the corners round off in plan at the nose and tail.
    const shaped = !shape.bike;
    const cabinH = Math.max(0.01, shape.height - shape.belt);
    const hwAt = (x: number, y: number) => {
      let hw = W / 2;
      if (!shaped) return hw;
      if (y > shape.belt) hw -= ((y - shape.belt) / cabinH) * W * 0.17;
      const e = Math.min(x, shape.len - x) / (shape.len * 0.12);
      if (e < 1) hw *= 0.88 + 0.12 * Math.sqrt(Math.max(0, e));
      return hw;
    };
    const onSide = (poly: XY[], out = 0) => poly.map(([x, y]) => body([x, y, hwAt(x, y) + out]));

    // a profile extruded across the car: the edge strips (roof, bonnet, screens, tail) back to front
    const livery = LIVERY[c.cfg.ui.silhouette] ?? {};
    const prism = (poly: XY[], hw: (x: number, y: number) => number, base: [number, number, number], glassy: boolean, paint = false) => {
      const strips: { pts: V[]; n: V; glass: boolean; d: number; a: XY; b: XY }[] = [];
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        const ha = hw(ax, ay);
        const hb = hw(bx, by);
        const pts: V[] = [body([ax, ay, -ha]), body([bx, by, -hb]), body([bx, by, hb]), body([ax, ay, ha])];
        // outward normal of a counter-clockwise edge in the side plane
        const n = norm([by - ay, -(bx - ax), 0]);
        if (dot(n, VIEW) >= 0 || n[1] < -0.2) continue;
        const glass = glassy && ay > shape.belt + 0.02 && by > shape.belt + 0.02 && Math.abs(by - ay) > 0.35 * Math.abs(bx - ax);
        const mid: V = [(pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2, (pts[0][2] + pts[2][2]) / 2];
        strips.push({ pts, n, glass, d: this.depth(mid), a: [ax, ay], b: [bx, by] });
      }
      strips.sort((p, q) => q.d - p.d);
      for (const st of strips) {
        const roof = paint && livery.darkRoof && st.a[1] > shape.belt + 0.05 && st.b[1] > shape.belt + 0.05;
        this.poly(st.pts, st.glass ? rgbStr([30, 38, 54], 0.55 + 0.7 * Math.max(0, dot(st.n, LIGHT))) : shade(st.n, roof ? (base.map((v) => v * 0.42 + 10) as [number, number, number]) : base), true);
      }
      // twin stripes over the bonnet, roof and boot, after all the panels so none paints over them
      for (const st of strips) {
        if (paint && livery.stripes && !st.glass && st.n[1] > 0.3) {
          for (const [z0, z1] of [[0.1, 0.3], [-0.3, -0.1]]) {
            this.poly([body([st.a[0], st.a[1] + 0.002, z0]), body([st.b[0], st.b[1] + 0.002, z0]), body([st.b[0], st.b[1] + 0.002, z1]), body([st.a[0], st.a[1] + 0.002, z1])], shade(st.n, [236, 236, 240]));
          }
        }
      }
      // the near side face: lit from above, darker towards the sills
      const lower = shaped ? clipY(poly, shape.belt, false) : poly;
      if (lower.length >= 3) {
        const xs = poly.map((q) => q[0]);
        const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const [gx0, gy0] = this.p(body([mx, shape.belt, hw(mx, shape.belt)]));
        const [gx1, gy1] = this.p(body([mx, 0, hw(mx, 0)]));
        const g = this.ctx.createLinearGradient(gx0, gy0, gx1, gy1);
        const lit = 0.42 + 0.7 * Math.max(0, LIGHT[2]);
        g.addColorStop(0, rgbStr(base, lit * 1.18));
        g.addColorStop(1, rgbStr(base, lit * 0.62));
        this.poly(lower.map(([x, y]) => body([x, y, hw(x, y)])), g, true);
      }
      if (shaped) {
        const upper = clipY(poly, shape.belt, true);
        if (upper.length >= 3) this.poly(upper.map(([x, y]) => body([x, y, hw(x, y)])), shade(norm([0, (W * 0.17) / cabinH, 1]), base), true);
      }
    };
    for (const poly of shape.bodies) prism(poly, hwAt, acc, !shape.bike, shaped);

    // near-side details: shoulder crease, sills, window glass with a pillar, wheel arches
    for (const poly of shape.bodies) {
      if (shaped) {
        const crease = clipY(clipY(poly, shape.belt - 0.005, false), shape.belt - 0.06, true);
        if (crease.length >= 3) this.poly(onSide(crease, 0.004), rgbStr(acc, 1.45));
      }
      const sill = clipY(poly, shape.height * 0.16, false);
      if (sill.length >= 3) this.poly(onSide(sill, 0.004), rgbStr(acc, 0.28));
    }
    if (shape.windows.length) {
      const ctx = this.ctx;
      const win = onSide(shape.windows, 0.006);
      this.poly(win, "rgb(24,29,42)");
      // a soft reflection streak across the glass
      const xs = shape.windows.map((p) => p[0]);
      const wx0 = Math.min(...xs);
      const wx1 = Math.max(...xs);
      ctx.save();
      ctx.beginPath();
      win.forEach((v, i) => {
        const [px, py] = this.p(v);
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.clip();
      const sx = wx0 + (wx1 - wx0) * 0.55;
      const at = (x: number, y: number) => body([x, y, hwAt(x, y) + 0.007]);
      this.poly([at(sx, shape.belt), at(sx + 0.32, shape.belt), at(sx + 0.62, shape.height), at(sx + 0.3, shape.height)], "rgba(190,205,235,0.10)");
      this.poly([at(sx + 0.42, shape.belt), at(sx + 0.5, shape.belt), at(sx + 0.8, shape.height), at(sx + 0.72, shape.height)], "rgba(190,205,235,0.07)");
      ctx.restore();
      const pm = (wx0 + wx1) / 2;
      this.poly([at(pm - 0.05, shape.belt), at(pm + 0.05, shape.belt), at(pm + 0.05, shape.height), at(pm - 0.05, shape.height)], rgbStr(acc, 0.5));
    }
    if (shaped) {
      // lamps as shapes on the corners: headlight at the nose, taillight at the tail
      const ly = Math.min(shape.height * 0.5, 0.68);
      const lamp = (x0: number, x1: number, fill: string) =>
        this.poly([[x0, ly - 0.07], [x1, ly - 0.07], [x1, ly + 0.06], [x0, ly + 0.06]].map(([x, y]) => body([x, y, hwAt(x, y) + 0.006])), fill);
      lamp(shape.len - 0.42, shape.len - 0.08, "rgb(235,232,220)");
      lamp(0.06, 0.36, rgbStr([230, 30, 30], 0.75 + 0.5 * this.braking[lane]));
      for (const w of shape.wheels) {
        const arch: V[] = [];
        for (let i = 0; i <= 12; i++) {
          const a = (i / 12) * Math.PI;
          const x = w.x + Math.cos(a) * w.r * 1.18;
          const y = w.r + Math.sin(a) * w.r * 1.18;
          arch.push(body([x, y, hwAt(x, y) + 0.008]));
        }
        this.poly(arch, "rgb(8,8,11)");
      }
    }
    if (shaped) {
      const main = shape.bodies.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
      // the tail, which faces the camera: dark diffuser, taillights, exhaust tips
      const onRear = (y: number, z: number, out = 0.006): V | null => {
        const x = rearXAt(main, y);
        return x === null ? null : body([x - out, y, z]);
      };
      const rearQuad = (y0: number, y1: number, za: number, zb: number, fill: string) => {
        const q = [onRear(y0, za), onRear(y0, zb), onRear(y1, zb), onRear(y1, za)];
        if (q.every((v) => v !== null)) this.poly(q as V[], fill);
      };
      const tailHw = (y: number) => hwAt(rearXAt(main, y) ?? 0, y);
      rearQuad(0.1, 0.27, -tailHw(0.2) + 0.06, tailHw(0.2) - 0.06, "rgb(12,12,15)");
      const ly = Math.min(shape.height * 0.5, 0.68);
      const th = tailHw(ly);
      const red = rgbStr([235, 32, 28], 0.8 + 0.45 * this.braking[lane]);
      rearQuad(ly - 0.06, ly + 0.05, th - 0.48, th - 0.04, red);
      rearQuad(ly - 0.06, ly + 0.05, -th + 0.04, -th + 0.48, red);
      if (livery.darkRoof) rearQuad(ly - 0.015, ly + 0.01, -th + 0.48, th - 0.48, red);
      for (const ez of [-0.42, 0.42]) {
        const x = (rearXAt(main, 0.22) ?? 0) - 0.03;
        const ring = (r: number) => Array.from({ length: 10 }, (_, i): V => {
          const a = (i / 10) * Math.PI * 2;
          return body([x, 0.22 + Math.sin(a) * r, ez + Math.cos(a) * r]);
        });
        this.poly(ring(0.06), "rgb(120,120,130)");
        this.poly(ring(0.04), "rgb(6,6,8)");
      }
      // door mirror at the base of the screen
      if (shape.windows.length) {
        const mx = Math.max(...shape.windows.map((p) => p[0])) - 0.08;
        const mz = hwAt(mx, shape.belt + 0.08);
        this.solid(box(mx - 0.12, mx, shape.belt + 0.05, shape.belt + 0.16, mz - 0.02, mz + 0.15, acc), body);
      }
      // race number on the door
      if (livery.roundel && shape.wheels.length >= 2) {
        const xs = shape.wheels.map((w) => w.x);
        const xm = (Math.min(...xs) + Math.max(...xs)) / 2;
        const ym = shape.belt * 0.52;
        const zz = hwAt(xm, ym) + 0.008;
        const num = String((c.cfg.id.split("").reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7) % 98) + 1);
        this.image(this.roundel(num), 96, 96, body([xm - 0.24, ym + 0.24, zz]), body([xm + 0.24, ym + 0.24, zz]), body([xm - 0.24, ym - 0.24, zz]));
      }
    }
    // wings and spoilers, dark
    for (const poly of shape.wings) prism(poly, () => W / 2 - 0.14, [58, 58, 68], false);
    // rider on a bike
    // near wheels, with spokes turning at road speed
    if (!shape.bike) {
      for (const s of wheelSolids(1)) this.solid(s, flat);
      for (const w of shape.wheels) this.rim(flat, w.x, w.r, shape.wheelZ[1] + 0.004, w.r, spin, acc);
      // flared fenders: a lip in body colour standing out from the arch over the top of each tyre
      for (const w of shape.wheels) {
        const N = 14;
        const ro = w.r * 1.36;
        const ri = w.r * 1.14;
        const out = 0.1;
        const base = (a: number): V => {
          const x = w.x + Math.cos(a) * ro;
          const y = w.r + Math.sin(a) * ro;
          return body([x, y, hwAt(x, y)]);
        };
        const lip = (a: number, rr: number): V => {
          const x = w.x + Math.cos(a) * rr;
          const y = w.r + Math.sin(a) * rr;
          return body([x, y, hwAt(w.x, w.r + ro) + out]);
        };
        const angles = Array.from({ length: N + 1 }, (_, k) => -0.12 + ((Math.PI + 0.24) * k) / N);
        // the rounded top of the flare, lit by how it faces up
        for (let k = 0; k < N; k++) {
          const a0 = angles[k];
          const a1 = angles[k + 1];
          const am = (a0 + a1) / 2;
          this.poly([base(a0), base(a1), lip(a1, ro), lip(a0, ro)], shade(norm([Math.cos(am), Math.sin(am), 0.6]), acc), true);
        }
        // its outer face, and a dark edge where it meets the tyre
        this.poly([...angles.map((a) => lip(a, ro)), ...angles.slice().reverse().map((a) => lip(a, ri))], shade([0, 0.3, 1], acc, 1.08), true);
        this.poly([...angles.map((a) => lip(a, ri)), ...angles.slice().reverse().map((a) => lip(a, ri - 0.025))], "rgb(10,10,12)");
      }
    }

    // lights: taillights (brighter on the brakes), headlights, exhaust flames
    const brake = this.braking[lane];
    const lampY = Math.min(shape.height * 0.55, 0.7);
    const sides = shape.bike ? [0] : [-W * 0.33, W * 0.33];
    for (const sz of sides) {
      this.sprite(this.glow("rgba(255,40,30,1)"), body([0, lampY, sz]), 0.7 + 1.1 * brake, 0.55 + 0.45 * brake, true);
      this.sprite(this.glow("rgba(255,250,235,1)"), body([shape.len, lampY * 0.85, sz]), 0.9, 0.7, true);
    }
    if (c.flame > 0.02) for (const tip of exhaustTips(c.cfg)) this.flameJet(body(tip), c.flame);
  }
}
