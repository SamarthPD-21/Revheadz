import { EIGHTH_MILE_M, QUARTER_MILE_M, SIXTY_FT_M } from "../../lib/drag/race";
import type { VehicleConfig } from "../../lib/vehicles/types";
import type { SceneCar, SceneFrame } from "./scene";

/**
 * The drag strip in 2.5D: the main branch's layout (the strip runs left to right, the other
 * lane above yours, the camera following your car), seen from above at an angle. The camera
 * hangs high over the near side and tilts towards the grandstand, so both lanes are seen
 * from the top while walls, stands and light towers keep their height.
 *
 * It is a real perspective projection, drawn with nothing but canvas 2D fills and
 * drawImage: no WebGL, no shadowBlur (glows are pre-rendered sprites), text only on cached
 * canvases. Cars are top-down sprites mapped onto the road with an affine transform.
 */

const LANE_Z = { me: 2, opp: -2 }; // + is towards the camera (near side)
const WALL_Z = 6.3;
const LINE_Z = 4.1;
const CAR = { car: { w: 1.9, len: 4.6, h: 1.25 }, bike: { w: 0.8, len: 2.2, h: 1.4 } };

type Canvas = HTMLCanvasElement;
type P = { x: number; y: number; s: number; ok: boolean };

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

/** Lightens (amount > 0) or darkens a #rrggbb colour. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (v: number) => Math.round(Math.min(255, Math.max(0, amount > 0 ? v + (255 - v) * amount : v * (1 + amount))));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

const rgba = (hex: string, a = 1) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** The car seen from above, nose to the right (canvas x = along the car, y = across). */
function topSprite(cfg: VehicleConfig): Canvas {
  const bike = cfg.type === "bike";
  const formula = cfg.ui.silhouette === "formula";
  const L = 320;
  const W = bike ? 64 : 140;
  const [c, x] = makeCanvas(L, W);
  const accent = cfg.ui.accent;
  const rr = (l: number, t: number, w: number, h: number, r: number, fill: string | CanvasGradient) => {
    x.fillStyle = fill;
    x.beginPath();
    x.roundRect(l, t, w, h, r);
    x.fill();
  };
  const body = x.createLinearGradient(0, 0, 0, W);
  body.addColorStop(0, shade(accent, -0.35));
  body.addColorStop(0.5, shade(accent, 0.25));
  body.addColorStop(1, shade(accent, -0.35));
  if (bike) {
    rr(14, W / 2 - 8, 70, 16, 8, "#0a0a0d"); // rear tyre
    rr(L - 84, W / 2 - 7, 70, 14, 7, "#0a0a0d"); // front tyre
    rr(60, W / 2 - 18, 190, 36, 16, body); // tank and tail
    rr(150, 4, 14, W - 8, 6, "#1a1a20"); // bars
    x.fillStyle = "#26262e";
    x.beginPath();
    x.arc(130, W / 2, 20, 0, Math.PI * 2); // helmet
    x.fill();
    x.fillStyle = accent;
    x.fillRect(118, W / 2 - 3, 24, 6);
    return c;
  }
  // tyres poking out at the corners
  const tw = formula ? 64 : 56;
  const th = formula ? 30 : 20;
  for (const tx of formula ? [26, L - 26 - tw] : [40, L - 40 - tw]) {
    rr(tx, 0, tw, th, 6, "#0a0a0d");
    rr(tx, W - th, tw, th, 6, "#0a0a0d");
  }
  if (formula) {
    rr(30, W / 2 - 22, 230, 44, 20, body); // tub
    rr(250, W / 2 - 8, 66, 16, 8, body); // nose
    rr(L - 18, 18, 14, W - 36, 4, "#16161c"); // front wing
    rr(4, 14, 18, W - 28, 4, "#16161c"); // rear wing
    x.fillStyle = "#0b0b10";
    x.beginPath();
    x.arc(150, W / 2, 14, 0, Math.PI * 2); // cockpit
    x.fill();
    return c;
  }
  rr(10, 12, L - 20, W - 24, 34, body); // body
  // glasshouse: rear window, roof, windscreen
  rr(84, 22, 46, W - 44, 12, "rgba(10,12,20,0.9)");
  rr(128, 22, 66, W - 44, 14, shade(accent, 0.12));
  rr(136, 30, 50, W - 60, 10, shade(accent, 0.3)); // roof highlight
  rr(192, 22, 46, W - 44, 12, "rgba(10,12,20,0.9)");
  // bonnet line and mirrors
  x.strokeStyle = "rgba(255,255,255,0.18)";
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(246, W / 2);
  x.lineTo(L - 22, W / 2);
  x.stroke();
  rr(196, 8, 14, 10, 4, shade(accent, -0.3));
  rr(196, W - 18, 14, 10, 4, shade(accent, -0.3));
  // lights
  rr(L - 18, 20, 8, 26, 4, "#f5f5f0");
  rr(L - 18, W - 46, 8, 26, 4, "#f5f5f0");
  rr(10, 20, 8, 28, 4, "#a8141a");
  rr(10, W - 48, 8, 28, 4, "#a8141a");
  if (cfg.ui.silhouette === "rally" || cfg.ui.silhouette === "gtcar" || cfg.ui.silhouette === "supercar") rr(4, 16, 22, W - 32, 5, "#121217"); // wing
  return c;
}

