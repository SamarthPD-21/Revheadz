import { EIGHTH_MILE_M, QUARTER_MILE_M, SIXTY_FT_M } from "../../lib/drag/race";
import type { Silhouette as Kind, VehicleConfig } from "../../lib/vehicles/types";
import type { SceneCar, SceneFrame } from "./scene";

/**
 * The drag strip in 2.5D: a chase view from behind your car, with the strip drawn the way
 * classic pseudo-3D racers do it: the world is cut into slices along the track and each
 * slice is projected with similar triangles (screen = centre + world * focal / depth) and
 * filled as a flat trapezoid, far to near. Everything else is a scaled sprite. It needs
 * only canvas 2D fills and drawImage, no WebGL, so it runs on low-end phones.
 *
 * Cheap by construction: no shadowBlur (glows are pre-rendered sprites), text only on
 * cached canvases, slice length grows with distance, and the backing store is capped.
 */

const LANE_X = { me: 2, opp: -2 };
const WALL_X = 6.3;
const LINE_X = 4.1;
const CAM_H = 1.75;
const DRAW_M = 420;
const CAR = { car: { w: 1.9, h: 1.3, len: 4.6 }, bike: { w: 0.8, h: 1.55, len: 2.2 } };

type Canvas = HTMLCanvasElement;
const makeCanvas = (w: number, h: number): [Canvas, CanvasRenderingContext2D] => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return [c, c.getContext("2d")!];
};

/** A soft radial glow, pre-rendered once per colour (instead of per-frame shadowBlur). */
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

/** The car seen from behind, drawn once per vehicle into a sprite (taillights glow separately). */
function rearSprite(cfg: VehicleConfig): Canvas {
  const kind: Kind = cfg.ui.silhouette;
  const bike = cfg.type === "bike";
  const W = 256;
  const H = bike ? 210 : 180;
  const [c, x] = makeCanvas(W, H);
  const accent = cfg.ui.accent;
  const round = (l: number, t: number, w: number, h: number, r: number) => {
    x.beginPath();
    x.roundRect(l, t, w, h, r);
    x.fill();
  };
  if (bike) {
    // tyre, tail, rider
    x.fillStyle = "#0a0a0d";
    round(W / 2 - 22, H - 70, 44, 70, 18);
    x.fillStyle = accent;
    x.beginPath();
    x.moveTo(W / 2 - 52, H - 72);
    x.lineTo(W / 2 + 52, H - 72);
    x.lineTo(W / 2 + 30, H - 112);
    x.lineTo(W / 2 - 30, H - 112);
    x.closePath();
    x.fill();
    x.fillStyle = "#16161c";
    round(W / 2 - 34, H - 160, 68, 54, 22); // rider's back
    x.fillStyle = "#26262e";
    x.beginPath();
    x.arc(W / 2, H - 172, 24, 0, Math.PI * 2); // helmet
    x.fill();
    x.fillStyle = accent;
    x.fillRect(W / 2 - 24, H - 176, 48, 6);
    return c;
  }
  const formula = kind === "formula";
  const bodyTop = formula ? H - 70 : H - 112;
  // tyres
  x.fillStyle = "#0a0a0d";
  const tw = formula ? 56 : 40;
  round(6, H - 52, tw, 52, 8);
  round(W - 6 - tw, H - 52, tw, 52, 8);
  // lower body
  const g = x.createLinearGradient(0, bodyTop, 0, H - 14);
  g.addColorStop(0, accent);
  g.addColorStop(1, "#08080c");
  x.fillStyle = g;
  if (formula) {
    round(W / 2 - 46, bodyTop, 92, 56, 14);
  } else {
    round(18, bodyTop + 30, W - 36, 64, 18);
    // cabin and rear window
    x.beginPath();
    x.moveTo(52, bodyTop + 34);
    x.lineTo(W - 52, bodyTop + 34);
    x.lineTo(W - 78, bodyTop - 2);
    x.lineTo(78, bodyTop - 2);
    x.closePath();
    x.fill();
    x.fillStyle = "rgba(10,12,20,0.92)";
    x.beginPath();
    x.moveTo(64, bodyTop + 30);
    x.lineTo(W - 64, bodyTop + 30);
    x.lineTo(W - 84, bodyTop + 4);
    x.lineTo(84, bodyTop + 4);
    x.closePath();
    x.fill();
  }
  // wing for the racier shapes
  if (kind === "rally" || kind === "gtcar" || kind === "supercar" || formula) {
    x.fillStyle = "#121217";
    x.fillRect(formula ? 20 : 34, bodyTop - (formula ? 22 : 16), W - (formula ? 40 : 68), formula ? 12 : 8);
    x.fillRect(formula ? 60 : 70, bodyTop - (formula ? 12 : 8), 8, formula ? 30 : 14);
    x.fillRect(W - (formula ? 68 : 78), bodyTop - (formula ? 12 : 8), 8, formula ? 30 : 14);
  }
  // taillight housings, plate, exhausts
  if (!formula) {
    x.fillStyle = "#3a0a0a";
    round(26, bodyTop + 44, 62, 14, 5);
    round(W - 88, bodyTop + 44, 62, 14, 5);
    x.fillStyle = "#e4e4e7";
    x.fillRect(W / 2 - 28, bodyTop + 64, 56, 16);
    x.fillStyle = "#050507";
    x.beginPath();
    x.arc(W / 2 - 60, H - 22, 8, 0, Math.PI * 2);
    x.arc(W / 2 + 60, H - 22, 8, 0, Math.PI * 2);
    x.fill();
  } else {
    x.fillStyle = "#3a0a0a";
    x.fillRect(W / 2 - 6, bodyTop + 6, 12, 8);
  }
  return c;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  r: number;
  life: number;
  max: number;
  vx: number;
  vy: number;
}

