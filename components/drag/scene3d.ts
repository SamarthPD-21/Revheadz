import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { EIGHTH_MILE_M, QUARTER_MILE_M, SIXTY_FT_M } from "../../lib/drag/race";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { BODIES } from "../Silhouette";
import type { SceneCar, SceneFrame } from "./scene";

/**
 * The drag strip in 3D (three.js): a night-time quarter mile with bloom. Cars are the
 * garage silhouettes extruded into bodies with glossy paint, glowing lights and spinning
 * wheels; a cinematic camera orbits the start while staging, chases your car down the strip
 * (widening its field of view with speed) and tracks alongside during the cool-down.
 */

const LANE_Z = { me: 2.0, opp: -2.0 };
const CAR_LEN_M = { car: 4.6, bike: 2.2 };
const CAR_W_M = { car: 1.85, bike: 0.7 };
const GROUND_Y_SIL = 68; // silhouette y where the wheels touch the ground

/** Parses the silhouettes' path syntax (absolute M / L / Q / Z) into shapes, in metres. */
function shapesFrom(d: string, k: number, frontX: number): THREE.Shape[] {
  const tok = d.match(/[MLQZ]|-?\d+(\.\d+)?/g) ?? [];
  const shapes: THREE.Shape[] = [];
  let shape: THREE.Shape | null = null;
  const X = (x: number) => (frontX - x) * k;
  const Y = (y: number) => (GROUND_Y_SIL - y) * k;
  let i = 0;
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    const c = tok[i++];
    if (c === "M") {
      shape = new THREE.Shape();
      shapes.push(shape);
      const x = num();
      const y = num();
      shape.moveTo(X(x), Y(y));
    } else if (c === "L" && shape) {
      const x = num();
      const y = num();
      shape.lineTo(X(x), Y(y));
    } else if (c === "Q" && shape) {
      const cx = num();
      const cy = num();
      const x = num();
      const y = num();
      shape.quadraticCurveTo(X(cx), Y(cy), X(x), Y(y));
    } else if (c === "Z" && shape) {
      shape.closePath();
    }
  }
  return shapes;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Turns an extruded side profile into something car-shaped: the glasshouse narrows above the
 * beltline, the nose and tail round off, and the upper body is darkened into tinted glass
 * (vertex colours multiply the paint).
 */
function shapeBody(geo: THREE.BufferGeometry) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const belt = 0.6;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    let z = pos.getZ(i);
    const h = (y - bb.min.y) / (bb.max.y - bb.min.y);
    const xn = (x - bb.min.x) / (bb.max.x - bb.min.x);
    z *= 1 - 0.34 * smoothstep(belt - 0.08, 1, h); // tumblehome
    z *= 0.84 + 0.16 * smoothstep(0, 0.14, Math.min(xn, 1 - xn)); // rounded nose and tail
    pos.setZ(i, z);
    const glass = h > belt + 0.04 && xn > 0.18 && xn < 0.82 ? 0.07 : 1;
    colors.set([glass, glass, glass * 1.1], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
}

function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const softDot = () =>
  canvasTexture(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  });

interface CarRig {
  id: string;
  group: THREE.Group;
  pivot: THREE.Group;
  wheels: THREE.Group[];
  wheelR: number;
  flame: THREE.Mesh;
  flameMat: THREE.MeshBasicMaterial;
  glowMat: THREE.MeshBasicMaterial;
  rearX: number;
  lenM: number;
}

interface Puff {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  life: number;
  max: number;
  vx: number;
  vy: number;
  vz: number;
  grow: number;
}