interface Puff {
  x: number;
  z: number;
  y: number;
  r: number;
  life: number;
  max: number;
  vx: number;
  vz: number;
}

export class DragScene25D {
  private readonly glows = new Map<string, Canvas>();
  private readonly tops = new Map<string, Canvas>();
  private readonly boards = new Map<string, Canvas>();
  private timing: { canvas: Canvas; ctx: CanvasRenderingContext2D; key: string } | null = null;
  private crowd: Canvas | null = null;
  private puffs: Puff[] = [];
  private lastTime = 0;
  private prevSpeed = { me: 0, opp: 0 };
  private braking = { me: 0, opp: 0 };
  private squat = { me: 0, opp: 0 };
  private camX = -10;
  private zoom = 1;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  private glow(color: string) {
    let g = this.glows.get(color);
    if (!g) this.glows.set(color, (g = glowSprite(color)));
    return g;
  }

  private top(cfg: VehicleConfig) {
    let t = this.tops.get(cfg.id);
    if (!t) this.tops.set(cfg.id, (t = topSprite(cfg)));
    return t;
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
      const [c, x] = makeCanvas(512, 128);
      x.fillStyle = "#121119";
      x.fillRect(0, 0, 512, 128);
      for (let i = 0; i < 1500; i++) {
        x.fillStyle = `hsla(${Math.floor(Math.random() * 360)},35%,${40 + Math.random() * 25}%,0.85)`;
        x.fillRect(Math.random() * 512, Math.random() * 128, 3, 3);
      }
      for (let r = 1; r < 6; r++) {
        x.fillStyle = "rgba(0,0,0,0.55)";
        x.fillRect(0, r * 21, 512, 3);
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
    }
    return this.timing.canvas;
  }

