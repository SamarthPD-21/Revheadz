import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { hash2, mulberry32 } from "../../lib/cruise/noise";
import { ROAD_HALF, ROAD_SECTION, STEP, WATER_Y, bankOf, rightOf, type RoadPoint } from "../../lib/cruise/road";
import { GRID_M } from "../../lib/cruise/ground";
import { Landscape, RoadDistance, WILD_M, type Ground } from "../../lib/cruise/terrain";

/** Near ground comes in square tiles this wide, m, with this many quads a side (4 m apart). */
const TILE = 160;
const RES = TILE / GRID_M;
/** Tiles kept around the camera (a circle this many tiles across, either way). */
const RING = 4;
/** Trees grow only on tiles this close. */
const TREE_RING = 3;
/** The far ground: a coarse lattice out to the horizon, centred on the camera. */
const FAR_STEP = 50;
const FAR_HALF = 64;
/** Road meshes are built 50 samples (100 m) at a time. */
const CHUNK = 50;
/** One dash and gap of the centre line, m (the road texture's length). */
const DASH_PERIOD = 12;

const SECTION = ROAD_SECTION;

type TreeKind = "pine" | "broad" | "bush" | "rock" | "grass";

/** Colours here are picked as sRGB; vertex and instance colours are linear. */
const lin = (c: number) => Math.pow(c, 2.2);
const KINDS: TreeKind[] = ["pine", "broad", "bush", "rock", "grass"];
/** Grass grows only this close (in tiles): tufts are tiny, and there are a lot of them. */
const GRASS_RING = 1.6;
/** Instances per kind, at most. */
const CAP: Record<TreeKind, number> = { pine: 26000, broad: 26000, bush: 26000, rock: 26000, grass: 30000 };

interface Tile {
  mesh: THREE.Mesh;
  /** Per kind: x, y, z, yaw, scale, r, g, b for each plant or rock. */
  plants: Record<TreeKind, number[]>;
}

function roadTexture(): THREE.CanvasTexture {
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
  x.fillStyle = "#26272b";
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
    const l = onRoad ? 20 + rand() * 40 : 70 + rand() * 40;
    x.fillStyle = `rgba(${l + 6},${l + 4},${l},${onRoad ? 0.5 : 0.7})`;
    x.fillRect(u * W, v, onRoad ? 1.5 : 2.5, onRoad ? 1.5 : 2.5);
  }
  // white edge lines, a dashed white centre line (4.5 m of each 12 m)
  x.fillStyle = "rgba(235,235,228,0.92)";
  const edge = 0.1 + 0.8 * (0.42 / (2 * ROAD_HALF));
  x.fillRect(W * edge - 5, 0, 10, H);
  x.fillRect(W * (1 - edge) - 5, 0, 10, H);
  x.fillRect(W * 0.5 - 5, 0, 10, H * (4.5 / DASH_PERIOD));
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

/**
 * A tiling ripple normal map for the water: a handful of sine swells whose wavelengths fit
 * the tile exactly, so it repeats without a seam.
 */