interface Sprite {
  z: number;
  draw: () => void;
}

export class DragScene25D {
  private readonly glows = new Map<string, Canvas>();
  private readonly rears = new Map<string, Canvas>();
  private readonly boards = new Map<string, Canvas>();
  private timing: { canvas: Canvas; ctx: CanvasRenderingContext2D; key: string } | null = null;
  private sky: { canvas: Canvas; w: number; h: number } | null = null;
  private crowd: Canvas | null = null;
  private puffs: Puff[] = [];
  private lastTime = 0;
  private prevSpeed = { me: 0, opp: 0 };
  private squat = { me: 0, opp: 0 };
  private braking = { me: 0, opp: 0 };
  private camZ = -12;
  private fov = 1;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  private glow(color: string) {
    let g = this.glows.get(color);
    if (!g) {
      g = glowSprite(color);
      this.glows.set(color, g);
    }
    return g;
  }

  private rear(cfg: VehicleConfig) {
    let r = this.rears.get(cfg.id);
    if (!r) {
      r = rearSprite(cfg);
      this.rears.set(cfg.id, r);
    }
    return r;
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
      b = c;
      this.boards.set(label, b);
    }
    return b;
  }

  private crowdTex() {
    if (!this.crowd) {
      const [c, x] = makeCanvas(512, 128);
      x.fillStyle = "#121119";
      x.fillRect(0, 0, 512, 128);
      for (let i = 0; i < 1400; i++) {
        const h = Math.floor(Math.random() * 360);
        x.fillStyle = `hsla(${h},35%,${40 + Math.random() * 25}%,0.8)`;
        x.fillRect(Math.random() * 512, 6 + Math.random() * 118, 3, 3);
      }
      for (let r = 1; r < 6; r++) {
        x.fillStyle = "rgba(0,0,0,0.5)";
        x.fillRect(0, r * 21, 512, 3);
      }
      this.crowd = c;
    }
    return this.crowd;
  }

  private skyCanvas(w: number, h: number) {
    if (this.sky && this.sky.w === w && this.sky.h === h) return this.sky.canvas;
    const [c, x] = makeCanvas(w, h);
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#04040a");
    g.addColorStop(1, "#1a1426");
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) {
      x.fillStyle = `rgba(220,220,255,${0.2 + Math.random() * 0.6})`;
      x.fillRect(Math.random() * w, Math.random() * h * 0.85, 1.2, 1.2);
    }
    // distant city glow on the horizon
    const cg = x.createLinearGradient(0, h * 0.7, 0, h);
    cg.addColorStop(0, "rgba(249,115,22,0)");
    cg.addColorStop(1, "rgba(249,115,22,0.18)");
    x.fillStyle = cg;
    x.fillRect(0, h * 0.7, w, h * 0.3);
    this.sky = { canvas: c, w, h };
    return c;
  }

  private drawTiming(me: SceneCar, opp: SceneCar) {
    if (!this.timing) {
      const [canvas, ctx] = makeCanvas(512, 200);
      this.timing = { canvas, ctx, key: "" };
    }
    const key = `${me.et}|${opp.et}`;
    if (key === this.timing.key) return this.timing.canvas;
    this.timing.key = key;
    const c = this.timing.ctx;
    c.fillStyle = "#050508";
    c.fillRect(0, 0, 512, 200);
    c.strokeStyle = "#2a2833";
    c.lineWidth = 6;
    c.strokeRect(3, 3, 506, 194);
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
    return this.timing.canvas;
  }

  draw(f: SceneFrame, w: number, h: number) {
    const ctx = this.ctx;
    const dt = Math.min(0.05, Math.max(0, f.time - this.lastTime));
    this.lastTime = f.time;
    const me = f.me;
    const myLen = me.cfg.type === "bike" ? CAR.bike.len : CAR.car.len;
    const myNose = me.distM - me.rollBackM;

    // camera: behind and above your car; the field of view opens up with speed
    const portrait = h > w;
    const back = portrait ? 8 : 6.5;
    const camTarget = myNose - myLen - back;
    this.camZ += (camTarget - this.camZ) * Math.min(1, dt * 10);
    if (Math.abs(camTarget - this.camZ) > 30) this.camZ = camTarget;
    const fovTarget = 1 - Math.min(0.32, me.speedKmh / 650);
    this.fov += (fovTarget - this.fov) * Math.min(1, dt * 3);
    const F = (portrait ? w * 1.25 : h * 1.05) * this.fov;
    const horizon = h * (portrait ? 0.36 : 0.4);
    const camX = 1.3;
    const shake = f.shake * f.shake;
    const sxShake = (Math.random() - 0.5) * 7 * shake;
    const syShake = (Math.random() - 0.5) * 5 * shake;
    const camZ = this.camZ;

    const px = (x: number, z: number) => w / 2 + ((x - camX) * F) / (z - camZ) + sxShake;
    const py = (y: number, z: number) => horizon + ((CAM_H - y) * F) / (z - camZ) + syShake;
    const quad = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fill();
    };

    ctx.drawImage(this.skyCanvas(w, Math.ceil(horizon) + 2), 0, 0);
    ctx.fillStyle = "#0b0a10";
    ctx.fillRect(0, horizon, w, h - horizon);

    // ---- the strip, far to near ------------------------------------------------
    const near = camZ + 0.8;
    const slices: [number, number][] = [];
    for (let z = near; z < camZ + DRAW_M; ) {
      const len = 2 + (z - camZ) * 0.045; // longer slices further away
      slices.push([z, Math.min(z + len, camZ + DRAW_M)]);
      z += len;
    }
    const crowd = this.crowdTex();
    for (let i = slices.length - 1; i >= 0; i--) {
      const [za, zb] = slices[i]; // za near, zb far
      const ya = py(0, za);
      const yb = py(0, zb);
      if (ya < horizon - 1) continue;
      const band = Math.floor(za / 8) % 2 === 0;
      // grandstand face (left) with the crowd
      const sTopA = py(8, za);
      const sTopB = py(8, zb);
      const sxA = px(-16, za);
      const sxB = px(-16, zb);
      quad(sxB, sTopB, sxA, sTopA, sxA, ya, sxB, yb, "#100f17");
      const wSlice = Math.max(1, sxB - sxA);
      if (Math.abs(wSlice) > 0.5) ctx.drawImage(crowd, (za * 9) % 400, 0, 100, 128, Math.min(sxA, sxB), sTopB, Math.abs(sxB - sxA) + 1, (ya - sTopA) * 0.75);
      // asphalt (with faint bands: the strongest cue of speed)
      quad(px(-WALL_X, zb), yb, px(WALL_X, zb), yb, px(WALL_X, za), ya, px(-WALL_X, za), ya, band ? "#1b1a21" : "#18171d");
      // rubbered-in launch lanes
      if (za < 75) {
        const a = 0.55 * (1 - Math.max(0, za) / 75);
        for (const lx of [LANE_X.me, LANE_X.opp]) quad(px(lx - 0.9, zb), yb, px(lx + 0.9, zb), yb, px(lx + 0.9, za), ya, px(lx - 0.9, za), ya, `rgba(0,0,0,${a})`);
      }
      // lines: centre, lane edges, and dashes
      const line = (x: number, half: number, color: string) => quad(px(x - half, zb), yb, px(x + half, zb), yb, px(x + half, za), ya, px(x - half, za), ya, color);
      line(0, 0.06, "#c99a1c");
      line(LINE_X, 0.05, "#bdbdc6");
      line(-LINE_X, 0.05, "#bdbdc6");
      if (band) {
        line(3.4, 0.04, "#5c5b66");
        line(-3.4, 0.04, "#5c5b66");
      }
      // start and finish lines
      for (const [mark, color] of [[0, "#f4f4f5"], [QUARTER_MILE_M, "checker"]] as [number, string][]) {
        if (mark >= za && mark < zb) {
          const y0 = py(0, mark);
          const y1 = py(0, mark + (color === "checker" ? 0.9 : 0.3));
          if (color === "checker") {
            for (let k = 0; k < 12; k++) {
              const xa = -WALL_X + (k * 2 * WALL_X) / 12;
              const xb = xa + (2 * WALL_X) / 12;
              quad(px(xa, mark + 0.9), y1, px(xb, mark + 0.9), y1, px(xb, mark), y0, px(xa, mark), y0, k % 2 ? "#f4f4f5" : "#0b0b0f");
            }
          } else quad(px(-WALL_X, mark + 0.3), y1, px(WALL_X, mark + 0.3), y1, px(WALL_X, mark), y0, px(-WALL_X, mark), y0, color);
        }
      }
      // walls with ad panels
      const panel = Math.floor(za / 24) % 3;
      const adColor = panel === 0 ? "#c2580f" : panel === 1 ? "#24222e" : "#7fae1f";
      for (const side of [-1, 1]) {
        const x = side * WALL_X;
        quad(px(x, zb), py(1.1, zb), px(x, za), py(1.1, za), px(x, za), ya, px(x, zb), yb, side < 0 ? "#2d2c35" : "#33323c");
        quad(px(x, zb), py(0.95, zb), px(x, za), py(0.95, za), px(x, za), py(0.25, za), px(x, zb), py(0.25, zb), adColor);
      }
    }

    // ---- sprites, sorted far to near -------------------------------------------
    const sprites: Sprite[] = [];
    const lamp = this.glow("rgba(255,244,214,1)");
    // light towers
    for (let k = Math.floor((camZ - 40) / 34); k < Math.floor((camZ + DRAW_M) / 34); k++) {
      const z = k * 34 + 10;
      if (z - camZ < 2) continue;
      for (const side of [-11, 11]) {
        sprites.push({
          z,
          draw: () => {
            const s = F / (z - camZ);
            const x = px(side, z);
            ctx.fillStyle = "#24232c";
            ctx.fillRect(x - 0.1 * s, py(16, z), Math.max(1, 0.2 * s), py(0, z) - py(16, z));
            const g = 9 * s;
            ctx.globalCompositeOperation = "lighter";
            ctx.drawImage(lamp, x - g / 2, py(16, z) - g / 2, g, g);
            ctx.globalCompositeOperation = "source-over";
          },
        });
      }
    }
    // distance boards on the left wall
    for (const [m, label] of [[SIXTY_FT_M, "60 FT"], [100.584, "330 FT"], [EIGHTH_MILE_M, "1/8 MILE"], [304.8, "1000 FT"]] as [number, string][]) {
      if (m - camZ < 2 || m - camZ > DRAW_M) continue;
      sprites.push({
        z: m,
        draw: () => {
          const s = F / (m - camZ);
          ctx.drawImage(this.board(label), px(-WALL_X, m) - 1.3 * s, py(2.6, m), 2.6 * s, 1 * s);
        },
      });
    }
    // finish gantry with the timing board
    if (QUARTER_MILE_M - camZ > 2) {
      const z = QUARTER_MILE_M + 6;
      const timing = this.drawTiming(f.me, f.opp);
      sprites.push({
        z,
        draw: () => {
          const s = F / (z - camZ);
          ctx.fillStyle = "#24232c";
          for (const side of [-WALL_X - 0.5, WALL_X + 0.5]) ctx.fillRect(px(side, z) - 0.15 * s, py(7, z), 0.3 * s, py(0, z) - py(7, z));
          ctx.drawImage(timing, px(-3.2, z), py(7.2, z), 6.4 * s, 2.5 * s);
        },
      });
    }
    // the christmas tree, on the centre line just past the start
    const treeZ = 3;
    if (treeZ - camZ > 1.5) {
      sprites.push({ z: treeZ, draw: () => this.tree(f, px(0, treeZ), py(0, treeZ), F / (treeZ - camZ)) });
    }
    // cars
    for (const lane of ["opp", "me"] as const) {
      const c = f[lane];
      const dims = c.cfg.type === "bike" ? CAR.bike : CAR.car;
      const rearZ = c.distM - c.rollBackM - dims.len;
      if (rearZ - camZ < 1) continue;
      const a = (c.speedKmh - this.prevSpeed[lane]) / 3.6 / Math.max(dt, 1e-3);
      this.prevSpeed[lane] = c.speedKmh;
      this.squat[lane] += (Math.max(-1, Math.min(1, a / 12)) - this.squat[lane]) * Math.min(1, dt * 8);
      this.braking[lane] += ((a < -2 ? 1 : 0) - this.braking[lane]) * Math.min(1, dt * 6);
      // tyre smoke off the line
      if (c.distM > 0.05 && c.distM < 24) {
        const n = Math.random() < 1 - c.distM / 24 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          this.puffs.push({
            x: LANE_X[lane] + (Math.random() < 0.5 ? -1 : 1) * dims.w * 0.4,
            y: 0.2,
            z: rearZ - 0.2,
            r: 0.4,
            life: 0,
            max: 1.2 + Math.random(),
            vx: (Math.random() - 0.5) * 1.2,
            vy: 0.5 + Math.random() * 0.6,
          });
        }
      }
      sprites.push({ z: rearZ, draw: () => this.car(c, lane, rearZ, px, py, F / (rearZ - camZ), f.time) });
    }
    for (const p of this.puffs) {
      if (p.z - camZ < 1) continue;
      sprites.push({
        z: p.z,
        draw: () => {
          const s = F / (p.z - camZ);
          const r = p.r * s;
          ctx.globalAlpha = 0.35 * (1 - p.life / p.max);
          ctx.drawImage(this.glow("rgba(205,205,214,1)"), px(p.x, p.z) - r, py(p.y, p.z) - r, r * 2, r * 2);
          ctx.globalAlpha = 1;
        },
      });
    }
    sprites.sort((a, b) => b.z - a.z);
    for (const s of sprites) s.draw();

    // smoke physics
    for (const p of this.puffs) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += 1.6 * dt;
    }
    this.puffs = this.puffs.filter((p) => p.life < p.max).slice(-220);

    // speed streaks at the edges
    if (me.speedKmh > 80) {
      const k = Math.min(1, (me.speedKmh - 80) / 220);
      ctx.strokeStyle = `rgba(255,255,255,${0.06 + 0.12 * k})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 18; i++) {
        const seed = (i * 97.13 + Math.floor(f.time * 24) * 13.7) % 1;
        const side = i % 2 ? 1 : -1;
        const y = horizon + ((i * 53) % (h - horizon));
        const x = w / 2 + side * (w * 0.35 + seed * w * 0.15);
        ctx.moveTo(x, y);
        ctx.lineTo(x + side * (30 + 90 * k), y + ((y - horizon) / h) * 30 * k);
      }
      ctx.stroke();
    }
  }

  private tree(f: SceneFrame, x: number, ground: number, s: number) {
    const ctx = this.ctx;
    ctx.fillStyle = "#1d1c24";
    ctx.fillRect(x - 0.08 * s, ground - 2.4 * s, 0.16 * s, 2.4 * s);
    ctx.fillStyle = "#0b0b0f";
    ctx.beginPath();
    ctx.roundRect(x - 0.42 * s, ground - 4.6 * s, 0.84 * s, 2.3 * s, 0.08 * s);
    ctx.fill();
    const lanes: [SceneCar["lights"], number][] = [
      [f.opp.lights, -0.18],
      [f.me.lights, 0.18],
    ];
    for (const [l, dx] of lanes) {
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
        const bx = x + dx * s;
        const by = ground - (4.4 - i * 0.3) * s;
        const r = (i < 2 ? 0.05 : 0.1) * s;
        ctx.fillStyle = on ? color : "#1b1b21";
        ctx.beginPath();
        ctx.arc(bx, by, Math.max(1, r), 0, Math.PI * 2);
        ctx.fill();
        if (on) {
          const g = r * 7;
          ctx.globalCompositeOperation = "lighter";
          ctx.drawImage(this.glow(color), bx - g / 2, by - g / 2, g, g);
          ctx.globalCompositeOperation = "source-over";
        }
      });
    }
  }

  private car(c: SceneCar, lane: "me" | "opp", rearZ: number, px: (x: number, z: number) => number, py: (y: number, z: number) => number, s: number, time: number) {
    const ctx = this.ctx;
    const dims = c.cfg.type === "bike" ? CAR.bike : CAR.car;
    const sprite = this.rear(c.cfg);
    const cx = px(LANE_X[lane], rearZ);
    const ground = py(0, rearZ);
    const spriteW = (dims.w + 0.4) * s;
    const spriteH = (spriteW * sprite.height) / sprite.width;
    const squat = this.squat[lane] * 0.05 * s; // rear squats under power
    // contact shadow and underglow
    ctx.globalAlpha = 0.7;
    ctx.drawImage(this.glow("rgba(0,0,0,1)"), cx - spriteW * 0.6, ground - spriteH * 0.12, spriteW * 1.2, spriteH * 0.3);
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(this.glow(hexToRgba(c.cfg.ui.accent)), cx - spriteW * 0.75, ground - spriteH * 0.18, spriteW * 1.5, spriteH * 0.4);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(sprite, cx - spriteW / 2, ground - spriteH + squat, spriteW, spriteH);
    // taillights glow, brighter on the brakes during the cool-down
    const bike = c.cfg.type === "bike";
    const lightY = ground - spriteH * (bike ? 0.5 : 0.5) + squat;
    const brake = this.braking[lane];
    const tail = this.glow("rgba(255,40,30,1)");
    const tg = spriteW * (0.22 + 0.28 * brake);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.55 + 0.45 * brake;
    for (const side of bike ? [0] : [-0.33, 0.33]) ctx.drawImage(tail, cx + side * spriteW - tg / 2, lightY - tg / 2, tg, tg);
    // exhaust flame
    if (c.flame > 0.02) {
      const fl = this.glow("rgba(120,170,255,1)");
      const fs = spriteW * (0.18 + 0.25 * c.flame) * (0.8 + 0.2 * Math.sin(time * 80));
      ctx.globalAlpha = Math.min(1, c.flame * 1.2);
      for (const side of bike ? [0] : [-0.23, 0.23]) ctx.drawImage(fl, cx + side * spriteW - fs / 2, ground - spriteH * 0.13 - fs / 2 + squat, fs, fs);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    void py;
  }
}

function hexToRgba(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, (x) => x + x) : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1)`;
}