  draw(f: SceneFrame, w: number, h: number) {
    const ctx = this.ctx;
    const dt = Math.min(0.05, Math.max(0, f.time - this.lastTime));
    this.lastTime = f.time;
    const me = f.me;
    const portrait = h > w;

    // camera: high over the near side, tilted towards the stands; follows your car along x
    // (your car sits left of centre, so you see the strip ahead) and rises a little with speed
    const myX = me.distM - me.rollBackM;
    const H0 = (portrait ? 30 : 21) * this.zoom;
    // keep your car about a third of the way across (it's 4.6 m long; the strip ahead matters)
    const tiltA = (34 * Math.PI) / 180;
    const camZ0 = portrait ? 14 : 11;
    const depthMe = H0 * Math.cos(tiltA) + (camZ0 - LANE_Z.me) * Math.sin(tiltA);
    const scaleMe = (portrait ? w * 1.6 : h * 1.45) / depthMe;
    const lead = (w * (portrait ? 0.1 : 0.16)) / scaleMe;
    // before the launch, frame the start: the tree and both staged cars
    const launched = me.distM > 0.05;
    const camTarget = launched ? myX - 2.3 + lead : -3.5;
    this.camX += (camTarget - this.camX) * Math.min(1, dt * 8);
    if (Math.abs(camTarget - this.camX) > 40) this.camX = camTarget;
    this.zoom += (1 + Math.min(0.35, me.speedKmh / 700) - this.zoom) * Math.min(1, dt * 2);
    const H = H0; // camera height
    const camZ = camZ0; // over the near side
    const tilt = tiltA; // from straight down, towards the far side
    const fz = -Math.sin(tilt);
    const fy = -Math.cos(tilt);
    const uz = -Math.cos(tilt);
    const uy = Math.sin(tilt);
    const F = portrait ? w * 1.6 : h * 1.45;
    const shake = f.shake * f.shake;
    const ox = w / 2 + (Math.random() - 0.5) * 6 * shake;
    const oy = h * (portrait ? 0.5 : 0.48) + (Math.random() - 0.5) * 4 * shake;
    const camX = this.camX;
    const proj = (x: number, y: number, z: number): P => {
      const dx = x - camX;
      const dy = y - H;
      const dz = z - camZ;
      const depth = dy * fy + dz * fz;
      if (depth < 0.5) return { x: 0, y: 0, s: 0, ok: false };
      const s = F / depth;
      return { x: ox + dx * s, y: oy - (dy * uy + dz * uz) * s, s, ok: true };
    };
    const quad = (a: P, b: P, c: P, d: P, fill: string) => {
      if (!a.ok || !b.ok || !c.ok || !d.ok) return;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill();
    };
    // a flat strip along x between z0 and z1 at height y (straight edges: one quad)
    const strip = (xa: number, xb: number, z0: number, z1: number, fill: string, y = 0) => quad(proj(xa, y, z0), proj(xb, y, z0), proj(xb, y, z1), proj(xa, y, z1), fill);
    // a vertical face at constant z between y0 and y1
    const face = (xa: number, xb: number, z: number, y0: number, y1: number, fill: string) => quad(proj(xa, y1, z), proj(xb, y1, z), proj(xb, y0, z), proj(xa, y0, z), fill);

    // the stretch of track in view
    const span = (w / F) * H * 1.8 + 30;
    const x0 = camX - span;
    const x1 = camX + span;

    // background: the night beyond the stands
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#05050b");
    g.addColorStop(1, "#0d0c13");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // ground outside the walls, then the asphalt with faint bands every 8 m (a speed cue)
    strip(x0, x1, -40, 40, "#0c0b11");
    for (let k = Math.floor(x0 / 8); k < Math.ceil(x1 / 8); k++) strip(k * 8, k * 8 + 8, -WALL_Z, WALL_Z, k % 2 ? "#1b1a21" : "#18171d");
    // rubbered-in launch area
    for (const lz of [LANE_Z.me, LANE_Z.opp]) {
      for (let k = 0; k < 10; k++) strip(-4 + k * 8, 4 + k * 8, lz - 0.9, lz + 0.9, `rgba(0,0,0,${0.5 * (1 - k / 10)})`);
    }
    // lines: centre, lane edges, dashes
    strip(x0, x1, -0.06, 0.06, "#c99a1c");
    strip(x0, x1, LINE_Z - 0.05, LINE_Z + 0.05, "#bdbdc6");
    strip(x0, x1, -LINE_Z - 0.05, -LINE_Z + 0.05, "#bdbdc6");
    for (let k = Math.floor(x0 / 6); k < Math.ceil(x1 / 6); k++) {
      strip(k * 6, k * 6 + 2.4, 3.36, 3.44, "#5c5b66");
      strip(k * 6, k * 6 + 2.4, -3.44, -3.36, "#5c5b66");
    }
    // pools of light under the towers
    const pool = this.glow("rgba(255,241,214,1)");
    ctx.globalAlpha = 0.07;
    ctx.globalCompositeOperation = "lighter";
    for (let k = Math.floor((x0 - 10) / 34); k <= Math.ceil(x1 / 34); k++) {
      const p = proj(k * 34 + 10, 0, 0);
      if (p.ok) ctx.drawImage(pool, p.x - 14 * p.s, p.y - 8 * p.s, 28 * p.s, 16 * p.s);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    // start line and finish checker
    strip(-0.15, 0.15, -WALL_Z, WALL_Z, "#f4f4f5");
    for (let k = 0; k < 14; k++) {
      const za = -WALL_Z + (k * 2 * WALL_Z) / 14;
      const zb = za + (2 * WALL_Z) / 14;
      strip(QUARTER_MILE_M - 0.5, QUARTER_MILE_M, za, zb, k % 2 ? "#f4f4f5" : "#0b0b0f");
      strip(QUARTER_MILE_M, QUARTER_MILE_M + 0.5, za, zb, k % 2 ? "#0b0b0f" : "#f4f4f5");
    }

    // far side: grandstand tiers rising away from the track, then the wall with its ads
    const crowd = this.crowdTex();
    for (let t = 5; t >= 0; t--) {
      const z = -8.4 - t * 2.4;
      const y = 1 + t * 1.1;
      strip(x0, x1, z - 2.4, z, "#14131b", y); // tier top
      // tier front with the crowd (one textured slice per 16 m)
      for (let k = Math.floor(x0 / 16); k < Math.ceil(x1 / 16); k++) {
        const a = proj(k * 16, y + 1.1, z);
        const b = proj(k * 16 + 16, y, z);
        if (a.ok && b.ok && b.x > 0 && a.x < w) ctx.drawImage(crowd, (((k * 97) % 400) + 400) % 400, 0, 112, 128, a.x, a.y, b.x - a.x + 1, b.y - a.y);
      }
    }
    // far wall: inner face with ad panels, then its top
    for (let k = Math.floor(x0 / 24); k < Math.ceil(x1 / 24); k++) {
      const panel = ((k % 3) + 3) % 3;
      face(k * 24, k * 24 + 24, -WALL_Z, 0, 1.1, "#2f2e38");
      face(k * 24 + 0.5, k * 24 + 23.5, -WALL_Z + 0.01, 0.2, 0.95, panel === 0 ? "#c2580f" : panel === 1 ? "#24222e" : "#7fae1f");
    }
    strip(x0, x1, -WALL_Z - 0.35, -WALL_Z, "#46454f", 1.1);
    // distance boards on the far wall
    for (const [m, label] of [[SIXTY_FT_M, "60 FT"], [100.584, "330 FT"], [EIGHTH_MILE_M, "1/8 MILE"], [304.8, "1000 FT"]] as [number, string][]) {
      if (m < x0 || m > x1) continue;
      const a = proj(m - 1.3, 2.5, -WALL_Z - 0.2);
      const b = proj(m + 1.3, 1.5, -WALL_Z - 0.2);
      if (a.ok && b.ok) ctx.drawImage(this.board(label), a.x, a.y, b.x - a.x, b.y - a.y);
    }
    // finish gantry with the timing board (far side)
    if (QUARTER_MILE_M > x0 && QUARTER_MILE_M < x1 + 20) {
      face(QUARTER_MILE_M + 5.3, QUARTER_MILE_M + 5.7, -WALL_Z - 1.2, 0, 3.8, "#24232c");
      const a = proj(QUARTER_MILE_M + 2, 6.5, -WALL_Z - 1.2);
      const b = proj(QUARTER_MILE_M + 9, 3.8, -WALL_Z - 1.2);
      if (a.ok && b.ok) ctx.drawImage(this.timingBoard(f.me, f.opp), a.x, a.y, b.x - a.x, b.y - a.y);
    }
    // light towers on the far side (rising towards the top of the screen)
    const lamp = this.glow("rgba(255,244,214,1)");
    for (let k = Math.floor((x0 - 10) / 34); k <= Math.ceil(x1 / 34); k++) {
      const x = k * 34 + 10;
      const base = proj(x, 0, -7.6);
      const top = proj(x, 15, -7.6);
      if (!base.ok || !top.ok) continue;
      ctx.strokeStyle = "#2a2932";
      ctx.lineWidth = Math.max(1, 0.25 * base.s);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
      const gsz = 7 * top.s;
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(lamp, top.x - gsz / 2, top.y - gsz / 2, gsz, gsz);
      ctx.globalCompositeOperation = "source-over";
    }

    // the christmas tree, standing on the centre line behind the staged cars
    this.tree(f, proj);

    // cars, smoke and effects: far lane first
    for (const lane of ["opp", "me"] as const) {
      const c = f[lane];
      const dims = c.cfg.type === "bike" ? CAR.bike : CAR.car;
      const a = (c.speedKmh - this.prevSpeed[lane]) / 3.6 / Math.max(dt, 1e-3);
      this.prevSpeed[lane] = c.speedKmh;
      this.braking[lane] += ((a < -2 ? 1 : 0) - this.braking[lane]) * Math.min(1, dt * 6);
      this.squat[lane] += (Math.max(-1, Math.min(1, a / 12)) - this.squat[lane]) * Math.min(1, dt * 8);
      const nose = c.distM - c.rollBackM;
      if (c.distM > 0.05 && c.distM < 24) {
        const n = Math.random() < 1 - c.distM / 24 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          this.puffs.push({
            x: nose - dims.len * 0.85,
            z: LANE_Z[lane] + (Math.random() < 0.5 ? -1 : 1) * dims.w * 0.42,
            y: 0.3,
            r: 0.45,
            life: 0,
            max: 1.1 + Math.random(),
            vx: -2 - Math.random() * 2.5,
            vz: (Math.random() - 0.5) * 2,
          });
        }
      }
      this.drawPuffs(proj, LANE_Z[lane]);
      this.car(c, lane, nose, proj, f.time);
    }
    for (const p of this.puffs) {
      p.life += dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.y += 0.6 * dt;
      p.r += 1.8 * dt;
    }
    this.puffs = this.puffs.filter((p) => p.life < p.max).slice(-220);

    // speed streaks
    if (me.speedKmh > 80) {
      const k = Math.min(1, (me.speedKmh - 80) / 220);
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + 0.1 * k})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 22; i++) {
        const y = (((i * 97) % 100) / 100) * h;
        const x = ((((i * 53.7 - f.time * (900 + 1600 * k)) % (w + 200)) + w + 200) % (w + 200)) - 100;
        ctx.moveTo(x, y);
        ctx.lineTo(x + 40 + 120 * k, y);
      }
      ctx.stroke();
    }
  }

  private tree(f: SceneFrame, proj: (x: number, y: number, z: number) => P) {
    const ctx = this.ctx;
    const x = -7.5;
    const base = proj(x, 0, 0);
    const top = proj(x, 4.8, 0);
    if (!base.ok || !top.ok) return;
    ctx.strokeStyle = "#1d1c24";
    ctx.lineWidth = Math.max(1, 0.16 * base.s);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();
    // housing facing the camera, bulbs for both lanes
    const tl = proj(x, 4.85, -0.5);
    const br = proj(x, 2.35, 0.5);
    if (tl.ok && br.ok) {
      ctx.fillStyle = "#0b0b0f";
      ctx.fillRect(Math.min(tl.x, br.x) - 0.25 * top.s, tl.y, Math.abs(br.x - tl.x) + 0.5 * top.s, br.y - tl.y);
    }
    const lanes: [SceneCar["lights"], number][] = [
      [f.opp.lights, -0.22],
      [f.me.lights, 0.22],
    ];
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
        const p = proj(x + 0.25, 4.6 - i * 0.3, dz);
        if (!p.ok) return;
        const r = Math.max(1.2, (i < 2 ? 0.06 : 0.11) * p.s);
        ctx.fillStyle = on ? color : "#1b1b21";
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (on) {
          const gs = r * 7;
          ctx.globalCompositeOperation = "lighter";
          ctx.drawImage(this.glow(color), p.x - gs / 2, p.y - gs / 2, gs, gs);
          ctx.globalCompositeOperation = "source-over";
        }
      });
    }
  }

  private drawPuffs(proj: (x: number, y: number, z: number) => P, laneZ: number) {
    const ctx = this.ctx;
    const smoke = this.glow("rgba(205,205,214,1)");
    for (const p of this.puffs) {
      if (Math.abs(p.z - laneZ) > 2.5) continue;
      const q = proj(p.x, p.y, p.z);
      if (!q.ok) continue;
      const r = p.r * q.s;
      ctx.globalAlpha = 0.34 * (1 - p.life / p.max);
      ctx.drawImage(smoke, q.x - r, q.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  private car(c: SceneCar, lane: "me" | "opp", nose: number, proj: (x: number, y: number, z: number) => P, time: number) {
    const ctx = this.ctx;
    const dims = c.cfg.type === "bike" ? CAR.bike : CAR.car;
    const z = LANE_Z[lane];
    const rear = nose - dims.len;
    // headlight beams on the track ahead
    const lampP = proj(nose, 0, z);
    const beamP = proj(nose + 9, 0, z);
    const a = proj(nose, 0, z - dims.w * 0.4);
    const b = proj(nose + 9, 0, z - dims.w * 1.2);
    const cc = proj(nose + 9, 0, z + dims.w * 1.2);
    const d = proj(nose, 0, z + dims.w * 0.4);
    if (lampP.ok && beamP.ok && a.ok && b.ok && cc.ok && d.ok) {
      const g = ctx.createLinearGradient(lampP.x, lampP.y, beamP.x, beamP.y);
      g.addColorStop(0, "rgba(255,250,235,0.18)");
      g.addColorStop(1, "rgba(255,250,235,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(cc.x, cc.y);
      ctx.lineTo(d.x, d.y);
      ctx.fill();
    }
    // shadow and underglow on the ground
    const s0 = proj(rear - 0.3, 0, z - dims.w * 0.75);
    const s1 = proj(nose + 0.3, 0, z + dims.w * 0.75);
    if (s0.ok && s1.ok) {
      const top = Math.min(s0.y, s1.y);
      const hgt = Math.abs(s1.y - s0.y);
      ctx.globalAlpha = 0.75;
      ctx.drawImage(this.glow("rgba(0,0,0,1)"), s0.x, top, s1.x - s0.x, hgt * 1.4);
      ctx.globalAlpha = 0.45;
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(this.glow(rgba(c.cfg.ui.accent)), s0.x - 0.4 * s0.s, top - 0.3 * s0.s, s1.x - s0.x + 0.8 * s0.s, hgt * 1.6);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    // the car on its roof plane, mapped by three corners (rear squats a touch under power)
    const sprite = this.top(c.cfg);
    const hy = dims.h * (1 - this.squat[lane] * 0.03);
    const rf = proj(rear, hy, z - dims.w / 2);
    const nf = proj(nose, hy, z - dims.w / 2);
    const rn = proj(rear, hy, z + dims.w / 2);
    if (rf.ok && nf.ok && rn.ok) {
      ctx.save();
      ctx.transform((nf.x - rf.x) / sprite.width, (nf.y - rf.y) / sprite.width, (rn.x - rf.x) / sprite.height, (rn.y - rf.y) / sprite.height, rf.x, rf.y);
      ctx.drawImage(sprite, 0, 0);
      ctx.restore();
    }
    // taillights (brighter on the brakes) and exhaust flames at the back
    const brake = this.braking[lane];
    const tail = this.glow("rgba(255,40,30,1)");
    ctx.globalCompositeOperation = "lighter";
    for (const side of c.cfg.type === "bike" ? [0] : [-0.3, 0.3]) {
      const p = proj(rear, hy * 0.8, z + side * dims.w);
      if (!p.ok) continue;
      const gs = (0.7 + 1.1 * brake) * p.s;
      ctx.globalAlpha = 0.55 + 0.45 * brake;
      ctx.drawImage(tail, p.x - gs / 2, p.y - gs / 2, gs, gs);
      if (c.flame > 0.02) {
        const q = proj(rear - 0.5 - 0.4 * c.flame, 0.4, z + side * dims.w * 0.6);
        if (q.ok) {
          const fs = (0.8 + 1.2 * c.flame) * (0.85 + 0.15 * Math.sin(time * 80)) * q.s;
          ctx.globalAlpha = Math.min(1, c.flame * 1.2);
          ctx.drawImage(this.glow("rgba(120,170,255,1)"), q.x - fs / 2, q.y - fs / 2, fs, fs);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}
