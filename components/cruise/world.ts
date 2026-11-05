import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { hash2, mulberry32 } from "../../lib/cruise/noise";
import { BARRIER_D, Barriers } from "../../lib/cruise/barriers";
import type { Progress } from "../../lib/cruise/progress";
import { ROAD_HALF, ROAD_SECTION, STEP, WATER_Y, bankOf, rightOf, sectionDrop, type RoadPoint } from "../../lib/cruise/road";
import { GRID_M } from "../../lib/cruise/ground";
import { Landscape, RoadDistance, WILD_M } from "../../lib/cruise/terrain";

/** Near ground comes in square tiles this wide, m, with this many quads a side (4 m apart). */
const TILE = 160;
const RES = TILE / GRID_M;
/** The far ground: a coarse lattice out to the horizon, centred on the camera. */
const FAR_STEP = 50;
/** The furthest the far ground ever reaches, in lattice steps either way. */
const FAR_MAX = 110;
/** Far lattice points kept (a few screens' worth); past that the cache starts again. */
const FAR_SLOTS = (FAR_MAX * 2 + 1) ** 2 * 2;

/** How far the world is built out, and how thickly it's planted (the graphics settings). */
export interface Range {
  /** Tiles of detailed ground kept round the camera (a circle this many tiles across, either way). */
  ring: number;
  /** Trees grow only on tiles this close. */
  trees: number;
  /** Grass only this close (0: none). */
  grass: number;
  /** The far ground's reach, in 50 m lattice steps either way. */
  far: number;
  /** Share of the plants drawn (thinned evenly). */
  density: number;
}

export const RANGES = {
  near: { ring: 3, trees: 2, grass: 1.2, far: 44, density: 1 },
  medium: { ring: 4, trees: 3, grass: 1.6, far: 64, density: 1 },
  far: { ring: 5, trees: 4, grass: 2, far: 84, density: 1 },
  extreme: { ring: 7, trees: 5, grass: 2.4, far: FAR_MAX, density: 1 },
} satisfies Record<string, Range>;
/** Road meshes are built 50 samples (100 m) at a time. */
const CHUNK = 50;
/** One dash and gap of the centre line, m (the road texture's length). */
const DASH_PERIOD = 12;

const SECTION = ROAD_SECTION;

type TreeKind = "pine" | "broad" | "bush" | "rock" | "grass";

/** Colours here are picked as sRGB; vertex and instance colours are linear. */
const lin = (c: number) => Math.pow(c, 2.2);
const KINDS: TreeKind[] = ["pine", "broad", "bush", "rock", "grass"];
/** How close new road has to come to built ground to make it rebuild (the road's verge and banks), m. */
const REACH = 60;
/** Instances per kind, at most. */
const CAP: Record<TreeKind, number> = { pine: 70000, broad: 70000, bush: 60000, rock: 40000, grass: 60000 };

/**
 * A built tile's ground, kept so it never has to be worked out again: heights (with their
 * border), colours, and every tree, bush and rock (grass is cheap to redo from these). Saved
 * in the browser between visits by the cruise screen.
 */
export interface TileData {
  hs: Float32Array;
  cols: Float32Array;
  plants: Record<"pine" | "broad" | "bush" | "rock", Float32Array>;
  /** How much road had been laid when it was built (road laid near it since makes it stale). */
  roadSamples: number;
}

interface Tile {
  mesh: THREE.Mesh;
  /** Per kind: x, y, z, yaw, scale, r, g, b for each plant or rock. */
  plants: Record<TreeKind, number[]>;
  /** The same, ready to copy straight into the instanced meshes: 16-float matrices and linear colours. */
  ready?: Record<TreeKind, { mats: Float32Array; cols: Float32Array }>;
}

/** Works out a tile's plant matrices and colours once, so refilling the instances is just copying. */
function readyPlants(plants: Tile["plants"]): NonNullable<Tile["ready"]> {
  const m4 = new THREE.Matrix4();
  const qn = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const out = {} as NonNullable<Tile["ready"]>;
  for (const kind of KINDS) {
    const list = plants[kind];
    const n = list.length / 8;
    const mats = new Float32Array(n * 16);
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const k = i * 8;
      qn.setFromAxisAngle(up, list[k + 3]);
      p.set(list[k], list[k + 1], list[k + 2]);
      sc.setScalar(list[k + 4]);
      m4.compose(p, qn, sc).toArray(mats, i * 16);
      cols[i * 3] = lin(list[k + 5]);
      cols[i * 3 + 1] = lin(list[k + 6]);
      cols[i * 3 + 2] = lin(list[k + 7]);
    }
    out[kind] = { mats, cols };
  }
  return out;
}

/** The road's surface; `solid`: an unbroken centre line (no overtaking), as painted through bends. */
function roadTexture(solid = false): THREE.CanvasTexture {
  const W = 512;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d")!;
  const rand = mulberry32(9);
  // gravel shoulders, then asphalt with a fine grain and a darker, polished band in each wheel track
  x.fillStyle = "#5b5447";
  x.fillRect(0, 0, W, H);
  x.fillStyle = "#38393d";
  x.fillRect(W * 0.1, 0, W * 0.8, H);
  for (const lane of [0.3, 0.7]) {
    for (const off of [-0.07, 0.07]) {
      const g = x.createLinearGradient(W * (lane + off - 0.05), 0, W * (lane + off + 0.05), 0);
      g.addColorStop(0, "rgba(10,10,12,0)");
      g.addColorStop(0.5, "rgba(10,10,12,0.22)");
      g.addColorStop(1, "rgba(10,10,12,0)");
      x.fillStyle = g;
      x.fillRect(W * (lane + off - 0.05), 0, W * 0.1, H);
    }
  }
  for (let i = 0; i < 26000; i++) {
    const u = rand();
    const v = rand() * H;
    const onRoad = u > 0.1 && u < 0.9;
    const l = onRoad ? 32 + rand() * 44 : 70 + rand() * 40;
    x.fillStyle = `rgba(${l + 6},${l + 4},${l},${onRoad ? 0.5 : 0.7})`;
    x.fillRect(u * W, v, onRoad ? 1.5 : 2.5, onRoad ? 1.5 : 2.5);
  }
  // white edge lines, a dashed white centre line (4.5 m of each 12 m)
  x.fillStyle = "rgba(235,235,228,0.92)";
  const edge = 0.1 + 0.8 * (0.42 / (2 * ROAD_HALF));
  x.fillRect(W * edge - 5, 0, 10, H);
  x.fillRect(W * (1 - edge) - 5, 0, 10, H);
  if (solid) x.fillRect(W * 0.5 - 5, 0, 10, H);
  else x.fillRect(W * 0.5 - 5, 0, 10, H * (4.5 / DASH_PERIOD));
  // wear: a few cracks and tar patches
  x.strokeStyle = "rgba(8,8,10,0.6)";
  x.lineWidth = 1.5;
  for (let i = 0; i < 14; i++) {
    let u = W * (0.15 + rand() * 0.7);
    let v = rand() * H;
    x.beginPath();
    x.moveTo(u, v);
    for (let k = 0; k < 6; k++) {
      u += (rand() - 0.5) * 30;
      v += rand() * 40;
      x.lineTo(u, v);
    }
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A yellow board with black chevrons pointing one way (1 right, -1 left), as on a bend's outside. */
function chevronMaterial(dir: 1 | -1): THREE.MeshStandardMaterial {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f5c400";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#121212";
  for (const x0 of [18, 62]) {
    g.beginPath();
    const tip = (x: number) => (dir > 0 ? x : 128 - x);
    g.moveTo(tip(x0), 18);
    g.lineTo(tip(x0 + 22), 18);
    g.lineTo(tip(x0 + 52), 64);
    g.lineTo(tip(x0 + 22), 110);
    g.lineTo(tip(x0), 110);
    g.lineTo(tip(x0 + 30), 64);
    g.closePath();
    g.fill();
  }
  g.strokeStyle = "#121212";
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 122);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // a little retroreflective: the headlights pick it out at night
  return new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.14, roughness: 0.5, side: THREE.DoubleSide });
}

