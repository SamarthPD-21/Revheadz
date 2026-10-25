import { EIGHTH_MILE_M, QUARTER_MILE_M, SIXTY_FT_M } from "../../lib/drag/race";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { BODIES } from "../Silhouette";

/**
 * The drag strip, drawn side-on on one canvas: a night-time grandstand and light towers in
 * parallax, the far wall with its distance boards, two lanes, the tree at the start line, the
 * timing tower at the finish, and both cars with spinning wheels, squat under load, exhaust
 * flames, tyre smoke and speed streaks. The camera follows your car.
 */

export interface SceneCar {
  cfg: VehicleConfig;
  distM: number;
  speedKmh: number;
  /** Staging roll-in: metres behind the start line (0 = staged). */
  rollBackM: number;
  /** 0-1 exhaust flame (shift crack / limiter). */
  flame: number;
  /** Finish time to show on the timing tower, s. */
  et: number | null;
  trapKmh: number | null;
  /** Lane tree. */
  lights: { stage: boolean; ambers: boolean[]; green: boolean; red: boolean; win: boolean };
}

export interface SceneFrame {
  me: SceneCar;
  opp: SceneCar;
  /** Seconds, for animation. */
  time: number;
  /** 0-1 camera shake this frame. */
  shake: number;
}

interface Particle {
  x: number; // world m
  y: number; // px offset from the lane's ground
  vx: number;
  vy: number;
  r: number;
  life: number;
  max: number;
  lane: 0 | 1;
}

const CAR_LEN_M = { car: 4.6, bike: 2.2 };
const MARKS: [number, string][] = [
  [SIXTY_FT_M, "60 FT"],
  [100.584, "330 FT"],
  [EIGHTH_MILE_M, "1/8 MILE"],
  [304.8, "1000 FT"],
];