export class DragScene3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);
  private readonly cars = new Map<"me" | "opp", CarRig>();
  private readonly bulbs: { me: THREE.MeshStandardMaterial[]; opp: THREE.MeshStandardMaterial[] } = { me: [], opp: [] };
  private readonly puffs: Puff[] = [];
  private puffIdx = 0;
  private readonly timing: { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; key: string };
  private readonly disposables: { dispose(): void }[] = [];
  private lastTime = 0;
  /** Camera position and aim, relative to your car's x. */
  private camPos = new THREE.Vector3(8, 2.4, 11);
  private camLook = new THREE.Vector3(-2, 0.8, 0);
  private prevSpeed = { me: 0, opp: 0 };
  private pitch = { me: 0, opp: 0 };
  private size = { w: 0, h: 0 };

  constructor(canvas: HTMLCanvasElement) {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(coarse ? 1.5 : 2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    const scene = this.scene;
    scene.background = new THREE.Color(0x05050c);
    scene.fog = new THREE.FogExp2(0x07060f, 0.0095);
    scene.add(new THREE.HemisphereLight(0x8c88b8, 0x0b0a12, 0.9));
    const moon = new THREE.DirectionalLight(0xdfe6ff, 1.6);
    moon.position.set(-30, 40, 25);
    scene.add(moon);
    const fill = new THREE.DirectionalLight(0xffd7a8, 0.6);
    fill.position.set(40, 20, -30);
    scene.add(fill);

    this.buildTrack();
    this.buildTree();
    this.timing = this.buildFinish();
    this.buildPuffs();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  // ---------------------------------------------------------------- world

  private track<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private buildTrack() {
    const s = this.scene;
    // asphalt with grain
    const asphalt = this.track(
      canvasTexture(256, 256, (c) => {
        c.fillStyle = "#1a191f";
        c.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 5000; i++) {
          const v = 20 + Math.random() * 30;
          c.fillStyle = `rgba(${v},${v},${v + 6},0.5)`;
          c.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
        }
      }),
    );
    asphalt.wrapS = asphalt.wrapT = THREE.RepeatWrapping;
    asphalt.repeat.set(160, 12);
    const ground = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(1400, 120)),
      this.track(new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.92, metalness: 0.05, color: 0x9a98a6 })),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(300, 0, 0);
    s.add(ground);

    // rubbered-in launch area in each lane
    const rubber = this.track(
      canvasTexture(512, 32, (c) => {
        const g = c.createLinearGradient(0, 0, 512, 0);
        g.addColorStop(0, "rgba(0,0,0,0.85)");
        g.addColorStop(0.35, "rgba(0,0,0,0.55)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = g;
        c.fillRect(0, 0, 512, 32);
      }),
    );
    for (const z of [LANE_Z.me, LANE_Z.opp]) {
      const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(90, 2.4)), this.track(new THREE.MeshBasicMaterial({ map: rubber, transparent: true, depthWrite: false })));
      m.rotation.x = -Math.PI / 2;
      m.position.set(40, 0.004, z);
      s.add(m);
    }

    // centre line, lane edges, and short dashes that stream past (the main sense of speed)
    const line = (z: number, color: number, width: number) => {
      const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(1000, width)), this.track(new THREE.MeshBasicMaterial({ color })));
      m.rotation.x = -Math.PI / 2;
      m.position.set(450, 0.006, z);
      s.add(m);
    };
    line(0, 0xe3b72a, 0.12);
    line(4.1, 0xcfcfd6, 0.1);
    line(-4.1, 0xcfcfd6, 0.1);
    const dashGeo = this.track(new THREE.PlaneGeometry(1.6, 0.08));
    const dashMat = this.track(new THREE.MeshBasicMaterial({ color: 0x75747f }));
    const dashes = new THREE.InstancedMesh(dashGeo, dashMat, 2 * 160);
    const o = new THREE.Object3D();
    let n = 0;
    for (const z of [3.4, -3.4]) {
      for (let i = 0; i < 160; i++) {
        o.position.set(-30 + i * 3.5, 0.007, z);
        o.rotation.set(-Math.PI / 2, 0, 0);
        o.updateMatrix();
        dashes.setMatrixAt(n++, o.matrix);
      }
    }
    s.add(dashes);

    // start line
    const start = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.25, 8.2)), this.track(new THREE.MeshBasicMaterial({ color: 0xf4f4f5 })));
    start.rotation.x = -Math.PI / 2;
    start.position.set(0, 0.008, 0);
    s.add(start);

    // side walls with ad boards
    const ads = this.track(
      canvasTexture(1024, 64, (c) => {
        const items: [string, string, string][] = [
          ["REVHEADZ", "#f97316", "#0b0b0f"],
          ["QUARTER MILE", "#1f1d2a", "#f4f4f5"],
          ["DRAG NIGHT", "#a3e635", "#0b0b0f"],
          ["REVHEADZ", "#1f1d2a", "#f97316"],
        ];
        items.forEach(([t, bg, fg], i) => {
          c.fillStyle = bg;
          c.fillRect(i * 256 + 4, 6, 248, 52);
          c.fillStyle = fg;
          c.font = "italic 900 30px system-ui, sans-serif";
          c.textBaseline = "middle";
          c.fillText(t, i * 256 + 18, 33);
        });
      }),
    );
    ads.wrapS = THREE.RepeatWrapping;
    ads.repeat.set(40, 1);
    const wallMat = this.track(new THREE.MeshStandardMaterial({ color: 0x3a3944, roughness: 0.85 }));
    const adMat = this.track(new THREE.MeshStandardMaterial({ map: ads, emissive: 0xffffff, emissiveMap: ads, emissiveIntensity: 0.35, roughness: 0.6 }));
    for (const z of [6.3, -6.3]) {
      const wall = new THREE.Mesh(this.track(new THREE.BoxGeometry(1000, 1.1, 0.35)), wallMat);
      wall.position.set(450, 0.55, z);
      s.add(wall);
      const ad = new THREE.Mesh(this.track(new THREE.PlaneGeometry(1000, 0.7)), adMat);
      ad.position.set(450, 0.6, z - Math.sign(z) * 0.18);
      if (z > 0) ad.rotation.y = Math.PI;
      s.add(ad);
    }

    // distance boards on the far wall
    for (const [m, label] of [[SIXTY_FT_M, "60 FT"], [100.584, "330 FT"], [EIGHTH_MILE_M, "1/8 MILE"], [304.8, "1000 FT"]] as [number, string][]) {
      const tex = this.track(
        canvasTexture(256, 96, (c) => {
          c.fillStyle = "#f4f4f5";
          c.fillRect(0, 0, 256, 96);
          c.fillStyle = "#0b0b0f";
          c.font = "900 44px system-ui, sans-serif";
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.fillText(label, 128, 50);
        }),
      );
      const board = new THREE.Mesh(this.track(new THREE.PlaneGeometry(2.6, 1)), this.track(new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5 })));
      board.position.set(m, 2.0, -6.1);
      s.add(board);
      const post = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.1, 1.2, 0.1)), wallMat);
      post.position.set(m, 1.1, -6.15);
      s.add(post);
    }

    // light towers both sides: the lamps bloom
    const poleGeo = this.track(new THREE.CylinderGeometry(0.12, 0.18, 16, 8));
    const lampGeo = this.track(new THREE.BoxGeometry(1.8, 0.5, 0.9));
    const poleMat = this.track(new THREE.MeshStandardMaterial({ color: 0x2b2a33, roughness: 0.7, metalness: 0.4 }));
    const lampMat = this.track(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.95, 0.82).multiplyScalar(4) }));
    const count = 2 * 16;
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, count);
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, count);
    n = 0;
    for (const z of [11, -11]) {
      for (let i = 0; i < 16; i++) {
        const x = -40 + i * 34;
        o.rotation.set(0, 0, 0);
        o.position.set(x, 8, z);
        o.updateMatrix();
        poles.setMatrixAt(n, o.matrix);
        o.position.set(x, 16.1, z);
        o.updateMatrix();
        lamps.setMatrixAt(n, o.matrix);
        n++;
      }
    }
    s.add(poles, lamps);
    // pools of light on the track under the towers
    const pool = this.track(softDot());
    const poolMat = this.track(new THREE.MeshBasicMaterial({ map: pool, transparent: true, opacity: 0.09, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xfff1d6 }));
    const poolGeo = this.track(new THREE.PlaneGeometry(26, 26));
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(poolGeo, poolMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(-40 + i * 34, 0.01, 0);
      s.add(m);
    }

    // grandstand behind the far wall, with a crowd of points
    const standMat = this.track(new THREE.MeshStandardMaterial({ color: 0x15141c, roughness: 0.95 }));
    for (let t = 0; t < 6; t++) {
      const step = new THREE.Mesh(this.track(new THREE.BoxGeometry(520, 0.9 + t * 0.9, 2.2)), standMat);
      step.position.set(220, (0.9 + t * 0.9) / 2, -14 - t * 2.2);
      s.add(step);
    }
    const crowdN = 5000;
    const pos = new Float32Array(crowdN * 3);
    const col = new Float32Array(crowdN * 3);
    for (let i = 0; i < crowdN; i++) {
      const t = Math.floor(Math.random() * 6);
      pos[i * 3] = -30 + Math.random() * 520;
      pos[i * 3 + 1] = 0.9 + t * 0.9 + 0.4 + Math.random() * 0.3;
      pos[i * 3 + 2] = -14 - t * 2.2 + (Math.random() - 0.5) * 1.6;
      const c = new THREE.Color().setHSL(Math.random(), 0.35, 0.35 + Math.random() * 0.3);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const crowdGeo = this.track(new THREE.BufferGeometry());
    crowdGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    crowdGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    s.add(new THREE.Points(crowdGeo, this.track(new THREE.PointsMaterial({ size: 0.35, vertexColors: true, map: this.track(softDot()), transparent: true, depthWrite: false }))));

    // stars
    const starN = 900;
    const sp = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const a = Math.random() * Math.PI;
      const r = 500;
      sp.set([Math.cos(a) * r + 200, 40 + Math.random() * 220, -Math.sin(a) * r * 0.6 - 120], i * 3);
    }
    const starGeo = this.track(new THREE.BufferGeometry());
    starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    s.add(new THREE.Points(starGeo, this.track(new THREE.PointsMaterial({ size: 1.2, color: 0xb9b6d6, sizeAttenuation: false, fog: false }))));
  }

  private buildTree() {
    const g = new THREE.Group();
    g.position.set(-8, 0, 0);
    const mat = this.track(new THREE.MeshStandardMaterial({ color: 0x1d1c24, roughness: 0.6, metalness: 0.5 }));
    const pole = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.16, 2.6, 0.16)), mat);
    pole.position.y = 1.3;
    g.add(pole);
    const housing = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.5, 2.3, 1.1)), mat);
    housing.position.y = 3.6;
    g.add(housing);
    const bulbGeo = this.track(new THREE.SphereGeometry(0.11, 16, 12));
    const smallGeo = this.track(new THREE.SphereGeometry(0.07, 12, 10));
    (["opp", "me"] as const).forEach((lane) => {
      const z = lane === "me" ? 0.25 : -0.25;
      for (let i = 0; i < 7; i++) {
        const m = this.track(new THREE.MeshStandardMaterial({ color: 0x111116, emissive: 0x000000, roughness: 0.3 }));
        const bulb = new THREE.Mesh(i < 2 ? smallGeo : bulbGeo, m);
        bulb.position.set(0.26, 4.55 - i * 0.3, z);
        g.add(bulb);
        this.bulbs[lane].push(m);
      }
    });
    this.scene.add(g);
  }

  private buildFinish() {
    const s = this.scene;
    const checker = this.track(
      canvasTexture(64, 512, (c) => {
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 2; x++) {
            c.fillStyle = (x + y) % 2 ? "#f4f4f5" : "#0b0b0f";
            c.fillRect(x * 32, y * 32, 32, 32);
          }
      }),
    );
    const line = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.8, 8.2)), this.track(new THREE.MeshBasicMaterial({ map: checker })));
    line.rotation.x = -Math.PI / 2;
    line.position.set(QUARTER_MILE_M, 0.009, 0);
    s.add(line);
    // timing tower
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const tex = this.track(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(7, 3.5)),
      this.track(new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.1 })),
    );
    board.position.set(QUARTER_MILE_M + 8, 6.5, -7.6);
    s.add(board);
    const legs = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.3, 5, 0.3)), this.track(new THREE.MeshStandardMaterial({ color: 0x2b2a33 })));
    legs.position.set(QUARTER_MILE_M + 8, 2.5, -7.6);
    s.add(legs);
    return { tex, ctx, key: "" };
  }

  private drawTiming(me: SceneCar, opp: SceneCar) {
    const key = `${me.et}|${opp.et}`;
    if (key === this.timing.key) return;
    this.timing.key = key;
    const c = this.timing.ctx;
    c.fillStyle = "#050508";
    c.fillRect(0, 0, 512, 256);
    c.font = "700 22px system-ui, sans-serif";
    c.fillStyle = "#71717a";
    c.fillText("ET", 24, 40);
    c.fillText("KM/H", 24, 160);
    c.font = "700 64px ui-monospace, monospace";
    const lane = (car: SceneCar, x: number) => {
      c.fillStyle = car.et !== null ? car.cfg.ui.accent : "#26252e";
      c.fillText(car.et !== null ? car.et.toFixed(3) : "-.---", x, 110);
      c.fillText(car.trapKmh !== null ? String(Math.round(car.trapKmh)) : "---", x, 228);
    };
    lane(opp, 24);
    lane(me, 270);
    this.timing.tex.needsUpdate = true;
  }

  private buildPuffs() {
    const tex = this.track(softDot());
    for (let i = 0; i < 140; i++) {
      const mat = this.track(new THREE.SpriteMaterial({ map: tex, color: 0xc9c9d2, transparent: true, opacity: 0, depthWrite: false }));
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.puffs.push({ sprite, mat, life: 1, max: 1, vx: 0, vy: 0, vz: 0, grow: 0 });
    }
  }

  private carRig(lane: "me" | "opp", cfg: VehicleConfig): CarRig {
    const existing = this.cars.get(lane);
    if (existing && existing.id === cfg.id) return existing;
    if (existing) this.scene.remove(existing.group);

    const b = BODIES[cfg.ui.silhouette];
    const bike = cfg.type === "bike";
    const lenM = bike ? CAR_LEN_M.bike : CAR_LEN_M.car;
    const width = bike ? CAR_W_M.bike : CAR_W_M.car;
    const k = lenM / 186;
    const frontX = 6;
    const accent = new THREE.Color(cfg.ui.accent);

    const group = new THREE.Group();
    const pivot = new THREE.Group();
    const rearWheel = b.wheels[1];
    const rearX = (frontX - rearWheel[0]) * k;
    pivot.position.set(rearX, 0, 0);
    group.add(pivot);
    const body = new THREE.Group();
    body.position.set(-rearX, 0, 0);
    pivot.add(body);

    const shapes = shapesFrom(b.body, k, frontX);
    const geo = this.track(new THREE.ExtrudeGeometry(shapes, { depth: width, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 3, curveSegments: 14 }));
    geo.translate(0, 0, -width / 2);
    if (!bike) shapeBody(geo);
    const paint = this.track(
      new THREE.MeshPhysicalMaterial({
        color: accent,
        vertexColors: !bike,
        metalness: 0.55,
        roughness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
        emissive: accent,
        emissiveIntensity: 0.05,
      }),
    );
    const shell = new THREE.Mesh(geo, paint);
    body.add(shell);
    // lights (bright enough to bloom)
    const head = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.97, 0.88).multiplyScalar(3.5) });
    const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.1, 0.08).multiplyScalar(3) });
    this.track(head);
    this.track(tail);
    const lampGeo = this.track(new THREE.BoxGeometry(0.06, 0.07, bike ? 0.12 : 0.32));
    for (const side of bike ? [0] : [-1, 1]) {
      const h = new THREE.Mesh(lampGeo, head);
      h.position.set(-0.08, (GROUND_Y_SIL - 47) * k, side * (width / 2 - 0.22));
      body.add(h);
      const t = new THREE.Mesh(lampGeo, tail);
      t.position.set(-lenM + 0.06, (GROUND_Y_SIL - 45) * k, side * (width / 2 - 0.22));
      body.add(t);
    }

    // wheels
    const tyreGeo = this.track(new THREE.CylinderGeometry(1, 1, 1, 28));
    tyreGeo.rotateX(Math.PI / 2);
    const tyreMat = this.track(new THREE.MeshStandardMaterial({ color: 0x0a0a0d, roughness: 0.85 }));
    const rimMat = this.track(new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.35, metalness: 0.8, roughness: 0.3 }));
    const spokeGeo = this.track(new THREE.BoxGeometry(1, 0.12, 0.04));
    const wheels: THREE.Group[] = [];
    const wheelR = b.r * k;
    for (const [wx, wy] of b.wheels) {
      for (const side of bike ? [0] : [-1, 1]) {
        const w = new THREE.Group();
        w.position.set((frontX - wx) * k, (GROUND_Y_SIL - wy) * k, side * (width / 2 - 0.02));
        const tyre = new THREE.Mesh(tyreGeo, tyreMat);
        tyre.scale.set(wheelR, wheelR, bike ? 0.16 : 0.26);
        w.add(tyre);
        for (let sIdx = 0; sIdx < 5; sIdx++) {
          const sp = new THREE.Mesh(spokeGeo, rimMat);
          sp.scale.set(wheelR * 1.15, 1, 1);
          sp.rotation.z = (sIdx * Math.PI) / 5;
          sp.position.z = side >= 0 ? (bike ? 0.09 : 0.14) : -(bike ? 0.09 : 0.14);
          w.add(sp);
        }
        group.add(w);
        wheels.push(w);
      }
    }

    // underglow and contact shadow
    const glowMat = this.track(new THREE.MeshBasicMaterial({ map: this.track(softDot()), color: accent, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    const glow = new THREE.Mesh(this.track(new THREE.PlaneGeometry(lenM * 1.3, width * 2.2)), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(-lenM / 2, 0.02, 0);
    group.add(glow);
    const shadow = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(lenM * 1.05, width * 1.25)),
      this.track(new THREE.MeshBasicMaterial({ map: this.track(softDot()), color: 0x000000, transparent: true, opacity: 0.75, depthWrite: false })),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(-lenM / 2, 0.015, 0);
    group.add(shadow);

    // exhaust flame (additive, blooms)
    const flameMat = this.track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.75, 2.6), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    const flameGeo = this.track(new THREE.ConeGeometry(0.09, 0.8, 12));
    flameGeo.rotateZ(Math.PI / 2);
    flameGeo.translate(-0.4, 0, 0);
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(-lenM - 0.05, 0.32, bike ? 0 : width / 2 - 0.35);
    body.add(flame);

    group.position.z = LANE_Z[lane];
    this.scene.add(group);
    const rig = { id: cfg.id, group, pivot, wheels, wheelR, flame, flameMat, glowMat, rearX, lenM };
    this.cars.set(lane, rig);
    return rig;
  }

  // ---------------------------------------------------------------- frame

  private placeCar(lane: "me" | "opp", c: SceneCar, dt: number, time: number) {
    const rig = this.carRig(lane, c.cfg);
    const x = c.distM - c.rollBackM;
    rig.group.position.x = x;
    const angle = x / rig.wheelR;
    for (const w of rig.wheels) w.rotation.z = -angle;
    // squat under acceleration, nose-dive under braking
    const a = (c.speedKmh - this.prevSpeed[lane]) / 3.6 / Math.max(dt, 1e-3);
    this.prevSpeed[lane] = c.speedKmh;
    const target = Math.max(-1, Math.min(1, a / 12));
    this.pitch[lane] += (target - this.pitch[lane]) * Math.min(1, dt * 7);
    rig.pivot.rotation.z = this.pitch[lane] * 0.045;
    // flame flicker
    rig.flameMat.opacity = c.flame * (0.7 + 0.3 * Math.sin(time * 90));
    rig.flame.scale.set(0.6 + c.flame * (0.8 + 0.4 * Math.sin(time * 60)), 1 + c.flame, 1 + c.flame);
    // tyre smoke off the line
    if (c.distM > 0.05 && c.distM < 24 && Math.random() < 0.9) {
      const n = Math.random() < (1 - c.distM / 24) ? 2 : 1;
      for (let i = 0; i < n; i++) this.puff(x - rig.lenM * 0.82, LANE_Z[lane]);
    }
  }

  private puff(x: number, z: number) {
    const p = this.puffs[this.puffIdx++ % this.puffs.length];
    p.sprite.visible = true;
    p.sprite.position.set(x + (Math.random() - 0.5) * 0.4, 0.25, z + (Math.random() - 0.5) * 1.2);
    p.life = 0;
    p.max = 1.4 + Math.random() * 1.4;
    p.vx = -1.5 - Math.random() * 2.5;
    p.vy = 0.5 + Math.random() * 0.9;
    p.vz = (Math.random() - 0.5) * 1.5;
    p.grow = 1.6 + Math.random();
    p.sprite.scale.setScalar(0.6);
  }

  private stepPuffs(dt: number) {
    for (const p of this.puffs) {
      if (!p.sprite.visible) continue;
      p.life += dt;
      if (p.life >= p.max) {
        p.sprite.visible = false;
        continue;
      }
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      p.vy *= 0.98;
      p.sprite.scale.multiplyScalar(1 + p.grow * dt * 0.6);
      p.mat.opacity = 0.42 * (1 - p.life / p.max);
    }
  }

  private setBulbs(lane: "me" | "opp", l: SceneCar["lights"]) {
    const on: [boolean, number][] = [
      [l.stage, 0xfde68a],
      [l.stage, 0xfde68a],
      [l.ambers[0], 0xfbbf24],
      [l.ambers[1], 0xfbbf24],
      [l.ambers[2], 0xfbbf24],
      [l.green || l.win, l.win ? 0xffffff : 0x4ade80],
      [l.red, 0xef4444],
    ];
    this.bulbs[lane].forEach((m, i) => {
      const [lit, color] = on[i];
      m.emissive.setHex(lit ? color : 0x000000);
      m.emissiveIntensity = lit ? 4 : 0;
      m.color.setHex(lit ? color : 0x111116);
    });
  }

  draw(f: SceneFrame, w: number, h: number) {
    const dt = Math.min(0.05, Math.max(0, f.time - this.lastTime));
    this.lastTime = f.time;
    if (w !== this.size.w || h !== this.size.h) {
      this.size = { w, h };
      this.renderer.setSize(w, h, false);
      this.composer.setSize(w, h);
      this.bloom.resolution.set(Math.round(w / 2), Math.round(h / 2));
      this.camera.aspect = w / h;
    }

    this.placeCar("me", f.me, dt, f.time);
    this.placeCar("opp", f.opp, dt, f.time);
    this.stepPuffs(dt);
    this.setBulbs("me", f.me.lights);
    this.setBulbs("opp", f.opp.lights);
    this.drawTiming(f.me, f.opp);

    // camera: orbit the start while staging, chase down the strip, track alongside after the line
    const me = f.me;
    const carX = me.distM - me.rollBackM;
    const portrait = h > w;
    const launched = me.distM > 0.05;
    const finished = me.et !== null;
    // offsets are relative to the car, so the camera never falls behind however fast it goes
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (!launched) {
      const a = f.time * 0.12;
      pos.set(4 + Math.sin(a) * 3 - carX, 2.1, LANE_Z.me + (portrait ? 13 : 8.5) + Math.cos(a) * 1.2);
      look.set(-3 - carX, 1.1, 0);
    } else if (!finished) {
      pos.set(-(portrait ? 10 : 7.5), 1.9 + Math.min(0.8, me.speedKmh / 300), LANE_Z.me + (portrait ? 7.5 : 4.6));
      look.set(8, 0.9, -0.6);
    } else {
      pos.set(2, 1.5, LANE_Z.me + (portrait ? 10 : 6.8));
      look.set(-1, 0.8, 0);
    }
    const k = 1 - Math.exp(-dt * (launched && !finished ? 5 : 1.6));
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    const shake = f.shake * f.shake;
    this.camera.position.set(carX + this.camPos.x + (Math.random() - 0.5) * 0.25 * shake, this.camPos.y + (Math.random() - 0.5) * 0.18 * shake, this.camPos.z);
    this.camera.lookAt(carX + this.camLook.x, this.camLook.y, this.camLook.z);
    const fov = (portrait ? 68 : 52) + Math.min(22, me.speedKmh / 11);
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
    this.camera.updateProjectionMatrix();

    this.composer.render(dt);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
