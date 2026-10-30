/**
 * The little map in the corner: the road round the car, turned so the way it's pointing is
 * up, with the car near the bottom so most of it shows what's coming. Bends are tinted by how
 * tight they are (white for sweepers, amber, then red for the hairpins), the guardrails run as
 * thin lines along their edges, and a tick marks every 500 m ahead.
 */
export function drawMinimap(canvas: HTMLCanvasElement, route: { x: number; z: number; yaw: number; pts: Float32Array; from: number; s: number }, accent: string): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = canvas.clientWidth;
  if (!size) return;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  const r = size / 2;
  // round, with a dark glassy face
  g.save();
  g.beginPath();
  g.arc(r, r, r - 1, 0, Math.PI * 2);
  g.fillStyle = "rgba(8, 10, 14, 0.62)";
  g.fill();
  g.clip();

  // world to map: the car at (r, size * 0.72), its heading straight up
  const scale = (size * 0.66) / 1300; // px per metre: about 1.3 km ahead fits
  const carX = r;
  const carY = size * 0.72;
  const c = Math.cos(route.yaw);
  const s = Math.sin(route.yaw);
  const pts = route.pts;
  const n = pts.length / 4;
  const mx = new Float32Array(n);
  const my = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 4] - route.x;
    const dz = pts[i * 4 + 1] - route.z;
    // ahead (along the heading) goes up the map, right goes right
    const ahead = dx * c + dz * s;
    const right = -dx * s + dz * c;
    mx[i] = carX + right * scale;
    my[i] = carY - ahead * scale;
  }
  // a faint grid ring every 500 m, for scale
  g.strokeStyle = "rgba(255,255,255,0.06)";
  g.lineWidth = 1;
  for (const m of [500, 1000]) {
    g.beginPath();
    g.arc(carX, carY, m * scale, 0, Math.PI * 2);
    g.stroke();
  }
  // the road: a dark casing, then the surface tinted by how tight each bend is
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = "rgba(0,0,0,0.65)";
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(mx[0], my[0]);
  for (let i = 1; i < n; i++) g.lineTo(mx[i], my[i]);
  g.stroke();
  g.lineWidth = 3.6;
  for (let i = 0; i + 1 < n; i++) {
    const k = Math.abs(pts[i * 4 + 2]);
    g.strokeStyle = k > 1 / 170 ? "#f87171" : k > 1 / 320 ? "#fbbf24" : "#e4e4e7";
    g.beginPath();
    g.moveTo(mx[i], my[i]);
    g.lineTo(mx[i + 1], my[i + 1]);
    g.stroke();
  }
  // guardrails along the edges
  g.lineWidth = 1.2;
  g.strokeStyle = "rgba(186, 230, 253, 0.85)";
  for (const [bit, side] of [[1, -1], [2, 1]] as const) {
    g.beginPath();
    let open = false;
    for (let i = 0; i + 1 < n; i++) {
      if (!(pts[i * 4 + 3] & bit)) {
        open = false;
        continue;
      }
      const tx = mx[i + 1] - mx[i];
      const ty = my[i + 1] - my[i];
      const len = Math.hypot(tx, ty) || 1;
      const ox = (-ty / len) * 4 * -side;
      const oy = (tx / len) * 4 * -side;
      if (!open) g.moveTo(mx[i] + ox, my[i] + oy);
      g.lineTo(mx[i + 1] + ox, my[i + 1] + oy);
      open = true;
    }
    g.stroke();
  }
  // a tick every 500 m along the road ahead
  const { from, s: carS } = route;
  g.fillStyle = "rgba(255,255,255,0.75)";
  g.font = "600 8px ui-monospace, monospace";
  for (let i = 0; i < n; i++) {
    const at = from + i * 10;
    if (at > carS + 100 && Math.floor((at - carS) / 500) !== Math.floor((at - 10 - carS) / 500)) {
      g.beginPath();
      g.arc(mx[i], my[i], 2.2, 0, Math.PI * 2);
      g.fill();
      g.fillText(`${((at - carS) / 1000).toFixed(1)}`, mx[i] + 5, my[i] + 3);
    }
  }
  g.restore();

  // the car: an arrow pointing up
  g.save();
  g.translate(carX, carY);
  g.fillStyle = accent;
  g.strokeStyle = "rgba(0,0,0,0.8)";
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(0, -8);
  g.lineTo(6, 6);
  g.lineTo(0, 3);
  g.lineTo(-6, 6);
  g.closePath();
  g.stroke();
  g.fill();
  g.restore();

  // the rim
  g.beginPath();
  g.arc(r, r, r - 1, 0, Math.PI * 2);
  g.strokeStyle = "rgba(255,255,255,0.14)";
  g.lineWidth = 1.5;
  g.stroke();
}