/** Deterministic pseudo-random, for crowd dots and board placement. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export class DragScene {
  private readonly bodies = new Map<string, { body: Path2D; extra: Path2D | null }>();
  private particles: Particle[] = [];
  private lastTime = 0;
  private prevSpeed: [number, number] = [0, 0];
  private pitch: [number, number] = [0, 0];

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  private shape(cfg: VehicleConfig) {
    let s = this.bodies.get(cfg.ui.silhouette);
    if (!s) {
      const b = BODIES[cfg.ui.silhouette];
      s = { body: new Path2D(b.body), extra: b.extra ? new Path2D(b.extra) : null };
      this.bodies.set(cfg.ui.silhouette, s);
    }
    return s;
  }

  draw(f: SceneFrame, w: number, h: number) {
    const ctx = this.ctx;
    const dt = Math.min(0.05, Math.max(0, f.time - this.lastTime));
    this.lastTime = f.time;

    // camera: your car sits at 32% across; zooms out a little with speed
    const mySpeed = f.me.speedKmh;
    // ~34 m across on a wide screen; on a narrow (portrait) one, size by height so cars stay readable
    const pxPerM = Math.max(w / 34, h / 24) * (1 - Math.min(0.28, mySpeed / 900));
    const camM = f.me.distM - f.me.rollBackM - (w * 0.32) / pxPerM;
    const sx = (m: number) => (m - camM) * pxPerM;
    const shakeX = (Math.random() - 0.5) * 6 * f.shake;
    const shakeY = (Math.random() - 0.5) * 4 * f.shake;

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(shakeX, shakeY);

    const horizon = h * 0.4;
    const wallTop = h * 0.4;
    const wallBot = h * 0.47;
    const farLane = h * 0.62;
    const nearLane = h * 0.86;

    this.sky(w, horizon, camM, pxPerM, f.time);
    this.wall(w, wallTop, wallBot, camM, pxPerM, sx);
    this.track(w, h, wallBot, farLane, nearLane, camM, pxPerM, sx);
    this.startAndFinish(sx, wallBot, farLane, nearLane, h, f);

    // squat/pitch from acceleration
    [f.opp, f.me].forEach((car, i) => {
      const a = (car.speedKmh - this.prevSpeed[i]) / 3.6 / Math.max(dt, 1e-3);
      this.prevSpeed[i] = car.speedKmh;
      const target = Math.max(-1, Math.min(1, a / 12));
      this.pitch[i] += (target - this.pitch[i]) * Math.min(1, dt * 8);
    });

    this.particlesStep(dt, f);
    this.drawParticles(sx, farLane, nearLane, 0);
    this.car(f.opp, sx, farLane, pxPerM * 0.86, this.pitch[0], f.time);
    this.drawParticles(sx, farLane, nearLane, 1);
    this.car(f.me, sx, nearLane, pxPerM, this.pitch[1], f.time);
    this.streaks(w, h, mySpeed, f.time);

    ctx.restore();
  }

  private sky(w: number, horizon: number, camM: number, pxPerM: number, time: number) {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, "#05050a");
    g.addColorStop(1, "#141020");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, horizon);

    // grandstand (parallax 0.25): tiers with a crowd of dots and the odd phone flash
    const para = camM * pxPerM * 0.25;
    const standTop = horizon * 0.42;
    ctx.fillStyle = "#0d0c14";
    ctx.fillRect(0, standTop, w, horizon - standTop);
    const tile = 520;
    const start = Math.floor(para / tile) - 1;
    for (let k = start; k < start + Math.ceil(w / tile) + 2; k++) {
      const x0 = k * tile - para;
      for (let i = 0; i < 90; i++) {
        const seed = k * 1000 + i;
        const x = x0 + hash(seed) * tile;
        const y = standTop + 6 + hash(seed + 0.5) * (horizon - standTop - 12);
        const flash = hash(seed + Math.floor(time * 2)) > 0.985;
        ctx.fillStyle = flash ? "rgba(255,255,255,0.9)" : `rgba(${120 + hash(seed + 2) * 100},${110 + hash(seed + 3) * 80},${140 + hash(seed + 4) * 90},0.35)`;
        ctx.fillRect(x, y, flash ? 2.5 : 2, flash ? 2.5 : 2);
      }
      // stand roof edge
      ctx.fillStyle = "#1b1826";
      ctx.fillRect(x0, standTop - 4, tile - 30, 4);
    }

    // light towers (parallax 0.5) with soft glows
    const para2 = camM * pxPerM * 0.5;
    const gap = 360;
    const s2 = Math.floor(para2 / gap) - 1;
    for (let k = s2; k < s2 + Math.ceil(w / gap) + 2; k++) {
      const x = k * gap - para2 + 120;
      ctx.fillStyle = "#1a1822";
      ctx.fillRect(x - 2, horizon * 0.12, 4, horizon * 0.88);
      ctx.fillStyle = "#2a2838";
      ctx.fillRect(x - 16, horizon * 0.1, 32, 8);
      const glow = ctx.createRadialGradient(x, horizon * 0.12, 2, x, horizon * 0.12, 90);
      glow.addColorStop(0, "rgba(255,244,214,0.55)");
      glow.addColorStop(1, "rgba(255,244,214,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(x - 90, horizon * 0.12 - 90, 180, 180);
    }
  }

  private wall(w: number, top: number, bot: number, camM: number, pxPerM: number, sx: (m: number) => number) {
    const ctx = this.ctx;
    ctx.fillStyle = "#24232b";
    ctx.fillRect(0, top, w, bot - top);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, top, w, 2);
    // sponsor-style boards every 24 m (world-fixed)
    const first = Math.floor(camM / 24) - 1;
    for (let k = first; k < first + Math.ceil(w / pxPerM / 24) + 3; k++) {
      const x = sx(k * 24);
      const bw = 15 * pxPerM;
      ctx.fillStyle = k % 3 === 0 ? "#f97316" : k % 3 === 1 ? "#1f1d2a" : "#a3e635";
      ctx.globalAlpha = k % 3 === 1 ? 1 : 0.85;
      ctx.fillRect(x, top + 5, bw, bot - top - 10);
      ctx.globalAlpha = 1;
      ctx.fillStyle = k % 3 === 1 ? "#f4f4f5" : "#0b0b0f";
      ctx.font = `900 italic ${Math.max(9, (bot - top) * 0.42)}px system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(k % 3 === 2 ? "QUARTER MILE" : "REVHEADZ", x + 8, (top + bot) / 2);
    }
    // distance boards
    for (const [m, label] of MARKS) {
      const x = sx(m);
      if (x < -80 || x > w + 80) continue;
      ctx.fillStyle = "#f4f4f5";
      ctx.fillRect(x - 30, top - 26, 60, 22);
      ctx.fillStyle = "#0b0b0f";
      ctx.font = "800 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, x, top - 15);
      ctx.textAlign = "left";
      ctx.fillStyle = "#3f3e48";
      ctx.fillRect(x - 1.5, top - 4, 3, 6);
    }
  }

  private track(w: number, h: number, top: number, far: number, near: number, camM: number, pxPerM: number, sx: (m: number) => number) {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, top, 0, h);
    g.addColorStop(0, "#17161c");
    g.addColorStop(1, "#0c0c10");
    ctx.fillStyle = g;
    ctx.fillRect(0, top, w, h - top);
    // rubbered-in launch area: dark streaks in each lane for the first 60 m
    for (const lane of [far, near]) {
      const x0 = sx(-2);
      const x1 = sx(70);
      const rg = ctx.createLinearGradient(x0, 0, x1, 0);
      rg.addColorStop(0, "rgba(0,0,0,0.55)");
      rg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(x0, lane - 14, x1 - x0, 12);
    }
    // centre line and lane edges
    const mid = (far + near) / 2 - 6;
    ctx.fillStyle = "rgba(250,204,21,0.55)";
    ctx.fillRect(0, mid, w, 2);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(0, top + 8, w, 2);
    ctx.fillRect(0, h - 10, w, 2);
    // dashed guide lines (scroll with the world: this is what sells the speed)
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    const dash = 6;
    const first = Math.floor(camM / dash) - 1;
    for (let k = first; k < first + Math.ceil(w / pxPerM / dash) + 3; k++) {
      const x = sx(k * dash);
      ctx.fillRect(x, (top + far) / 2 + 4, 2.2 * pxPerM, 1.5);
      ctx.fillRect(x, (near + h) / 2 + 2, 2.2 * pxPerM, 1.5);
    }
  }

  private startAndFinish(sx: (m: number) => number, top: number, far: number, near: number, h: number, f: SceneFrame) {
    const ctx = this.ctx;
    // start line
    const x0 = sx(0);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(x0 - 1.5, top + 8, 3, h - top - 18);

    // the christmas tree, standing on the centre line just behind the start
    const tx = sx(-7.5); // behind the staged cars (their tails are ~4.6 m back)
    const mid = (far + near) / 2 - 6;
    const bulbR = Math.max(4, h * 0.011);
    const colW = bulbR * 2.8;
    ctx.fillStyle = "#2a2833";
    ctx.fillRect(tx - 2, mid - bulbR * 22, 4, bulbR * 22);
    ctx.fillStyle = "#0a0a0d";
    ctx.beginPath();
    ctx.roundRect(tx - colW - bulbR, mid - bulbR * 21, colW * 2 + bulbR * 2, bulbR * 17, bulbR);
    ctx.fill();
    const col = (lane: SceneCar["lights"], cx: number) => {
      const rows: [boolean, string][] = [
        [lane.stage, "#fde68a"],
        [lane.stage, "#fde68a"],
        [lane.ambers[0], "#fbbf24"],
        [lane.ambers[1], "#fbbf24"],
        [lane.ambers[2], "#fbbf24"],
        lane.red ? [true, "#ef4444"] : [lane.ambers[3], "#fbbf24"],
        [lane.green || lane.win, lane.win ? "#f4f4f5" : "#4ade80"],
      ];
      rows.forEach(([on, c], i) => {
        const y = mid - bulbR * 19 + i * bulbR * 2.3;
        ctx.beginPath();
        ctx.arc(cx, y, i < 2 ? bulbR * 0.6 : bulbR, 0, Math.PI * 2);
        ctx.fillStyle = on ? c : "#1c1b22";
        if (on) {
          ctx.shadowColor = c;
          ctx.shadowBlur = bulbR * 4;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
      });
    };
    col(f.opp.lights, tx - colW / 2);
    col(f.me.lights, tx + colW / 2);

    // finish: checkered line and the timing tower with both lanes' numbers
    const xf = sx(QUARTER_MILE_M);
    const sq = 6;
    for (let y = top + 8, i = 0; y < h - 10; y += sq, i++) {
      ctx.fillStyle = i % 2 ? "#f4f4f5" : "#0b0b0f";
      ctx.fillRect(xf - sq, y, sq, sq);
      ctx.fillStyle = i % 2 ? "#0b0b0f" : "#f4f4f5";
      ctx.fillRect(xf, y, sq, sq);
    }
    const tw = 230;
    const tyTop = top - 120;
    ctx.fillStyle = "#0a0a0d";
    ctx.fillRect(xf + 40, tyTop, tw, 100);
    ctx.fillStyle = "#2a2833";
    ctx.fillRect(xf + 40 + tw / 2 - 3, tyTop + 100, 6, top - tyTop - 92);
    ctx.font = "700 10px system-ui, sans-serif";
    ctx.fillStyle = "#71717a";
    ctx.fillText("ET", xf + 52, tyTop + 18);
    ctx.fillText("KM/H", xf + 52, tyTop + 66);
    ctx.font = "700 20px ui-monospace, monospace";
    const lane = (c: SceneCar, x: number, color: string) => {
      ctx.fillStyle = c.et !== null ? color : "#26252e";
      ctx.fillText(c.et !== null ? c.et.toFixed(3) : "-.---", x, tyTop + 42);
      ctx.fillText(c.trapKmh !== null ? String(Math.round(c.trapKmh)) : "---", x, tyTop + 90);
    };
    lane(f.opp, xf + 52, f.opp.cfg.ui.accent);
    lane(f.me, xf + 150, f.me.cfg.ui.accent);
  }

  private car(c: SceneCar, sx: (m: number) => number, ground: number, pxPerM: number, pitch: number, time: number) {
    const ctx = this.ctx;
    const shape = this.shape(c.cfg);
    const b = BODIES[c.cfg.ui.silhouette];
    const lenM = c.cfg.type === "bike" ? CAR_LEN_M.bike : CAR_LEN_M.car;
    const scale = (lenM * pxPerM) / 186;
    const nose = sx(c.distM - c.rollBackM);
    const accent = c.cfg.ui.accent;

    ctx.save();
    // the silhouettes face left: mirror so the nose points down the strip
    ctx.translate(nose, ground);
    ctx.scale(-scale, scale);
    ctx.translate(-8, -68);

    // underglow and shadow
    const glow = ctx.createRadialGradient(100, 64, 4, 100, 64, 110);
    glow.addColorStop(0, `${accent}55`);
    glow.addColorStop(1, `${accent}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(-20, 40, 240, 40);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath();
    ctx.ellipse(100, 68, 92, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // body squats at the rear under acceleration (rear is at +x in silhouette space)
    ctx.save();
    const rear = b.wheels[1];
    ctx.translate(rear[0], rear[1]);
    ctx.rotate((pitch * 2.2 * Math.PI) / 180);
    ctx.translate(-rear[0], -rear[1]);
    const g = ctx.createLinearGradient(0, 20, 0, 60);
    g.addColorStop(0, `${accent}dd`);
    g.addColorStop(1, `${accent}33`);
    ctx.fillStyle = g;
    ctx.fill(shape.body);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.stroke(shape.body);
    if (shape.extra) {
      ctx.lineCap = "round";
      ctx.stroke(shape.extra);
    }
    // headlight (front = low x) and tail light
    ctx.fillStyle = "rgba(255,255,240,0.9)";
    ctx.fillRect(10, 46, 6, 3);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(184, 44, 6, 3);
    ctx.restore();

    // exhaust flame out of the back
    if (c.flame > 0.02) {
      const len = 18 + 26 * c.flame * (0.7 + 0.3 * Math.sin(time * 90));
      const fg = ctx.createLinearGradient(192, 0, 192 + len, 0);
      fg.addColorStop(0, `rgba(255,255,255,${0.9 * c.flame})`);
      fg.addColorStop(0.3, `rgba(96,165,250,${0.8 * c.flame})`);
      fg.addColorStop(1, "rgba(249,115,22,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(192, 50);
      ctx.quadraticCurveTo(192 + len * 0.6, 44, 192 + len, 52);
      ctx.quadraticCurveTo(192 + len * 0.6, 58, 192, 54);
      ctx.fill();
    }

    // wheels, with spokes turning at road speed
    const wheelR = c.cfg.gearbox.wheelRadiusM;
    const angle = (c.distM - c.rollBackM) / wheelR;
    for (const [x, y] of b.wheels) {
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = "#08080b";
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.strokeStyle = `${accent}aa`;
      ctx.lineWidth = 1.2;
      for (let k = 0; k < 5; k++) {
        const a = -angle + (k * Math.PI * 2) / 5; // mirrored space: negate so they roll forwards
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * b.r * 0.2, y + Math.sin(a) * b.r * 0.2);
        ctx.lineTo(x + Math.cos(a) * b.r * 0.62, y + Math.sin(a) * b.r * 0.62);
        ctx.stroke();
      }
      // motion blur ring at speed
      if (c.speedKmh > 40) {
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.25, c.speedKmh / 900)})`;
        ctx.beginPath();
        ctx.arc(x, y, b.r * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private particlesStep(dt: number, f: SceneFrame) {
    // tyre smoke: heavy off the line, a wisp under hard acceleration after
    [f.opp, f.me].forEach((c, lane) => {
      const lenM = c.cfg.type === "bike" ? CAR_LEN_M.bike : CAR_LEN_M.car;
      const rearM = c.distM - c.rollBackM - lenM * 0.82;
      const launching = c.distM > 0.05 && c.distM < 26;
      const rate = launching ? 90 * (1 - c.distM / 26) : 0;
      const n = rate * dt + (Math.random() < (rate * dt) % 1 ? 1 : 0);
      for (let i = 0; i < Math.floor(n); i++) {
        this.particles.push({
          x: rearM + (Math.random() - 0.5) * 0.4,
          y: -2 - Math.random() * 4,
          vx: -2 - Math.random() * 3,
          vy: -12 - Math.random() * 20,
          r: 6 + Math.random() * 6,
          life: 0,
          max: 1.2 + Math.random() * 1.2,
          lane: lane as 0 | 1,
        });
      }
    });
    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy *= 0.97;
      p.r += 22 * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max).slice(-400);
  }

  private drawParticles(sx: (m: number) => number, far: number, near: number, lane: 0 | 1) {
    const ctx = this.ctx;
    for (const p of this.particles) {
      if (p.lane !== lane) continue;
      const a = 0.32 * (1 - p.life / p.max);
      ctx.fillStyle = `rgba(200,200,210,${a})`;
      ctx.beginPath();
      ctx.arc(sx(p.x), (lane ? near : far) + p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private streaks(w: number, h: number, speedKmh: number, time: number) {
    if (speedKmh < 70) return;
    const ctx = this.ctx;
    const k = Math.min(1, (speedKmh - 70) / 200);
    ctx.strokeStyle = `rgba(255,255,255,${0.08 + 0.12 * k})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
      const y = hash(i) * h;
      const len = 40 + 160 * k * hash(i + 9);
      const x = (((hash(i + 3) * w - time * (600 + 1800 * k) * (0.5 + hash(i + 5))) % (w + len)) + w + len) % (w + len) - len;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
    }
  }
}