function rippleNormals(): THREE.DataTexture {
  const N = 256;
  const rand = mulberry32(5);
  const waves = Array.from({ length: 9 }, () => ({ kx: Math.round(1 + rand() * 7) * (rand() < 0.5 ? -1 : 1), kz: Math.round(1 + rand() * 7), a: 0.4 + rand(), ph: rand() * Math.PI * 2 }));
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
  private readonly postMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.6 });
  private readonly reflectorMat = new THREE.MeshStandardMaterial({ color: 0x6a3a08, emissive: 0xff8a1a, emissiveIntensity: 0.2, roughness: 0.3 });
  private readonly postGeo = new THREE.BoxGeometry(0.1, 1.05, 0.1).translate(0, 0.52, 0);
  private readonly reflectorGeo = new THREE.BoxGeometry(0.11, 0.16, 0.06).translate(0, 0.86, 0);
  /** Every tile's triangles index the same way (each gets its own copy: buffers are freed per tile). */
  private readonly tileIndex: Uint16Array;
  private readonly plants = {} as Record<TreeKind, THREE.InstancedMesh>;
  private plantsDirty = false;
  /** Wind for every swaying plant: time, and how hard it's blowing. */
  private readonly wind = { uTime: { value: 0 }, uWind: { value: 1 } };
  private readonly ripples: THREE.DataTexture;
  private readonly far: THREE.Mesh;
  private readonly farCache = new Map<number, Ground>();
  private farCentre = "";
  private readonly water: THREE.Mesh;
  private camTile = { x: 0, z: 0 };
  private readonly pt: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, grade: 0 };

  constructor(private readonly land: Landscape, maxAnisotropy: number) {
    this.dist = new RoadDistance(land.road);
    this.farDist = new RoadDistance(land.road);
    const tex = roadTexture();
    tex.anisotropy = maxAnisotropy;
    this.roadMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88, metalness: 0, envMapIntensity: 0.5 });

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

    // the far ground: positions and colours filled in when it's centred
    const F = FAR_HALF * 2 + 1;
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
    this.far = new THREE.Mesh(fg, this.terrainMat);
    this.far.frustumCulled = false;
    this.group.add(this.far);

    this.ripples = rippleNormals();
    this.ripples.repeat.set(400, 400); // one tile every 35 m
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(14000, 14000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0d2a36, roughness: 0.07, metalness: 0.1, transparent: true, opacity: 0.9, normalMap: this.ripples, normalScale: new THREE.Vector2(0.35, 0.35) }),
    );
    this.water.position.y = WATER_Y;
    this.group.add(this.water);
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
  }

  /** A wet road shines; dry asphalt doesn't. The reflectors light up after dark. */
  setLight(wet: number, night: number): void {
    this.roadMat.roughness = 0.88 - 0.55 * wet;
    this.roadMat.color.setScalar(1 - 0.35 * wet);
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
    road.ensure(carS + 7000);
    // driving freely, the car can head anywhere: keep the end of the road well out of reach
    for (let k = 0; k < 4; k++) {
      const [ex, , ez] = road.sample(road.samples - 1);
      if (Math.hypot(ex - camX, ez - camZ) > 4200) break;
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
      if (Math.hypot(ix - tx, iz - tz) > RING + 1.2) {
        this.group.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        this.tiles.delete(key);
        this.plantsDirty = true;
      }
    }
    // build the missing ones, nearest first
    const want: [number, number, number][] = [];
    for (let dz = -RING; dz <= RING; dz++) {
      for (let dx = -RING; dx <= RING; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > RING + 0.5) continue;
        if (!this.tiles.has(`${tx + dx},${tz + dz}`)) want.push([tx + dx, tz + dz, d]);
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
   * Fresh road was laid. Normally that's far ahead of anything built; but if it came within
   * reach of ground already built (driving off the road and round to where it's going), that
   * ground was shaped without it: build it again.
   */
  private roadGrew(from: number) {
    const road = this.land.road;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = from; i < road.samples; i++) {
      const [x, , z] = road.sample(i);
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
    let stale = false;
    for (const [key, tile] of this.tiles) {
      const [ix, iz] = key.split(",").map(Number);
      if ((ix + 1) * TILE < x0 - WILD_M || ix * TILE > x1 + WILD_M || (iz + 1) * TILE < z0 - WILD_M || iz * TILE > z1 + WILD_M) continue;
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      this.tiles.delete(key);
      stale = true;
    }
    if (stale) {
      this.farCache.clear();
      this.farCentre = "";
      this.plantsDirty = true;
      this.onRoadGrew?.();
    }
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
    const hs = new Float32Array(B * B);
    const cols = new Float32Array(N * N * 3);
    const q: [number, number] = [0, 0];
    for (let j = 0; j < B; j++) {
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
    const cells = TILE / 8;
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
    this.tiles.set(`${ix},${iz}`, { mesh, plants });
  }

  private fillPlants() {
    this.plantsDirty = false;
    const m4 = new THREE.Matrix4();
    const qn = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (const kind of KINDS) {
      const mesh = this.plants[kind];
      const cap = mesh.instanceMatrix.count;
      let n = 0;
      for (const [key, tile] of this.tiles) {
        const [ix, iz] = key.split(",").map(Number);
        const ring = Math.hypot(ix - this.camTile.x, iz - this.camTile.z);
        if (ring > (kind === "grass" ? GRASS_RING : TREE_RING + 0.5)) continue;
        const list = tile.plants[kind];
        // the outer ring gets every other plant: far off, the fog and the count hide it
        const stride = ring > TREE_RING - 0.5 && kind !== "rock" && kind !== "grass" ? 16 : 8;
        for (let k = 0; k < list.length && n < cap; k += stride) {
          qn.setFromAxisAngle(up, list[k + 3]);
          p.set(list[k], list[k + 1], list[k + 2]);
          s.setScalar(list[k + 4]);
          m4.compose(p, qn, s);
          mesh.setMatrixAt(n, m4);
          mesh.instanceColor!.setXYZ(n, lin(list[k + 5]), lin(list[k + 6]), lin(list[k + 7]));
          n++;
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  private buildFar(tx: number, tz: number) {
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
        let g = this.farCache.get(key);
        const x = gx * FAR_STEP;
        const z = gz * FAR_STEP;
        if (!g) {
          if (!prepared) {
            this.farDist.prepare(ox, oz, ox + F * FAR_STEP, oz + F * FAR_STEP, WILD_M);
            prepared = true;
          }
          this.farDist.query(x, z, q);
          g = this.land.ground(x, z, q[0], q[1]);
          this.farCache.set(key, g);
        }
        const inside = x > nx0 + FAR_STEP && x < nx1 - FAR_STEP && z > nz0 + FAR_STEP && z < nz1 - FAR_STEP;
        const k = j * F + i;
        pos.setXYZ(k, x - ox, inside ? g.y - 14 : g.y - 0.6, z - oz);
        col.setXYZ(k, lin(g.color[0]), lin(g.color[1]), lin(g.color[2]));
      }
    }
    this.far.position.set(ox, 0, oz);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
    // keep the cache from growing without end on a long drive
    if (this.farCache.size > F * F * 6) this.farCache.clear();
  }

  private updateRoad(carS: number) {
    const first = Math.max(0, Math.floor((carS - 300) / (CHUNK * STEP)));
    const last = Math.floor((carS + 1500) / (CHUNK * STEP));
    for (const [c, g] of this.chunks) {
      if (c < first || c > last) {
        this.group.remove(g);
        // the posts share one geometry between every piece of road: free only this piece's own
        g.traverse((o) => {
          if (o instanceof THREE.InstancedMesh) o.dispose();
          else if (o instanceof THREE.Mesh) o.geometry.dispose();
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
    const mesh = new THREE.Mesh(geo, this.roadMat);
    mesh.receiveShadow = true;
    group.add(mesh);

    // a post on each side every 50 m, with a reflector facing the traffic
    const posts = new THREE.InstancedMesh(this.postGeo, this.postMat, 4);
    const refl = new THREE.InstancedMesh(this.reflectorGeo, this.reflectorMat, 4);
    const m4 = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < CHUNK; i += 25) {
      const p = road.at((i0 + i) * STEP, this.pt);
      const [rx, rz] = rightOf(p.heading);
      for (const side of [-1, 1]) {
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
    for (const m of [this.terrainMat, this.roadMat, this.postMat, this.reflectorMat]) m.dispose();
    this.roadMat.map?.dispose();
    for (const kind of KINDS) (this.plants[kind].material as THREE.Material).dispose();
    (this.water.material as THREE.Material).dispose();
    this.ripples.dispose();
  }
}