/**
 * A tiling ripple normal map for the water: a handful of sine swells whose wavelengths fit
 * the tile exactly, so it repeats without a seam.
 */
function rippleNormals(): THREE.DataTexture {
  const N = 256;
  const rand = mulberry32(5);
  const waves = Array.from({ length: 18 }, () => ({ kx: Math.round(1 + rand() * 13) * (rand() < 0.5 ? -1 : 1), kz: Math.round(1 + rand() * 13) * (rand() < 0.3 ? -1 : 1), a: 0.3 + rand(), ph: rand() * Math.PI * 2 }));
  const h = (x: number, z: number) => waves.reduce((sum, w) => sum + w.a * Math.sin(((w.kx * x + w.kz * z) / N) * Math.PI * 2 + w.ph) / Math.hypot(w.kx, w.kz), 0);
  const data = new Uint8Array(N * N * 4);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const dx = h(x + 1, z) - h(x - 1, z);
      const dz = h(x, z + 1) - h(x, z - 1);
      const l = Math.hypot(dx * 6, 1, dz * 6);
      const k = (z * N + x) * 4;
      data[k] = (((-dx * 6) / l) * 0.5 + 0.5) * 255;
      data[k + 1] = (((-dz * 6) / l) * 0.5 + 0.5) * 255;
      data[k + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Tiling detail for the ground, worked in world space by the terrain's shader so the land
 * isn't flat colour up close: fine grain (red), clumps (green), broad patches (blue), and
 * scattered wildflower specks (alpha). Periodic value noise, so it repeats without a seam.
 */
function groundDetail(): THREE.DataTexture {
  const N = 256;
  const rand = mulberry32(11);
  const lattices = new Map<number, Float32Array>();
  const lattice = (f: number) => {
    let l = lattices.get(f);
    if (!l) lattices.set(f, (l = Float32Array.from({ length: f * f }, () => rand())));
    return l;
  };
  const value = (x: number, y: number, f: number) => {
    const l = lattice(f);
    const fx = (x / N) * f;
    const fy = (y / N) * f;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const su = u * u * (3 - 2 * u);
    const sv = v * v * (3 - 2 * v);
    const at = (a: number, b: number) => l[((b % f) * f) + (a % f)];
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * su;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * su;
    return top + (bottom - top) * sv;
  };
  const octaves = (x: number, y: number, fs: number[]) => {
    let s = 0;
    let a = 0.5;
    let w = 0;
    for (const f of fs) {
      s += value(x, y, f) * a;
      w += a;
      a *= 0.55;
    }
    return s / w;
  };
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const k = (y * N + x) * 4;
      data[k] = octaves(x, y, [32, 64, 128]) * 255;
      data[k + 1] = octaves(x, y, [6, 12, 24]) * 255;
      data[k + 2] = octaves(x, y, [2, 4, 8]) * 255;
    }
  }
  // wildflowers: small soft dots, their shade (in the dot's value) picking the colour
  for (let n = 0; n < 900; n++) {
    const cx = rand() * N;
    const cy = rand() * N;
    const r = 1.6 + rand() * 1.6;
    const shade = 0.25 + rand() * 0.75;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.hypot(dx, dy) / r;
        if (d > 1) continue;
        const px = (Math.floor(cx + dx) + N) % N;
        const py = (Math.floor(cy + dy) + N) % N;
        const k = (py * N + px) * 4 + 3;
        data[k] = Math.max(data[k], shade * 255 * (1 - d * d));
      }
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Low-poly plants and rocks, each one mesh with its colours baked in. */
function plantGeometry(kind: TreeKind): THREE.BufferGeometry {
  const part = (g: THREE.BufferGeometry, color: [number, number, number], y: number, sx = 1, sy = 1, sz = 1, ox = 0, oz = 0) => {
    g.scale(sx, sy, sz);
    g.translate(ox, y, oz);
    const n = g.index ? g.toNonIndexed() : g;
    const cols = new Float32Array(n.getAttribute("position").count * 3);
    for (let i = 0; i < cols.length; i += 3) cols.set([lin(color[0]), lin(color[1]), lin(color[2])], i);
    n.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    n.deleteAttribute("uv");
    return n;
  };
  const trunk: [number, number, number] = [0.3, 0.2, 0.13];
  let parts: THREE.BufferGeometry[];
  if (kind === "pine") {
    parts = [
      part(new THREE.CylinderGeometry(0.12, 0.2, 1.6, 5), trunk, 0.8),
      part(new THREE.ConeGeometry(1.6, 3, 7), [0.11, 0.25, 0.13], 2.6),
      part(new THREE.ConeGeometry(1.2, 2.5, 7), [0.13, 0.29, 0.15], 4.0),
      part(new THREE.ConeGeometry(0.75, 2, 7), [0.15, 0.32, 0.17], 5.3),
    ];
  } else if (kind === "broad") {
    parts = [
      part(new THREE.CylinderGeometry(0.16, 0.26, 2.4, 6), trunk, 1.2),
      part(new THREE.IcosahedronGeometry(1.9, 0), [0.24, 0.4, 0.14], 3.6, 1, 0.85, 1),
      part(new THREE.IcosahedronGeometry(1.3, 0), [0.28, 0.45, 0.16], 4.3, 1, 0.9, 1, 0.7, 0.4),
      part(new THREE.IcosahedronGeometry(1.2, 0), [0.22, 0.37, 0.13], 3.9, 1, 0.9, 1, -0.6, -0.5),
    ];
  } else if (kind === "grass") {
    // three crossed blades, dark at the root and catching the light at the tips
    parts = [0, 1, 2].map((k) => {
      const a = (k / 3) * Math.PI + 0.3;
      const g = new THREE.BufferGeometry();
      const w = 0.09;
      const c = Math.cos(a) * w;
      const sz = Math.sin(a) * w;
      const lean = 0.12 * (k - 1);
      g.setAttribute("position", new THREE.Float32BufferAttribute([-c, 0, -sz, c, 0, sz, lean, 0.55 + 0.1 * k, lean * 0.5], 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute([0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 1.1, 1.1, 1.1].map(lin), 3));
      return g;
    });
    const merged = mergeGeometries(parts)!;
    merged.computeVertexNormals();
    // blades are lit as if they faced up, so they read as part of the ground, not dark slivers
    const nrm = merged.getAttribute("normal");
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    parts.forEach((p) => p.dispose());
    return merged;
  } else if (kind === "bush") {
    parts = [part(new THREE.IcosahedronGeometry(0.9, 0), [0.36, 0.4, 0.18], 0.45, 1.2, 0.7, 1), part(new THREE.IcosahedronGeometry(0.6, 0), [0.4, 0.43, 0.2], 0.55, 1, 0.8, 1, 0.6, 0.2)];
  } else {
    parts = [part(new THREE.DodecahedronGeometry(1, 0), [0.45, 0.43, 0.41], 0.15, 1.4, 0.75, 1.1)];
  }
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  parts.forEach((p) => p.dispose());
  return g;
}

/**
 * Everything around the car that isn't the sky: the near ground in tiles that grow and fall
 * away as you drive, a coarse far ground out to the mountains, the road in 100 m pieces, posts
 * along it, trees, bushes and rocks, and water filling every hollow below sea level.
 */
export class World {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, Tile>();
  private readonly chunks = new Map<number, THREE.Group>();
  private readonly dist: RoadDistance;
  private readonly farDist: RoadDistance;
  private readonly terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.35 });
  private readonly roadMat: THREE.MeshStandardMaterial;
  /** The same road with a solid centre line, for the bends. */
  private readonly roadMatSolid: THREE.MeshStandardMaterial;
  /** Yellow chevron boards pointing right and left. */
  private readonly chevronMats: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  private readonly signGeo = new THREE.PlaneGeometry(1.0, 1.1).translate(0, 1.6, 0);
  private readonly signPostGeo = new THREE.CylinderGeometry(0.045, 0.045, 2.15, 6).translate(0, 1.07, 0);
  private readonly signPostMat = new THREE.MeshStandardMaterial({ color: 0x8a8d92, metalness: 0.6, roughness: 0.5 });
  /** Telegraph poles: a weathered timber pole with a cross-arm, and the sagging wires between them. */
  private readonly poleGeo = mergeGeometries([new THREE.CylinderGeometry(0.11, 0.14, 9, 7).translate(0, 4.5, 0), new THREE.BoxGeometry(0.12, 0.12, 1.7).translate(0, 8.4, 0)]);
  private readonly poleMat = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.95 });
  private readonly wireMat = new THREE.LineBasicMaterial({ color: 0x1b1b1f, transparent: true, opacity: 0.8 });
  private readonly postMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.6 });
  private readonly reflectorMat = new THREE.MeshStandardMaterial({ color: 0x6a3a08, emissive: 0xff8a1a, emissiveIntensity: 0.2, roughness: 0.3 });
  private readonly postGeo = new THREE.BoxGeometry(0.1, 1.05, 0.1).translate(0, 0.52, 0);
  /** The guardrail's back, seen from the fields. */
  private readonly railBackMat = new THREE.MeshStandardMaterial({ color: 0x8c9198, metalness: 0.6, roughness: 0.5, side: THREE.BackSide });
  /** Galvanised steel for the guardrails. */
  private readonly railMat = new THREE.MeshStandardMaterial({ color: 0xb8bdc4, metalness: 0.7, roughness: 0.42, envMapIntensity: 0.8 });
  private readonly railPostGeo = new THREE.BoxGeometry(0.1, 1, 0.14).translate(0, 0.2, 0);
  /**
   * How far along the road has been reached: the world more than a little way behind it is
   * closed (not built, and taken away), since the road only goes forward.
   */
  progress: Progress | null = null;
  /** Where the guardrails go (the scene asks it too, for crashing into them). */
  readonly barriers: Barriers;
  private readonly reflectorGeo = new THREE.BoxGeometry(0.11, 0.16, 0.06).translate(0, 0.86, 0);
  /** Every tile's triangles index the same way (each gets its own copy: buffers are freed per tile). */
  private readonly tileIndex: Uint16Array;
  private readonly plants = {} as Record<TreeKind, THREE.InstancedMesh>;
  private plantsDirty = false;
  /** Wind for every swaying plant: time, and how hard it's blowing. */
  private readonly wind = { uTime: { value: 0 }, uWind: { value: 1 } };
  private readonly ripples: THREE.DataTexture;
  private readonly detail = groundDetail();
  private readonly waterTime = { value: 0 };
  /** How much the land round the water dims what it reflects just above the horizon, per channel. */
  private readonly waterHills = { value: new THREE.Color(0.22, 0.28, 0.2) };
  private far: THREE.Mesh;
  private range: Range = RANGES.medium;
  /**
   * The far ground's lattice points, worked out once: a slot per point in one flat array
   * (height, then linear colour), so a long drive's worth of them is no work for the GC.
   */
  private readonly farSlot = new Map<number, number>();
  private readonly farData = new Float32Array(FAR_SLOTS * 4);
  private farNext = 0;
  private farCentre = "";
  private readonly water: THREE.Mesh;
  private camTile = { x: 0, z: 0 };
  private readonly pt: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, grade: 0 };

  constructor(private readonly land: Landscape, maxAnisotropy: number) {
    this.dist = new RoadDistance(land.road);
    this.barriers = new Barriers(land);
    this.farDist = new RoadDistance(land.road);
    const tex = roadTexture();
    const solidTex = roadTexture(true);
    solidTex.anisotropy = maxAnisotropy;
    this.roadMatSolid = new THREE.MeshStandardMaterial({ map: solidTex, roughness: 0.88, metalness: 0, envMapIntensity: 0.25 });
    this.chevronMats = [chevronMaterial(1), chevronMaterial(-1)];
    tex.anisotropy = maxAnisotropy;
    this.roadMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88, metalness: 0, envMapIntensity: 0.25 });

    const idx: number[] = [];
    const N = RES + 1;
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const a = j * N + i;
        idx.push(a, a + N, a + 1, a + 1, a + N, a + N + 1);
      }
    }
    this.tileIndex = new Uint16Array(idx);

    for (const kind of KINDS) {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: kind !== "grass", roughness: 0.92, envMapIntensity: 0.3, side: kind === "grass" ? THREE.DoubleSide : THREE.FrontSide });
      if (kind !== "rock") this.sway(mat, kind === "grass" ? 0 : 0.8, kind === "grass" ? 0.16 : 0.035);
      const m = new THREE.InstancedMesh(plantGeometry(kind), mat, CAP[kind]);
      m.count = 0;
      m.frustumCulled = false;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP[kind] * 3), 3);
      this.plants[kind] = m;
      this.group.add(m);
    }

    this.detailGround(maxAnisotropy);
    this.far = this.makeFar();

    this.ripples = rippleNormals();
    this.ripples.repeat.set(400, 400); // one tile every 35 m
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x0e3a44, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.9, envMapIntensity: 0.9, normalMap: this.ripples, normalScale: new THREE.Vector2(0.25, 0.25) });
    // two sets of ripples crossing at different sizes and speeds, so the pattern never repeats
    // visibly; clear looking down into it, a mirror of the sky towards the horizon
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.waterTime;
      shader.uniforms.uHills = this.waterHills;
      const ripples = THREE.ShaderChunk.normal_fragment_maps.replace(
        "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
        `vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
        vec3 mapN2 = texture2D( normalMap, vNormalMapUv * 0.31 + vec2( -uTime * 0.0021, uTime * 0.0013 ) ).xyz * 2.0 - 1.0;
        mapN = normalize( vec3( mapN.xy + mapN2.xy * 1.4, mapN.z * mapN2.z ) );
        // calm it with distance: far off, ripples finer than a pixel would only alias into stripes
        mapN.xy *= mix( 1.0, 0.08, smoothstep( 8.0, 160.0, length( vViewPosition ) ) );`,
      );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform vec3 uHills;")
        .replace(
          "#include <normal_fragment_maps>",
          `${ripples}
          float facing = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
          float fres = pow( 1.0 - facing, 4.0 );
          diffuseColor.a = mix( 0.58, 0.97, fres );
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.5, 0.7, 0.75 ), fres );`,
        )
        .replace(
          "#include <lights_fragment_maps>",
          `#include <lights_fragment_maps>
          {
            // what's reflected just above the horizon is the hills and trees round the water, not
            // the pale sky behind them: darken those reflections towards the land's colour
            vec3 up = inverseTransformDirection( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
            radiance *= mix( uHills, vec3( 1.0 ), smoothstep( 0.03, 0.42, up.y ) );
          }`,
        );
    };
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000).rotateX(-Math.PI / 2), waterMat);
    this.water.position.y = WATER_Y;
    this.group.add(this.water);
  }

  /**
   * Gives the ground texture up close: the detail map's grain and clumps over the baked colours,
   * fading out with distance (where it would only shimmer), broad patches that drift the colour
   * a little, and wildflowers dotted through the grass near the car.
   */
  private detailGround(maxAnisotropy: number) {
    this.detail.anisotropy = maxAnisotropy;
    const mat = this.terrainMat;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDetail = { value: this.detail };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vGround;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvGround = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform sampler2D uDetail;\nvarying vec3 vGround;")
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          {
            float dist = length( vGround - cameraPosition );
            float fine = texture2D( uDetail, vGround.xz / 7.0 ).r;
            float clump = texture2D( uDetail, vGround.xz / 41.0 ).g;
            float broad = texture2D( uDetail, vGround.xz / 260.0 ).b;
            float near = 1.0 - smoothstep( 40.0, 260.0, dist );
            vec3 c = diffuseColor.rgb;
            float green = clamp( ( c.g - c.r ) * 12.0, 0.0, 1.0 ) * clamp( ( c.g - c.b ) * 8.0, 0.0, 1.0 );
            c *= mix( 1.0, 0.6 + 0.8 * fine, near );
            c *= 0.74 + 0.52 * clump;
            // broad patches: greener and darker in some, sunnier in others
            c = mix( c, c * vec3( 1.12, 1.06, 0.82 ), smoothstep( 0.45, 0.75, broad ) * green * 0.8 );
            c = mix( c, c * vec3( 0.82, 0.95, 0.85 ), ( 1.0 - smoothstep( 0.25, 0.55, broad ) ) * green * 0.7 );
            // wildflowers in the grass near the car: white, yellow, and the odd purple
            float f = texture2D( uDetail, vGround.xz / 5.0 + vec2( 0.37, 0.61 ) ).a;
            float bloom = smoothstep( 0.18, 0.4, f ) * green * ( 1.0 - smoothstep( 25.0, 90.0, dist ) ) * smoothstep( 0.4, 0.6, clump );
            vec3 petal = f > 0.75 ? vec3( 0.9, 0.88, 0.8 ) : f > 0.45 ? vec3( 0.85, 0.68, 0.12 ) : vec3( 0.42, 0.25, 0.55 );
            c = mix( c, petal, bloom * 0.85 );
            diffuseColor.rgb = c;
          }`,
        );
    };
  }

  /** The far ground's mesh at the current reach: positions and colours filled in when it's centred. */
  private makeFar(): THREE.Mesh {
    const F = this.range.far * 2 + 1;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(F * F * 3), 3));
    fg.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(F * F * 3), 3));
    const fi: number[] = [];
    for (let j = 0; j < F - 1; j++) {
      for (let i = 0; i < F - 1; i++) {
        const a = j * F + i;
        fi.push(a, a + F, a + 1, a + 1, a + F, a + F + 1);
      }
    }
    fg.setIndex(fi);
    const far = new THREE.Mesh(fg, this.terrainMat);
    far.frustumCulled = false;
    this.group.add(far);
    return far;
  }

  /**
   * How far out to build and how thickly to plant. Changing it takes effect over the next
   * frames: tiles beyond the new reach go, missing ones are built nearest first.
   */
  setRange(range: Range): void {
    const old = this.range;
    if (old.ring === range.ring && old.trees === range.trees && old.grass === range.grass && old.far === range.far && old.density === range.density) return;
    this.range = range;
    if (old.far !== range.far) {
      this.group.remove(this.far);
      this.far.geometry.dispose();
      this.far = this.makeFar();
    }
    this.farCentre = "";
    this.plantsDirty = true;
  }

  /**
   * Makes a plant material sway in the wind: everything above `from` metres bends back and forth,
   * more the higher up, each plant on its own phase (from where it stands).
   */
  private sway(mat: THREE.MeshStandardMaterial, from: number, amount: number) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.wind.uTime;
      shader.uniforms.uWind = this.wind.uWind;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          float bend = max(0.0, position.y - ${from.toFixed(2)}) * ${amount.toFixed(3)} * uWind;
          float phase = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.09;
          transformed.x += sin(uTime * 1.6 + phase) * bend + sin(uTime * 3.7 + phase * 2.0) * bend * 0.3;
          transformed.z += cos(uTime * 1.3 + phase * 1.4) * bend * 0.7;`,
        );
    };
  }

  /** Moves the water's ripples and the plants in the wind. Gusty in the rain. */
  animate(time: number, windy: number): void {
    this.wind.uTime.value = time;
    this.wind.uWind.value = 1 + windy * 1.6;
    this.ripples.offset.set(time * 0.006, time * 0.0035);
    this.waterTime.value = time;
  }

  /** A wet road shines; dry asphalt doesn't. The reflectors light up after dark. */
  setLight(wet: number, night: number): void {
    for (const m of [this.roadMat, this.roadMatSolid]) {
      m.roughness = 0.88 - 0.55 * wet;
      m.color.setScalar(1 - 0.35 * wet);
    }
    this.reflectorMat.emissiveIntensity = 0.15 + 2.2 * night;
  }

  /** Builds everything around the camera at once (behind a loading screen). */
  warmUp(camX: number, camZ: number, carS: number): void {
    this.update(camX, camZ, carS, Infinity);
  }

  /** Grows the world around the camera, spending about `budgetMs` on new ground this frame. */
  update(camX: number, camZ: number, carS: number, budgetMs = 5): void {
    const road = this.land.road;
    const before = road.samples;
    // lay the road out a kilometre at a time, well ahead (not a sample every frame)
    if (road.length < carS + 6500) road.ensure(carS + 7500);
    // and keep its end out past everything built, far ground included: ground worked out before
    // the road came near it would have mountains where the road then runs. (A winding road
    // covers less ground than its length, and driving freely the car can head anywhere.)
    const clear = Math.SQRT2 * this.range.far * FAR_STEP + WILD_M + 300;
    for (let k = 0; k < (budgetMs === Infinity ? 40 : 4); k++) {
      const [ex, , ez] = road.sample(road.samples - 1);
      if (Math.hypot(ex - camX, ez - camZ) > clear) break;
      road.ensure(road.length + 1000);
    }
    if (road.samples !== before) this.roadGrew(before);
    this.updateRoad(carS);
    const tx = Math.floor(camX / TILE);
    const tz = Math.floor(camZ / TILE);
    this.camTile = { x: tx, z: tz };
    this.water.position.x = Math.round(camX / 100) * 100;
    this.water.position.z = Math.round(camZ / 100) * 100;

    // drop tiles that have fallen behind
    for (const [key, tile] of this.tiles) {
      const [ix, iz] = key.split(",").map(Number);
      if (Math.hypot(ix - tx, iz - tz) > this.range.ring + 1.2 || this.tileClosed(ix, iz)) {
        this.group.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        this.tiles.delete(key);
        this.plantsDirty = true;
      }
    }
    // build the missing ones, nearest first
    const want: [number, number, number][] = [];
    const RING = this.range.ring;
    for (let dz = -RING; dz <= RING; dz++) {
      for (let dx = -RING; dx <= RING; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > RING + 0.5) continue;
        if (!this.tiles.has(`${tx + dx},${tz + dz}`) && !this.tileClosed(tx + dx, tz + dz)) want.push([tx + dx, tz + dz, d]);
      }
    }
    want.sort((a, b) => a[2] - b[2]);
    const t0 = performance.now();
    for (const [ix, iz] of want) {
      this.buildTile(ix, iz);
      this.plantsDirty = true;
      if (performance.now() - t0 > budgetMs) break;
    }
    const centre = `${tx},${tz}`;
    if (centre !== this.farCentre && performance.now() - t0 < budgetMs * 3) {
      this.farCentre = centre;
      this.buildFar(tx, tz);
    }
    if (this.plantsDirty) this.fillPlants();
  }

  /**
   * Is a tile wholly in the closed part of the world behind the car? All of it well behind the
   * closed line, and no open road through it or near enough to shape it.
   */
  private tileClosed(ix: number, iz: number): boolean {
    const p = this.progress;
    if (!p) return false;
    const x0 = ix * TILE;
    const z0 = iz * TILE;
    for (const [x, z] of [[x0, z0], [x0 + TILE, z0], [x0, z0 + TILE], [x0 + TILE, z0 + TILE]]) if (!p.isBehind(x, z, NaN, 60)) return false;
    const near = this.land.road.samplesNear(x0 - REACH, z0 - REACH, x0 + TILE + REACH, z0 + TILE + REACH, 4);
    return !near.some((i) => i * STEP >= p.boundary - 60);
  }

  /**
   * Fresh road was laid. Normally that's far ahead of anything built; but if it came within
   * reach of ground already built (driving off the road and round to where it's going), that
   * ground was shaped without it: build it again.
   */
  private roadGrew(from: number) {
    const road = this.land.road;
    let stale = false;
    for (const [key, tile] of this.tiles) {
      const [ix, iz] = key.split(",").map(Number);
      // the new road reshapes the ground as far out as it calms the mountains, not just its banks
      if (!this.roadNear(ix, iz, from)) continue;
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      this.tiles.delete(key);
      this.saved.delete(key);
      stale = true;
    }
    // the far ground near it too: forget those lattice points, and lay the far ground again
    const r = Math.ceil(WILD_M / FAR_STEP);
    let farStale = false;
    for (let i = from; i < road.samples; i += 10) {
      const [x, , z] = road.sample(i);
      const gx0 = Math.round(x / FAR_STEP);
      const gz0 = Math.round(z / FAR_STEP);
      for (let gx = gx0 - r; gx <= gx0 + r; gx++) {
        for (let gz = gz0 - r; gz <= gz0 + r; gz++) farStale = this.farSlot.delete((gx + 100000) * 200003 + (gz + 100000)) || farStale;
      }
    }
    if (farStale) this.farCentre = "";
    if (stale) {
      this.plantsDirty = true;
      this.onRoadGrew?.();
    }
  }

  /** Tiles to use instead of building them ("ix,iz" → data), from an earlier visit. */
  private readonly saved = new Map<string, TileData>();
  /** Tiles built this visit that aren't saved yet. */
  private fresh: { key: string; data: TileData }[] = [];

  /** Hands over tiles saved on an earlier visit, to use instead of building them. */
  prime(tiles: Map<string, TileData>): void {
    for (const [k, v] of tiles) this.saved.set(k, v);
  }

  /** The tile keys within the ring around a point (to load from the cache before building). */
  static keysAround(x: number, z: number, RING = RANGES.medium.ring): string[] {
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    const out: string[] = [];
    for (let dz = -RING - 1; dz <= RING + 1; dz++) for (let dx = -RING - 1; dx <= RING + 1; dx++) out.push(`${tx + dx},${tz + dz}`);
    return out;
  }

  /** Tiles built since last asked, to save. */
  takeFresh(): { key: string; data: TileData }[] {
    const out = this.fresh;
    this.fresh = [];
    return out;
  }

  /** Has road been laid within reach of a tile since sample `from`? (Then its saved ground is out of date.) */
  private roadNear(ix: number, iz: number, from: number): boolean {
    const road = this.land.road;
    for (let i = from; i < road.samples; i += 4) {
      const [x, , z] = road.sample(i);
      if (x > ix * TILE - WILD_M && x < (ix + 1) * TILE + WILD_M && z > iz * TILE - WILD_M && z < (iz + 1) * TILE + WILD_M) return true;
    }
    return false;
  }

  /** Told when built ground had to be redone (anything caching heights should forget them). */
  onRoadGrew: (() => void) | null = null;

  private buildTile(ix: number, iz: number) {
    const x0 = ix * TILE;
    const z0 = iz * TILE;
    const step = TILE / RES;
    const N = RES + 1;
    this.dist.prepare(x0, z0, x0 + TILE, z0 + TILE, WILD_M);
    // heights with a one-vertex border, so normals match across tile edges
    const B = N + 2;
    const key = `${ix},${iz}`;
    let saved = this.saved.get(key);
    if (saved && (saved.hs.length !== B * B || this.roadNear(ix, iz, saved.roadSamples))) saved = undefined;
    this.saved.delete(key);
    const hs = saved ? saved.hs : new Float32Array(B * B);
    const cols = saved ? saved.cols : new Float32Array(N * N * 3);
    const q: [number, number] = [0, 0];
    for (let j = 0; j < (saved ? 0 : B); j++) {
      for (let i = 0; i < B; i++) {
        const x = x0 + (i - 1) * step;
        const z = z0 + (j - 1) * step;
        this.dist.query(x, z, q);
        const g = this.land.ground(x, z, q[0], q[1]);
        hs[j * B + i] = g.y;
        if (i >= 1 && j >= 1 && i <= N && j <= N) cols.set([lin(g.color[0]), lin(g.color[1]), lin(g.color[2])], ((j - 1) * N + (i - 1)) * 3);
      }
    }
    const pos = new Float32Array(N * N * 3);
    const nor = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = (j * N + i) * 3;
        const h = (a: number, b: number) => hs[(j + 1 + b) * B + (i + 1 + a)];
        pos[k] = i * step;
        pos[k + 1] = h(0, 0);
        pos[k + 2] = j * step;
        const nx = h(-1, 0) - h(1, 0);
        const nz = h(0, -1) - h(0, 1);
        const ny = 2 * step;
        const l = Math.hypot(nx, ny, nz);
        nor[k] = nx / l;
        nor[k + 1] = ny / l;
        nor[k + 2] = nz / l;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    geo.setIndex(new THREE.BufferAttribute(this.tileIndex, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(x0, 0, z0);
    // (the car's shadow only ever lands on the road: sampling it over all this ground is wasted)
    this.group.add(mesh);

    // plants: one chance every 8 m, jittered, kept or not by how green the ground is
    const plants: Tile["plants"] = { pine: [], broad: [], bush: [], rock: [], grass: [] };
    if (saved) for (const k of ["pine", "broad", "bush", "rock"] as const) plants[k] = Array.from(saved.plants[k]);
    const cells = saved ? 0 : TILE / 8;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const rand = mulberry32(hash2(ix * cells + i, iz * cells + j, this.land.seed));
        const x = x0 + (i + rand()) * 8;
        const z = z0 + (j + rand()) * 8;
        this.dist.query(x, z, q);
        if (q[0] < ROAD_HALF + 6) continue;
        const g = this.land.ground(x, z, q[0], q[1]);
        const roll = rand();
        let kind: TreeKind | null = null;
        if (roll < g.trees * 0.8) kind = g.dry > 0.55 ? "broad" : g.y > 45 || rand() < 0.55 ? "pine" : "broad";
        else if (roll > 0.985 - g.dry * 0.04) kind = g.dry > 0.6 && rand() < 0.6 ? "bush" : "rock";
        else if (g.dry > 0.55 && roll > 0.93) kind = "bush";
        if (!kind || g.y < WATER_Y + 1) continue;
        const scale = kind === "rock" ? 0.5 + rand() * 1.8 : 0.7 + rand() * 0.75;
        const tint = 0.82 + rand() * 0.36;
        const autumn = kind === "broad" ? g.dry : 0;
        // broadleaves turn gold in dry country
        plants[kind].push(x, g.y - 0.15, z, rand() * Math.PI * 2, scale, tint * (1 + autumn * 0.3), tint * (1 - autumn * 0.08), tint * (1 - autumn * 0.5));
      }
    }
    // grass: a tuft every couple of metres where the ground is green, its height from the
    // tile's own lattice (the same triangles as the mesh), its colour from the ground's
    const gstep = 2.2;
    const gcells = Math.floor(TILE / gstep);
    const rand = mulberry32(hash2(ix, iz, this.land.seed + 99));
    for (let j = 0; j < gcells; j++) {
      for (let i = 0; i < gcells; i++) {
        const lx = (i + rand()) * gstep;
        const lz = (j + rand()) * gstep;
        const keep = rand();
        const fx = lx / step;
        const fz = lz / step;
        const ci = Math.min(RES - 1, Math.floor(fx));
        const cj = Math.min(RES - 1, Math.floor(fz));
        const u = fx - ci;
        const v = fz - cj;
        const H = (a: number, b: number) => hs[(cj + 1 + b) * B + (ci + 1 + a)];
        const y = u + v <= 1 ? H(0, 0) + u * (H(1, 0) - H(0, 0)) + v * (H(0, 1) - H(0, 0)) : H(1, 1) + (1 - u) * (H(0, 1) - H(1, 1)) + (1 - v) * (H(1, 0) - H(1, 1));
        const k = (cj * N + ci) * 3;
        const r = cols[k], g = cols[k + 1], b = cols[k + 2];
        // green enough (linear colour): grass; sand, rock, snow and the verge stay bare
        const green = g / Math.max(1e-4, r) - 1;
        if (green < 0.15 || keep > Math.min(0.75, green * 1.6) || y < WATER_Y + 0.8) continue;
        const x = x0 + lx;
        const z = z0 + lz;
        this.dist.query(x, z, q);
        if (q[0] < ROAD_HALF + 2) continue;
        const toSrgb = (c: number) => Math.pow(c, 1 / 2.2);
        const sc = 0.6 + rand() * 0.8;
        plants.grass.push(x, y - 0.02, z, rand() * Math.PI * 2, sc, toSrgb(r) * 1.15, toSrgb(g) * 1.2, toSrgb(b) * 1.05);
      }
    }
    this.tiles.set(key, { mesh, plants });
    if (!saved) {
      this.fresh.push({
        key,
        data: {
          hs,
          cols,
          plants: { pine: new Float32Array(plants.pine), broad: new Float32Array(plants.broad), bush: new Float32Array(plants.bush), rock: new Float32Array(plants.rock) },
          roadSamples: this.land.road.samples,
        },
      });
    }
  }

  /**
   * Refills the instanced plants from the tiles near the camera. Each tile's matrices were worked
   * out when it was built, so this is block copies (the outer ring takes every other plant).
   */
  private fillPlants() {
    this.plantsDirty = false;
    for (const kind of KINDS) {
      const mesh = this.plants[kind];
      const cap = mesh.instanceMatrix.count;
      const mats = mesh.instanceMatrix.array as Float32Array;
      const cols = mesh.instanceColor!.array as Float32Array;
      let n = 0;
      for (const [key, tile] of this.tiles) {
        const [ix, iz] = key.split(",").map(Number);
        const ring = Math.hypot(ix - this.camTile.x, iz - this.camTile.z);
        if (ring > (kind === "grass" ? this.range.grass : this.range.trees + 0.5)) continue;
        tile.ready ??= readyPlants(tile.plants);
        const src = tile.ready[kind];
        const count = src.cols.length / 3;
        // far off, the fog and the count hide every other tree
        // far off, the fog and the count hide every other tree; a lower density thins them all
        const thin = ring > this.range.trees - 0.5 && kind !== "rock" && kind !== "grass" ? 2 : 1;
        const stride = thin / this.range.density;
        if (stride > 1.01) {
          for (let f = 0; f < count && n < cap; f += stride, n++) {
            const i = Math.floor(f);
            mats.set(src.mats.subarray(i * 16, i * 16 + 16), n * 16);
            cols.set(src.cols.subarray(i * 3, i * 3 + 3), n * 3);
          }
        } else {
          const take = Math.min(count, cap - n);
          mats.set(src.mats.subarray(0, take * 16), n * 16);
          cols.set(src.cols.subarray(0, take * 3), n * 3);
          n += take;
        }
      }
      mesh.count = n;
      // upload only what's drawn
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.clearUpdateRanges();
      mesh.instanceColor!.addUpdateRange(0, n * 3);
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  private buildFar(tx: number, tz: number) {
    const FAR_HALF = this.range.far;
    const RING = this.range.ring;
    const F = FAR_HALF * 2 + 1;
    const cx = Math.round(((tx + 0.5) * TILE) / FAR_STEP);
    const cz = Math.round(((tz + 0.5) * TILE) / FAR_STEP);
    const geo = this.far.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    // the near tiles cover this box; the far ground ducks under it there
    const nx0 = (tx - RING) * TILE;
    const nx1 = (tx + RING + 1) * TILE;
    const nz0 = (tz - RING) * TILE;
    const nz1 = (tz + RING + 1) * TILE;
    let prepared = false;
    const q: [number, number] = [0, 0];
    const ox = (cx - FAR_HALF) * FAR_STEP;
    const oz = (cz - FAR_HALF) * FAR_STEP;
    for (let j = 0; j < F; j++) {
      for (let i = 0; i < F; i++) {
        const gx = cx - FAR_HALF + i;
        const gz = cz - FAR_HALF + j;
        const key = (gx + 100000) * 200003 + (gz + 100000);
        let slot = this.farSlot.get(key);
        const x = gx * FAR_STEP;
        const z = gz * FAR_STEP;
        if (slot === undefined) {
          if (!prepared) {
            this.farDist.prepare(ox, oz, ox + F * FAR_STEP, oz + F * FAR_STEP, WILD_M);
            prepared = true;
          }
          this.farDist.query(x, z, q);
          const g = this.land.ground(x, z, q[0], q[1]);
          if (this.farNext === FAR_SLOTS) {
            // full: start again (only points still in view get worked out again)
            this.farSlot.clear();
            this.farNext = 0;
          }
          slot = this.farNext++;
          this.farData.set([g.y, lin(g.color[0]), lin(g.color[1]), lin(g.color[2])], slot * 4);
          this.farSlot.set(key, slot);
        }
        const d = this.farData;
        const y = d[slot * 4];
        const inside = x > nx0 + FAR_STEP && x < nx1 - FAR_STEP && z > nz0 + FAR_STEP && z < nz1 - FAR_STEP;
        const k = j * F + i;
        pos.setXYZ(k, x - ox, inside ? y - 14 : y - 0.6, z - oz);
        col.setXYZ(k, d[slot * 4 + 1], d[slot * 4 + 2], d[slot * 4 + 3]);
      }
    }
    this.far.position.set(ox, 0, oz);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private updateRoad(carS: number) {
    // (never behind the closed line: the road there is gone)
    const first = Math.max(0, Math.floor((carS - 300) / (CHUNK * STEP)), Math.floor((this.progress?.boundary ?? 0) / (CHUNK * STEP)));
    const last = Math.floor((carS + 1500) / (CHUNK * STEP));
    for (const [c, g] of this.chunks) {
      if (c < first || c > last) {
        this.group.remove(g);
        // the posts share one geometry between every piece of road: free only this piece's own
        g.traverse((o) => {
          if (o instanceof THREE.InstancedMesh) o.dispose();
          else if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
        });
        this.chunks.delete(c);
      }
    }
    for (let c = first; c <= last; c++) if (!this.chunks.has(c)) this.chunks.set(c, this.buildChunk(c));
  }

  private buildChunk(c: number): THREE.Group {
    const road = this.land.road;
    const i0 = c * CHUNK;
    const origin = road.at(i0 * STEP);
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const cols = SECTION.length;
    const pos: number[] = [];
    const uv: number[] = [];
    for (let i = 0; i <= CHUNK; i++) {
      const s = (i0 + i) * STEP;
      const p = road.at(s, this.pt);
      const [rx, rz] = rightOf(p.heading);
      const bank = bankOf(p.curvature);
      for (const [d, dy, u] of SECTION) {
        pos.push(p.x + rx * d - ox, p.y - bank * d + dy - oy, p.z + rz * d - oz);
        uv.push(u, s / DASH_PERIOD);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < CHUNK; i++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = i * cols + k;
        idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const group = new THREE.Group();
    group.position.set(ox, oy, oz);
    // a solid centre line through the bends, dashed on the straights
    let kMax = 0;
    for (let i = 0; i <= CHUNK; i += 5) kMax = Math.max(kMax, Math.abs(road.curvatureAt((i0 + i) * STEP)));
    const mesh = new THREE.Mesh(geo, kMax > 1 / 350 ? this.roadMatSolid : this.roadMat);
    mesh.receiveShadow = true;
    group.add(mesh);

    // guardrails where they're planned: a corrugated steel beam on posts
    const rails = this.barriers;
    const beam: number[] = [];
    const railPosts = new THREE.InstancedMesh(this.railPostGeo, this.railMat, CHUNK + 2);
    const railRefl = new THREE.InstancedMesh(this.reflectorGeo, this.reflectorMat, CHUNK / 5 + 4);
    let np = 0;
    let nr = 0;
    const m4r = new THREE.Matrix4();
    // the beam's cross-section, outward offset (m) and height above the shoulder (m): a W
    const W: [number, number][] = [[0.06, 0.46], [0, 0.52], [0.05, 0.6], [0, 0.68], [0.06, 0.74]];
    for (const side of [-1, 1] as const) {
      let prev: number[][] | null = null;
      for (let i = 0; i <= CHUNK; i++) {
        const s = (i0 + i) * STEP;
        const on = rails.has(s, side);
        if (!on) {
          prev = null;
          continue;
        }
        const p = road.at(s, this.pt);
        const [rx, rz] = rightOf(p.heading);
        const d = side * BARRIER_D;
        const base = p.y - bankOf(p.curvature) * d + sectionDrop(d) - oy;
        const ring = W.map(([out, h]) => {
          const dd = d + side * out;
          return [p.x + rx * dd - ox, base + h, p.z + rz * dd - oz];
        });
        if (prev) {
          for (let k = 0; k + 1 < W.length; k++) {
            const a = prev[k], b = prev[k + 1], c2 = ring[k + 1], e = ring[k];
            // facing the road: the quad's winding depends on which side it's on
            if (side === 1) beam.push(...a, ...b, ...c2, ...a, ...c2, ...e);
            else beam.push(...a, ...c2, ...b, ...a, ...e, ...c2);
          }
        }
        prev = ring;
        // a post every 4 m behind the beam, a reflector on every fifth
        if ((i0 + i) % 2 === 0) {
          m4r.makeRotationY(-p.heading);
          const pd = d + side * 0.14;
          m4r.setPosition(p.x + rx * pd - ox, base, p.z + rz * pd - oz);
          railPosts.setMatrixAt(np++, m4r);
          if ((i0 + i) % 10 === 0 && nr < railRefl.instanceMatrix.count) {
            m4r.setPosition(p.x + rx * (d - side * 0.02) - ox, base - 0.22, p.z + rz * (d - side * 0.02) - oz);
            railRefl.setMatrixAt(nr++, m4r);
          }
        }
      }
    }
    if (beam.length) {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute("position", new THREE.Float32BufferAttribute(beam, 3));
      bg.computeVertexNormals();
      const bm = new THREE.Mesh(bg, this.railMat);
      bm.castShadow = true;
      bm.receiveShadow = true;
      const back = new THREE.Mesh(bg, this.railBackMat);
      group.add(bm, back);
    }
    railPosts.count = np;
    railRefl.count = nr;
    group.add(railPosts, railRefl);

    // chevron boards on the outside of the tight bends, every 16 m, facing the traffic coming
    const boards: [THREE.InstancedMesh, THREE.InstancedMesh] = [
      new THREE.InstancedMesh(this.signGeo, this.chevronMats[0], CHUNK / 8 + 2),
      new THREE.InstancedMesh(this.signGeo, this.chevronMats[1], CHUNK / 8 + 2),
    ];
    const signPosts = new THREE.InstancedMesh(this.signPostGeo, this.signPostMat, CHUNK / 8 + 2);
    const nb = [0, 0];
    let ns = 0;
    const m4s = new THREE.Matrix4();
    for (let i = 0; i < CHUNK; i += 8) {
      const sAt = (i0 + i) * STEP;
      const p = road.at(sAt, this.pt);
      if (Math.abs(p.curvature) < 1 / 125) continue;
      const outside = p.curvature > 0 ? -1 : 1; // a right-hand bend's outside is on the left
      const [rx, rz] = rightOf(p.heading);
      const d = outside * (BARRIER_D + 0.7);
      const base = p.y - bankOf(p.curvature) * d + sectionDrop(d) - oy;
      // facing back down the road (towards the car coming), turned a little towards the lane
      m4s.makeRotationY(-p.heading - Math.PI / 2 + outside * 0.25);
      m4s.setPosition(p.x + rx * d - ox, base, p.z + rz * d - oz);
      const which = p.curvature > 0 ? 0 : 1; // the arrows point the way the road turns
      boards[which].setMatrixAt(nb[which]++, m4s);
      signPosts.setMatrixAt(ns++, m4s);
    }
    boards[0].count = nb[0];
    boards[1].count = nb[1];
    signPosts.count = ns;
    group.add(boards[0], boards[1], signPosts);

    // telegraph poles every 50 m along one side (it changes side now and then), wires slung between
    const poleSide = (s0: number) => (hash2(Math.floor(s0 / 2400), 7, this.land.seed) & 1 ? 1 : -1);
    const poleAt = (sAt: number) => {
      const p = road.at(sAt, this.pt);
      const side = poleSide(sAt);
      const [rx, rz] = rightOf(p.heading);
      const d = side * (ROAD_HALF + 9);
      const x = p.x + rx * d;
      const z = p.z + rz * d;
      const y = this.land.ground(x, z, Math.abs(d), p.y).y;
      // not in water, and not hanging off a cliff
      if (y < WATER_Y + 0.5 || Math.abs(y - p.y) > 7) return null;
      return { x, y, z, heading: p.heading, side };
    };
    const poles = new THREE.InstancedMesh(this.poleGeo, this.poleMat, 4);
    const wires: number[] = [];
    let np2 = 0;
    for (let i = 0; i < CHUNK; i += 25) {
      const sAt = (i0 + i) * STEP;
      const a = poleAt(sAt);
      if (!a) continue;
      m4s.makeRotationY(-a.heading);
      m4s.setPosition(a.x - ox, a.y - oy, a.z - oz);
      poles.setMatrixAt(np2++, m4s);
      // three wires to the next pole, sagging about half a metre
      const b = poleAt(sAt + 50);
      if (!b || b.side !== a.side) continue;
      for (const off of [-0.7, 0, 0.7]) {
        const ca = rightOf(a.heading);
        const cb = rightOf(b.heading);
        const pa = [a.x + ca[0] * off - ox, a.y + 8.45 - oy, a.z + ca[1] * off - oz];
        const pb = [b.x + cb[0] * off - ox, b.y + 8.45 - oy, b.z + cb[1] * off - oz];
        const steps = 8;
        for (let k = 0; k < steps; k++) {
          for (const t of [k / steps, (k + 1) / steps]) {
            const sag = 0.55 * 4 * t * (1 - t);
            wires.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t - sag, pa[2] + (pb[2] - pa[2]) * t);
          }
        }
      }
    }
    poles.count = np2;
    group.add(poles);
    if (wires.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute("position", new THREE.Float32BufferAttribute(wires, 3));
      group.add(new THREE.LineSegments(wg, this.wireMat));
    }

    // a post on each side every 50 m, with a reflector facing the traffic (none where there's a rail)
    const posts = new THREE.InstancedMesh(this.postGeo, this.postMat, 4);
    const refl = new THREE.InstancedMesh(this.reflectorGeo, this.reflectorMat, 4);
    const m4 = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < CHUNK; i += 25) {
      const p = road.at((i0 + i) * STEP, this.pt);
      const [rx, rz] = rightOf(p.heading);
      for (const side of [-1, 1] as const) {
        if (rails.has((i0 + i) * STEP, side)) continue;
        const d = side * (ROAD_HALF + 1.15);
        m4.makeRotationY(-p.heading);
        m4.setPosition(p.x + rx * d - ox, p.y - bankOf(p.curvature) * d - 0.12 - oy, p.z + rz * d - oz);
        posts.setMatrixAt(n, m4);
        refl.setMatrixAt(n, m4);
        n++;
      }
    }
    posts.count = refl.count = n;
    group.add(posts, refl);
    this.group.add(group);
    return group;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.postGeo.dispose();
    this.reflectorGeo.dispose();
    this.railPostGeo.dispose();
    for (const g of [this.signGeo, this.signPostGeo, this.poleGeo]) g.dispose();
    for (const m of [this.terrainMat, this.roadMat, this.roadMatSolid, this.postMat, this.reflectorMat, this.railMat, this.railBackMat, ...this.chevronMats, this.signPostMat, this.poleMat, this.wireMat]) {
      if ("map" in m && m.map) m.map.dispose();
      m.dispose();
    }
    this.roadMat.map?.dispose();
    for (const kind of KINDS) (this.plants[kind].material as THREE.Material).dispose();
    (this.water.material as THREE.Material).dispose();
    this.ripples.dispose();
    this.detail.dispose();
  }
}
