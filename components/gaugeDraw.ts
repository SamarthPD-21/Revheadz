export const START_ANGLE = Math.PI * 0.75; // 135deg: bottom-left
export const SWEEP = Math.PI * 1.5; // 270deg

export const COLORS = {
  faceInner: "#1a1a22",
  faceOuter: "#0c0c11",
  ring: "#2c2c38",
  track: "rgba(255,255,255,0.07)",
  tick: "#7d7d8f",
  label: "#e4e4ec",
  dim: "#8a8a9c",
  needle: "#ff4d2e",
  red: "#ff2d2d",
};

export function angleFor(value: number, max: number): number {
  return START_ANGLE + SWEEP * Math.min(1, Math.max(0, value / max));
}

export interface DialOptions {
  max: number;
  value: number;
  majorStep: number;
  labelDivisor: number;
  minorPerMajor: number;
  accent: string;
  redFrom?: number;
  /** 0-1 extra glow on the red zone (limiter flash). */
  redPulse?: number;
}

/** Face, lit progress arc, ticks, labels and red zone. The needle is drawn separately. */
export function drawDial(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, o: DialOptions): void {
  ctx.save();
  const face = ctx.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
  face.addColorStop(0, COLORS.faceInner);
  face.addColorStop(1, COLORS.faceOuter);
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.018);
  ctx.strokeStyle = COLORS.ring;
  ctx.stroke();

  // track + lit progress arc
  const arcR = r * 0.9;
  const arcW = r * 0.055;
  ctx.lineCap = "round";
  ctx.lineWidth = arcW;
  ctx.strokeStyle = COLORS.track;
  ctx.beginPath();
  ctx.arc(cx, cy, arcR, START_ANGLE, START_ANGLE + SWEEP);
  ctx.stroke();
  if (o.value > 0) {
    ctx.strokeStyle = o.accent;
    ctx.shadowColor = o.accent;
    ctx.shadowBlur = r * 0.12;
    ctx.beginPath();
    ctx.arc(cx, cy, arcR, START_ANGLE, angleFor(o.value, o.max));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.lineCap = "butt";

  if (o.redFrom !== undefined) {
    ctx.strokeStyle = COLORS.red;
    ctx.globalAlpha = 0.55 + 0.45 * (o.redPulse ?? 0);
    ctx.shadowColor = COLORS.red;
    ctx.shadowBlur = r * 0.15 * (o.redPulse ?? 0);
    ctx.lineWidth = r * 0.04;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.8, angleFor(o.redFrom, o.max), angleFor(o.max, o.max));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  const minorStep = o.majorStep / o.minorPerMajor;
  ctx.font = `600 ${Math.round(r * 0.12)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let v = 0; v <= o.max + 1e-6; v += minorStep) {
    const major = Math.abs(v / o.majorStep - Math.round(v / o.majorStep)) < 1e-6;
    const a = angleFor(v, o.max);
    const inRed = o.redFrom !== undefined && v >= o.redFrom;
    const inner = r * (major ? 0.7 : 0.75);
    const outer = r * 0.79;
    ctx.strokeStyle = inRed ? COLORS.red : major ? COLORS.label : COLORS.tick;
    ctx.lineWidth = major ? Math.max(2, r * 0.018) : Math.max(1, r * 0.007);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.stroke();
    if (major && v > 0) {
      ctx.fillStyle = inRed ? COLORS.red : COLORS.label;
      ctx.fillText(String(Math.round(v / o.labelDivisor)), cx + Math.cos(a) * r * 0.57, cy + Math.sin(a) * r * 0.57);
    }
  }
  ctx.restore();
}

export function drawNeedle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, angle: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = COLORS.needle;
  ctx.shadowColor = COLORS.needle;
  ctx.shadowBlur = r * 0.1;
  ctx.beginPath();
  ctx.moveTo(r * 0.28, -r * 0.02);
  ctx.lineTo(r * 0.86, -r * 0.004);
  ctx.lineTo(r * 0.86, r * 0.004);
  ctx.lineTo(r * 0.28, r * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Frame-rate independent exponential smoothing. */
export const smooth = (current: number, target: number, dt: number, rate: number): number =>
  current + (target - current) * (1 - Math.exp(-dt * rate));
