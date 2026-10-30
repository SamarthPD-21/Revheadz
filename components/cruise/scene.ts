import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { mulberry32 } from "../../lib/cruise/noise";
import { GroundProbe, type Footing } from "../../lib/cruise/ground";
import { UNDERSTEER, brakeLimit, chassisOf, stepHandling, steerLock, tractionLimit, type Aids, type Chassis, type Motion } from "../../lib/cruise/handling";
import { BARRIER_D } from "../../lib/cruise/barriers";
import { LANE_OFFSET, ROAD_HALF, WATER_Y, rightOf, type RoadPoint } from "../../lib/cruise/road";
import { Landscape } from "../../lib/cruise/terrain";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { Atmosphere, type Weather } from "./atmosphere";
import { buildCar, type CarModel } from "./carModel";
import { Puffs } from "./particles";
import { World, type Range } from "./world";
import { ExhaustFlames, SkidMarks } from "./effects";

export type CameraMode = "chase" | "far" | "hood" | "drone" | "cinematic";
export const CAMERA_MODES: CameraMode[] = ["chase", "far", "hood", "drone", "cinematic"];
export type { Weather };

export interface Graphics {
  /** Share of the screen's resolution to draw at, or "auto" to adapt it to hold the frame rate. */
  scale: "auto" | number;
  range: Range;
  shadows: "off" | "on" | "high";
  bloom: boolean;
  clouds: boolean;
  /** Field of view, degrees. */
  fov: number;
}

/** What the scene needs from the car and the driver each frame. */
export interface Drive {
  speedKmh: number;
  /** Gas pedal, 0-1 (it uses up the driven wheels' grip). */
  throttle: number;
  /** Brake pedal, 0-1 (taillights, and grip). */
  brake: number;
  /** 0-1: how hard the driven wheels are spinning (smoke, dust, and less grip). */
  wheelspin: number;
  /** The brakes have locked the wheels (no ABS): they slide, and barely steer. */
  locked: boolean;
  /** -1 full left .. 1 full right; 0 lets the lane assist take it back to the lane. */
  steer: number;
  ignition: boolean;
}

/** Where the car is in its world: enough to come back to exactly the same place. */
export interface Place {
  x: number;
  z: number;
  yaw: number;
  s: number;
  lane: number;
}

export interface Look {
  hour: number;
  weather: Weather;
  camera: CameraMode;
}

const G = 9.81;
const srgbColor = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const tmpV = new THREE.Vector3();
/** Tyre rubber on tarmac, and ruts torn into the ground. */
const RUBBER = srgbColor(0.03, 0.03, 0.035);
const RUT = srgbColor(0.16, 0.12, 0.08);
const SPARK = srgbColor(1, 0.75, 0.35);
const damp = (current: number, target: number, rate: number, dt: number) => current + (target - current) * (1 - Math.exp(-rate * dt));
/** An angle brought into -π..π (for turning the short way round). */
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The cruise in 3D: an endless road through hills, forest, desert and mountains, a sky that
 * turns from day to night, and the car on it, seen from a choice of cameras. The simulation
 * only knows speed along the road; this places the car on the road from that, with the
 * lateral position, body roll and pitch worked out here.
 */
export class CruiseScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 9000);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly land: Landscape;
  private readonly world: World;
  private readonly atmo: Atmosphere;
  private car: CarModel;
  private readonly carRoot = new THREE.Group();
  private readonly beam = new THREE.SpotLight(0xfff1dc, 0, 140, 0.5, 0.55, 1.3);
  private readonly rain: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly rainSeeds: Float32Array;
  private readonly pt: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, grade: 0 };

  /** Distance along the road of the nearest road point (where the world is laid out from), m. */
  s: number;
  /** Free roam: no lane assist, so the car goes wherever it's steered, over the ground. */
  private free = false;
  private readonly probe: GroundProbe;
  /** The car: where it is, which way it points, and how it's moving in its own frame. */
  private fx = 0;
  private fz = 0;
  private yaw = 0;
  private readonly motion: Motion = { vy: 0, r: 0, delta: 0 };
  private readonly pivot = new THREE.Vector3();
  private flames!: ExhaustFlames;
  private readonly skids = new SkidMarks();
  private readonly rubberAt = new THREE.Vector3();
  /** The car's offset across the road last step (to tell which way it crossed a rail line). */
  private lastD = NaN;
  private impact: { share: number; strength: number } | null = null;
  /** A knock's jolt through the camera, 0-1, dying away. */
  private jolt = 0;
  private readonly rubberFwd = new THREE.Vector3();
  private readonly turned = new THREE.Vector3();
  /** Driver aids in use; null: the car's own. */
  aids: Aids | null = null;
  private chassis: Chassis;
  /** How hard the tyres are sliding, 0-1. */
  private slide = 0;
  /** How hard the driven wheels are spinning, 0-1 (from the simulation). */
  private spin = 0;
  private carY = 0;
  private tiltP = 0;
  private tiltR = 0;
  private footing: Footing | null = null;
  /** Where across the road the lane assist steers for (+ right of the centre line). */
  private lane = LANE_OFFSET;
  private readonly puffs = new Puffs(700);
  private puffDue = 0;
  private blocked = false;
  private lastSteerAt = -10;
  /** The chase camera's own heading: it follows the way the car is travelling, a moment late. */
  private camYaw = 0;
  private accelSm = 0;
  private prevV = 0;
  private pitch = 0;
  private pitchVel = 0;
  private roll = 0;
  private distance = 0;
  private time = 0;
  /** Dragging the mouse turns the chase camera round the car; it drifts back when let go. */
  private orbit = { yaw: 0, pitch: 0, at: -10 };
  private cine: { pos: THREE.Vector3; s: number; fov: number } | null = null;
  private readonly rand = mulberry32(77);
  private lastLook = "";
  private readonly camLook = new THREE.Vector3();
  private readonly lastCarPos = new THREE.Vector3();
  private quality = 1;
  private qualityAt = 0;
  private steady = 0;
  private ceiling = 1;
  /** Bloom only earns its cost at night and in the wet (lamps, reflectors); by day it's skipped. */
  private bloomOn = false;
  private frameMs = 16;
  /**
   * The frame time the resolution is tuned to hold, ms: the frame-rate target, or the screen's
   * own refresh if that's slower (nothing draws faster than the screen refreshes).
   */
  targetMs = 1000 / 60;
  /** A fixed share of the screen's resolution, or null to adapt it to hold the frame rate. */
  private fixedScale: number | null = null;
  /** Glow round lights at night and in the wet. */
  private bloomAllowed = true;
  /** Field of view of the chase camera at a standstill, degrees. */
  private fovBase = 58;
  private dpr = 1;
  private size = { w: 1, h: 1 };
  private camMode: CameraMode = "chase";

  constructor(canvas: HTMLCanvasElement, cfg: VehicleConfig, seed: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.land = new Landscape(seed);
    this.world = new World(this.land, this.renderer.capabilities.getMaxAnisotropy());
    this.probe = new GroundProbe(this.land);
    this.world.onRoadGrew = () => this.probe.reset();
    this.atmo = new Atmosphere(this.renderer);
    this.scene.add(this.world.group, this.atmo.group, this.atmo.sun, this.atmo.sun.target, this.atmo.moon, this.atmo.moon.target, this.atmo.hemi);

    this.s = 1500; // the road is laid from 0: start well along it, so it runs out of sight behind too
    this.car = buildCar(cfg);
    this.chassis = chassisOf(cfg, this.car.length);
    this.mountCar();
    this.scene.add(this.skids.mesh);
    this.putOnRoad(this.s, LANE_OFFSET);
    this.scene.add(this.carRoot);
    this.beam.castShadow = false;
    this.scene.add(this.beam, this.beam.target);

    const n = 2400;
    this.rainSeeds = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) this.rainSeeds[i] = this.rand();
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 6), 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab4c4, transparent: true, opacity: 0.22, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
    this.scene.add(this.puffs.points);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  /** Builds the world around the start (slow: do it behind a loading screen). */
  warmUp(look: Look): void {
    this.applyLook(look, true);
    this.world.warmUp(this.fx, this.fz, this.s);
    this.place(0);
    this.camYaw = this.yaw;
    this.placeCamera(0, look.camera, 0, true);
  }

  /** Where the car is now (to save, and come back to with `restore`). */
  get placeNow(): Place {
    return { x: this.fx, z: this.fz, yaw: this.yaw, s: this.s, lane: this.lane };
  }

  /** Puts the car back where it was (before `warmUp`). */
  restore(p: Place): void {
    this.lastD = NaN;
    this.fx = p.x;
    this.fz = p.z;
    this.yaw = p.yaw;
    this.s = p.s;
    this.lane = p.lane;
    this.land.road.ensure(p.s + 2000);
    Object.assign(this.motion, { vy: 0, r: 0, delta: 0 });
  }

  /** Carries the trip on from an earlier visit. */
  set trip(m: number) {
    this.distance = m;
  }

  /** Saved map tiles to use instead of building them. */
  primeTiles(tiles: Map<string, import("./world").TileData>): void {
    this.world.prime(tiles);
  }

  /** Tiles built since last asked, to keep for next time. */
  takeFreshTiles() {
    return this.world.takeFresh();
  }

  /** Puts the car on the road at arc length s, `lane` metres right of the centre, facing along it. */
  private putOnRoad(s: number, lane: number) {
    const p = this.land.road.at(s, this.pt);
    const [rx, rz] = rightOf(p.heading);
    this.s = s;
    this.lane = lane;
    this.fx = p.x + rx * lane;
    this.fz = p.z + rz * lane;
    this.yaw = p.heading;
    this.camYaw = p.heading;
    Object.assign(this.motion, { vy: 0, r: 0, delta: 0 });
    this.footing = null;
  }

  /** Back to the nearest bit of road, in the right-hand lane, pointing the way the road goes. */
  resetToRoad(): void {
    this.lastD = NaN;
    const f = this.probe.at(this.fx, this.fz);
    this.putOnRoad(Number.isFinite(f.s) ? f.s : this.s, LANE_OFFSET);
    this.cine = null;
    this.place(0);
    this.placeCamera(0, this.camMode, 0, true);
  }

  setCar(cfg: VehicleConfig): void {
    this.carRoot.clear();
    this.car.dispose();
    this.car = buildCar(cfg);
    this.chassis = chassisOf(cfg, this.car.length);
    this.mountCar();
  }

  private mountCar() {
    const inner = this.car.root;
    inner.position.x = -this.car.length / 2; // the car's middle sits on the road point
    this.carRoot.add(inner);
    this.flames?.dispose();
    this.flames = new ExhaustFlames(this.car.exhausts);
    this.car.body.add(this.flames.group);
  }

  /** Fire from the exhaust: a backfire's bang, an overrun pop, a hard upshift's crack. */
  burst(kind: "bang" | "pop" | "crack"): void {
    this.flames.burst(kind);
  }

  resize(w: number, h: number, dpr: number): void {
    this.size = { w, h };
    this.dpr = dpr;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applySize();
  }

  private applySize() {
    const pr = this.dpr * this.quality;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.size.w, this.size.h);
    this.bloom.resolution.set(this.size.w * pr * 0.4, this.size.h * pr * 0.4);
  }

  /** The graphics settings: resolution, how far out the world is built, shadows, glow, clouds, field of view. */
  setGraphics(g: Graphics): void {
    this.fixedScale = g.scale === "auto" ? null : g.scale;
    if (this.fixedScale !== null && this.fixedScale !== this.quality) {
      this.quality = this.fixedScale;
      this.applySize();
    }
    if (this.fixedScale === null && this.quality > 1) {
      this.quality = 1;
      this.applySize();
    }
    this.world.setRange(g.range);
    this.atmo.setQuality(g.shadows, g.clouds);
    this.bloomAllowed = g.bloom;
    this.fovBase = g.fov;
    // the light is worked out again next frame (shadows and glow go with it)
    this.lastLook = "";
  }

  /** The share of full resolution being drawn right now. */
  get renderScale(): number {
    return this.quality;
  }

  /** Turns the chase camera round the car (a mouse or finger drag, in pixels). */
  nudgeOrbit(dx: number, dy: number): void {
    this.orbit.yaw += dx * 0.006;
    this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy * 0.004, -0.25, 0.9);
    this.orbit.at = this.time;
  }

  /** Total distance driven, m. */
  get trip(): number {
    return this.distance;
  }

  get freeRoam(): boolean {
    return this.free;
  }

  /**
   * Free roam on: the lane assist lets go, and the car goes where it's steered. Off: the assist
   * takes it back. If it has wandered far from the road, it's put back on it.
   */
  setFreeRoam(on: boolean): void {
    if (on === this.free) return;
    this.free = on;
    this.cine = null;
    if (!on) {
      const f = this.probe.at(this.fx, this.fz);
      if (!Number.isFinite(f.d) || Math.abs(f.d) > ROAD_HALF + 8) this.resetToRoad();
      else this.lane = Math.max(-ROAD_HALF + 1, Math.min(ROAD_HALF - 1, f.d));
    }
  }

  /** The slope along the car (rise per metre), for gravity in the simulation. */
  get grade(): number {
    return Math.tan(this.tiltP);
  }

  /** Underfoot in free roam: what slows the car (grass, dirt, water) and whether it's run into deep water. */
  get surface(): { offRoad: boolean; depth: number; blocked: boolean; slide: number } {
    const f = this.footing;
    return { offRoad: !!f && !f.road, depth: f ? f.depth : 0, blocked: this.blocked, slide: this.slide };
  }

  /** The road ahead, for a driver (or the autopilot) choosing a speed: tightest bend within `ahead` m. */
  bendAhead(ahead: number): { curvature: number; at: number }[] {
    const out: { curvature: number; at: number }[] = [];
    if (this.free) return out; // off the road there are no bends to read: just the set speed
    for (let x = 0; x <= ahead; x += 10) out.push({ curvature: Math.abs(this.land.road.curvatureAt(this.s + x)), at: x });
    return out;
  }

  frame(dt: number, drive: Drive, look: Look): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    // adaptive resolution, held to the target frame rate: frames are capped (at the screen's rate
    // or the chosen frame rate), so "room to spare" can't be
    // seen directly. Step down when frames are missed; after a few steady seconds try a step
    // up, but not back to a level that missed recently (that ceiling relaxes over time).
    this.frameMs = this.frameMs * 0.9 + dt * 1000 * 0.1;
    const target = this.targetMs;
    this.steady = this.frameMs < target * 1.08 ? this.steady + dt : 0;
    this.ceiling = Math.min(1, this.ceiling + dt * 0.004);
    let next = this.quality;
    if (this.fixedScale !== null) next = this.fixedScale;
    else if (this.frameMs > target * 1.25 && this.time - this.qualityAt > 0.5) {
      this.ceiling = this.quality - 0.05;
      next = Math.max(0.5, this.quality - 0.1);
    } else if (this.steady > 3 && this.quality < Math.min(1, this.ceiling)) {
      next = Math.min(this.ceiling, this.quality + 0.05);
      this.steady = 0;
    }
    if (next !== this.quality) {
      this.quality = next;
      this.qualityAt = this.time;
      this.frameMs = target;
      this.applySize();
    }

    const v = drive.speedKmh / 3.6;
    this.distance += v * dt;
    this.spin = drive.wheelspin;
    this.drive(drive, v, dt);
    const accel = dt > 0 ? (v - this.prevV) / dt : 0;
    this.accelSm = damp(this.accelSm, accel, 3, dt);
    this.prevV = v;
    // the body on its springs: squats under power, dives on the brakes
    // (about a degree and a half nose-down under hard braking: a real car's dive)
    const pitchTarget = THREE.MathUtils.clamp(accel * 0.0028, -0.026, 0.018);
    this.pitchVel += ((pitchTarget - this.pitch) * 140 - this.pitchVel * 14) * dt;
    this.pitch += this.pitchVel * dt;

    this.applyLook(look, false);
    this.place(dt);
    const heading = this.yaw;
    this.world.update(this.camera.position.x, this.camera.position.z, this.s);
    this.updateLights(drive);
    this.placeCamera(dt, look.camera, v, false);
    this.updateRain(look.weather === "rain", v, heading);
    this.world.animate(this.time, look.weather === "rain" ? 1 : look.weather === "fog" ? 0.25 : 0);
    this.kickUp(dt, v);
    this.flames.update(dt, this.time);
    this.layRubber(v, drive);
    this.puffs.update(dt, 0.3 + 0.7 * (1 - this.atmo.light.night), this.size.h * this.renderer.getPixelRatio(), this.camera.fov);
    this.atmo.follow(this.camera.position, this.carRoot.position, this.time);
    if (this.bloomOn) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** What's under the tyres, and its grip for an ordinary road tyre. */
  private ground(): { name: string; mu: number; loose: boolean } {
    const f = this.footing;
    if (!f) return { name: "Tarmac", mu: 1, loose: false };
    if (f.depth > 0.05) return { name: "Water", mu: 0.35, loose: true };
    if (f.road) return this.atmo.light.wet > 0 ? { name: "Wet tarmac", mu: 0.72, loose: false } : { name: "Tarmac", mu: 1, loose: false };
    const wet = this.atmo.light.wet > 0 ? 0.8 : 1;
    // grass grips better than loose dry dirt and sand
    return f.dry > 0.6 ? { name: "Dirt", mu: 0.55 * wet, loose: true } : { name: "Grass", mu: (0.64 - 0.1 * f.dry) * wet, loose: true };
  }

  /** Grip under this car's tyres: the surface's, times what its tyres make of it. */
  private grip(): number {
    const g = this.ground();
    return g.mu * this.chassis.tyre * (g.loose ? this.chassis.offRoad : 1);
  }

  /**
   * The most force the driven wheels can put down before they spin, N: grip times the weight on
   * them. Weight moves onto the rear under power and up a hill (good for a rear-drive car); an
   * all-wheel-drive car has all four. Downforce adds to it at speed.
   */
  get traction(): number {
    return tractionLimit(this.chassis, this.grip(), this.accelSm, Math.tan(this.tiltP), this.prevV);
  }

  /** The most braking force the tyres can take here before the wheels lock, N. */
  get brakeGrip(): number {
    return brakeLimit(this.chassis, this.grip(), this.prevV);
  }

  /** The force the tyres are taking out of the car's speed through bends and slides, N. */
  get scrub(): number {
    return this.motion.scrub ?? 0;
  }

  /** Stability control is braking a wheel to keep the car in line. */
  get escActive(): boolean {
    return Boolean(this.motion.esc);
  }

  /** The car's own driver aids (ABS, traction and stability control). */
  get carAids(): Aids {
    return this.chassis.aids;
  }

  /** The surface under the car and how its grip compares with a road car's on dry tarmac. */
  get gripInfo(): { name: string; factor: number } {
    return { name: this.ground().name, factor: this.grip() };
  }

  /**
   * Moves the car: the tyre model turns steering into yaw and sideways slip, and the car goes
   * the way it's actually travelling. On the road the lane assist does the steering.
   */
  private drive(drive: Drive, v: number, dt: number) {
    const steer = this.free ? drive.steer : this.laneAssist(drive.steer, v, dt);
    this.slide = stepHandling(this.motion, this.chassis, { vx: v, steer, accel: this.accelSm, mu: this.grip(), aids: this.aids ?? undefined, locked: drive.locked, wheelspin: drive.wheelspin, assisted: !this.free }, dt);
    this.yaw += this.motion.r * dt;
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    const vy = this.motion.vy;
    let nx = this.fx + (c * v - sn * vy) * dt;
    let nz = this.fz + (sn * v + c * vy) * dt;
    // the guardrails: run into one and it stops you there
    const kept = this.railCheck(nx, nz, c * v - sn * vy, sn * v + c * vy, v);
    if (kept) [nx, nz] = kept;
    // deep water stops you at the edge; shallows you can splash through
    const ahead = this.probe.at(nx + c * this.car.length * 0.5, nz + sn * this.car.length * 0.5);
    this.blocked = ahead.depth > 1.1;
    if (!this.blocked) {
      this.fx = nx;
      this.fz = nz;
    } else this.motion.vy = 0;
    // too steep across: the car slides down the hill sideways
    const over = Math.abs(this.tiltR) - 0.5;
    if (over > 0 && !this.chassis.bike) {
      const down = -Math.sign(this.tiltR);
      this.fx += -sn * down * over * 9 * dt;
      this.fz += c * down * over * 9 * dt;
    }
  }

  /**
   * The guardrails, solid. If this step would carry the car through one (from the road, or
   * from the fields behind it) it stops at the rail: the speed along the rail is kept (less
   * the scrape), the speed into it is lost bar a small bounce, and the car is turned to glance
   * off along it. Sparks fly, the picture jolts, and the knock is handed to the engine.
   * Returns where the car ends up, or null if it hit nothing.
   */
  private railCheck(nx: number, nz: number, wx: number, wz: number, v: number): [number, number] | null {
    const f = this.probe.at(nx, nz);
    const was = this.lastD;
    this.lastD = f.d;
    if (!Number.isFinite(f.d) || !Number.isFinite(was)) return null;
    const side = (Math.abs(was) > 0.01 ? Math.sign(was) : Math.sign(f.d)) as 1 | -1;
    if (!this.world.barriers.has(f.s, side)) return null;
    const half = this.chassis.bike ? 0.4 : this.car.width / 2 + 0.08;
    const inner = BARRIER_D - half;
    const outer = BARRIER_D + half;
    const a0 = Math.abs(was);
    const a1 = side * f.d; // how far out on that side it would be
    let target: number;
    if (a0 <= inner + 0.02 && a1 > inner) target = inner;
    else if (a0 >= outer - 0.02 && a1 < outer) target = outer;
    else return null;
    const p = this.land.road.at(f.s, this.pt);
    const [rx, rz] = rightOf(p.heading);
    // the road's outward direction on that side, and along it
    const ox = rx * side;
    const oz = rz * side;
    const tx = Math.cos(p.heading);
    const tz = Math.sin(p.heading);
    const into = (wx * ox + wz * oz) * (target === inner ? 1 : -1); // speed towards the rail
    const along = wx * tx + wz * tz;
    const speed = Math.max(0.1, Math.hypot(wx, wz));
    // stay on the right side of it
    const push = (target - a1) * side;
    const cx = nx + rx * push;
    const cz = nz + rz * push;
    this.lastD = Number.isFinite(f.d) ? f.d + push : f.d;
    if (into > 0) {
      // the speed into the rail is gone (a tenth bounces back), the scrape costs some along it
      const keep = Math.abs(along) * (0.9 - Math.min(0.4, into * 0.02));
      const back = -into * 0.12 * (target === inner ? 1 : -1);
      const vx2 = tx * along * (keep / Math.max(0.1, Math.abs(along))) + ox * back;
      const vz2 = tz * along * (keep / Math.max(0.1, Math.abs(along))) + oz * back;
      const heading = Math.atan2(vz2, vx2);
      // glance off: the nose swings round towards where it's now going
      if (Math.hypot(vx2, vz2) > 1) this.yaw += wrapAngle(heading - this.yaw) * 0.55;
      this.motion.vy *= 0.2;
      this.motion.r *= 0.2;
      const share = Math.min(1, Math.hypot(vx2, vz2) / speed);
      this.impact = { share: Math.min(this.impact?.share ?? 1, share), strength: Math.max(this.impact?.strength ?? 0, into) };
      this.jolt = Math.max(this.jolt, Math.min(1, into / 8));
      // sparks off the steel where it touched
      const sparks = Math.min(40, 4 + into * 3 + v * 0.2);
      const at = new THREE.Vector3(cx + ox * half * (target === inner ? 1 : -1), 0, cz + oz * half * (target === inner ? 1 : -1));
      at.y = this.probe.at(at.x, at.z).y + 0.5;
      for (let i = 0; i < sparks; i++) {
        const r = () => (this.rand() - 0.5) * 2;
        this.puffs.emit(at.x, at.y, at.z, tx * along * 0.4 + r() * 2.5, 1.5 + this.rand() * 3, tz * along * 0.4 + r() * 2.5, 0.25 + this.rand() * 0.3, 0.06, SPARK, 1);
      }
    }
    return [cx, cz];
  }

  /**
   * The road round the car for the map: points every 10 m from a little behind to well ahead
   * (x, z, curvature, and which sides have a rail: bit 1 left, bit 2 right), and where the car
   * is and which way it's pointing.
   */
  route(behind = 200, ahead = 1600): { x: number; z: number; yaw: number; pts: Float32Array; from: number; s: number } {
    const road = this.land.road;
    const from = Math.max(0, this.s - behind);
    const n = Math.floor((ahead + (this.s - from)) / 10) + 1;
    const pts = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const sAt = from + i * 10;
      const p = road.at(sAt, this.pt);
      pts[i * 4] = p.x;
      pts[i * 4 + 1] = p.z;
      pts[i * 4 + 2] = p.curvature;
      pts[i * 4 + 3] = this.world.barriers.cell(Math.floor(sAt / 10));
    }
    return { x: this.fx, z: this.fz, yaw: this.yaw, pts, from, s: this.s };
  }

  /** The last knock against a rail since asked: the share of speed left, and how hard it was (m/s). */
  takeImpact(): { share: number; strength: number } | null {
    const hit = this.impact;
    this.impact = null;
    return hit;
  }

  /**
   * Lane assist: steers for a point on the lane a little way ahead (further at speed), the way
   * a driver looks up the road. A and D move that point across the road; let go and it drifts
   * back to the middle of the lane you're in. It always heads on along the road, never back.
   */
  private laneAssist(input: number, v: number, dt: number): number {
    const limit = ROAD_HALF - Math.min(1.05, this.car.width / 2 + 0.15);
    if (Math.abs(input) > 0.05) {
      this.lastSteerAt = this.time;
      this.lane += input * THREE.MathUtils.clamp(v * 0.12, 1.2, 3.5) * dt;
    } else if (this.time - this.lastSteerAt > 1.2) {
      this.lane = damp(this.lane, this.lane >= 0 ? LANE_OFFSET : -LANE_OFFSET, 1.4, dt);
    }
    this.lane = THREE.MathUtils.clamp(this.lane, -limit, limit);
    const look = 7 + v * 0.5;
    const p = this.land.road.at(this.s + look, this.pt);
    const [rx, rz] = rightOf(p.heading);
    const dx = p.x + rx * this.lane - this.fx;
    const dz = p.z + rz * this.lane - this.fz;
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    const ahead = dx * c + dz * sn;
    const side = -dx * sn + dz * c;
    const alpha = Math.atan2(side, ahead);
    // pure pursuit, less the yaw we already have (damps any sway)
    // the arc to that point, plus the extra lock the car's understeer needs to hold it
    const curv = (2 * Math.sin(alpha)) / Math.max(4, Math.hypot(dx, dz));
    const delta = Math.atan(this.chassis.wheelbase * curv) + UNDERSTEER * v * v * curv - this.motion.r * 0.04;
    return THREE.MathUtils.clamp(delta / steerLock(v), -1, 1);
  }

  /** Stands the car on whatever is under its four corners, tilting with the slope, and rolls the body. */
  private place(dt: number) {
    const bike = this.chassis.bike;
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    const f = this.probe.at(this.fx, this.fz);
    this.footing = f;
    if (Number.isFinite(f.s)) this.s = f.s;
    // the ground under each tyre, where the tyres actually are
    const spots = this.car.wheels.map((w) => {
      const x = w.node.position.x - this.car.length / 2;
      const z = w.node.position.z;
      return { x, z, h: this.probe.at(this.fx + c * x - sn * z, this.fz + sn * x + c * z).y };
    });
    const avg = (pick: (p: (typeof spots)[number]) => boolean) => {
      const ps = spots.filter(pick);
      if (!ps.length) return null;
      const mean = (get: (p: (typeof spots)[number]) => number) => ps.reduce((a, p) => a + get(p), 0) / ps.length;
      return { h: mean((p) => p.h), at: mean((p) => p.x), z: mean((p) => p.z) };
    };
    const front = avg((p) => p.x > 0);
    const rear = avg((p) => p.x <= 0);
    const left = avg((p) => p.z < -0.01);
    const right = avg((p) => p.z > 0.01);
    const pitch = front && rear ? Math.atan2(front.h - rear.h, front.at - rear.at) : 0;
    const roll = !bike && left && right ? Math.atan2(left.h - right.h, right.z - left.z) : 0;
    if (!dt) {
      this.tiltP = pitch;
      this.tiltR = roll;
    } else {
      this.tiltP = damp(this.tiltP, pitch, 18, dt);
      this.tiltR = damp(this.tiltR, roll, 18, dt);
    }
    // stood so no tyre is below the ground at the tilt it has now (a contact point at (x, z) on
    // the car sits x·sin(pitch) - z·sin(roll)·cos(pitch) above the car's origin)
    const sP = Math.sin(this.tiltP);
    const sR = Math.sin(this.tiltR) * Math.cos(this.tiltP);
    let y = spots.length ? Math.max(...spots.map((p) => p.h - (p.x * sP - p.z * sR))) : f.y;
    // in the shallows the wheels stay on the bed
    if (f.depth > 0) y = Math.max(y, WATER_Y - 0.5);
    // settling down is eased; rising never lags (that's what put cars into hillsides)
    this.carY = !dt ? y : Math.max(y, damp(this.carY, y, 20, dt));
    const v = this.prevV;
    const latAccel = v * this.motion.r;
    // cars roll out of a bend on their springs; bikes lean into it
    // (a real car rolls 2-3 degrees at 1 g)
    const rollTarget = bike ? Math.atan(latAccel / G) : THREE.MathUtils.clamp(-latAccel * 0.0045, -0.04, 0.04);
    this.roll = dt ? damp(this.roll, rollTarget, 6, dt) : rollTarget;
    // off the tarmac the body jiggles over the rough ground
    const rough = f.road ? 0 : Math.min(1, v / 12) * 0.018;
    this.car.body.position.y = rough * (Math.sin(this.time * 31) * 0.6 + Math.sin(this.time * 17.3) * 0.4);
    this.carRoot.position.set(this.fx, this.carY, this.fz);
    this.carRoot.rotation.set(this.tiltR + (bike ? this.roll : 0), -this.yaw, this.tiltP, "YZX");
    // the body pitches and rolls about its middle, at about hub height, not about the road
    const bodyRoll = bike ? 0 : this.roll;
    this.car.body.rotation.set(bodyRoll, 0, this.pitch);
    const pivot = this.pivot.set(this.car.length / 2, this.car.wheelbaseMid + 0.12, 0);
    const turned = this.turned.copy(pivot).applyEuler(this.car.body.rotation);
    this.car.body.position.x = pivot.x - turned.x;
    this.car.body.position.y += pivot.y - turned.y;
    this.car.body.position.z = pivot.z - turned.z;
    for (const w of this.car.wheels) w.node.rotation.set(0, w.front ? -this.motion.delta : 0, -this.distance / w.r, "YZX");
  }

  /**
   * Skid marks under any tyre that's sliding: the driven ones when they spin, the rears in a
   * drift, all four when the brakes lock. Black rubber on the road, dark ruts off it.
   */
  private layRubber(v: number, drive: Drive) {
    const f = this.footing;
    const onRoad = !f || f.road;
    const ground = onRoad ? RUBBER : RUT;
    const rearSlide = Math.max(0, this.slide - 0.25) / 0.75;
    const at = this.rubberAt;
    const fwd = this.rubberFwd.set(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    this.car.wheels.forEach((w, i) => {
      const driven = w.front ? this.chassis.rearDrive < 1 : true;
      let amount = Math.max(drive.locked ? 0.9 : 0, w.front ? rearSlide * 0.35 : rearSlide, driven ? Math.max(0, this.spin - 0.15) * 1.4 : 0);
      if (v < 0.5 && this.spin < 0.2) amount = 0;
      if (f && f.depth > 0.05) amount = 0; // nothing to mark under water
      w.node.getWorldPosition(at);
      at.y = this.probe.at(at.x, at.z).y;
      this.skids.lay(i, at, fwd, this.chassis.bike ? 0.12 : 0.22, Math.min(1, amount), ground);
    });
  }

  /** What the rear wheels throw up: dust off the road, spray in water, a mist on wet tarmac. */
  private kickUp(dt: number, v: number) {
    const f = this.footing;
    let kind: "dust" | "spray" | "mist" | "smoke" | null = null;
    const spin = this.spin;
    if (f && f.depth > 0.05 && (v > 1 || spin > 0.2)) kind = "spray";
    else if (f && !f.road && (v > 2 || spin > 0.2)) kind = "dust";
    else if (spin > 0.25 || this.slide > 0.45) kind = "smoke";
    else if (this.atmo.light.wet > 0 && v > 12) kind = "mist";
    if (!kind) {
      this.puffDue = 0;
      return;
    }
    // spinning wheels throw it up even standing still
    // a drift or a burnout pours out smoke, more the harder and faster the tyres are sliding
    const rate = kind === "smoke" ? (30 + v * 1.2) * Math.max(spin, this.slide) : (kind === "spray" ? 1.5 : kind === "dust" ? 0.9 : 0.35) * Math.max(v, spin * 20);
    this.puffDue += rate * dt;
    if (this.puffDue < 1) return;
    const color =
      kind === "dust"
        ? srgbColor(0.3, 0.24, 0.16).lerp(srgbColor(0.74, 0.64, 0.46), f?.dry ?? 0.5)
        : kind === "spray"
          ? srgbColor(0.86, 0.9, 0.95)
          : kind === "smoke"
            ? srgbColor(0.88, 0.88, 0.9)
            : srgbColor(0.72, 0.74, 0.78);
    const [life, size, opacity, lift] =
      kind === "dust" ? [1.7, 0.7, 0.35 + 0.3 * (f?.dry ?? 0.5), 1.4] : kind === "spray" ? [0.9, 0.5, 0.6, 3] : kind === "smoke" ? [3.2, 1.3, 0.38, 0.7] : [0.8, 0.9, 0.16, 0.6];
    this.carRoot.updateMatrixWorld(true);
    const fwd = tmpV.set(1, 0, 0).transformDirection(this.carRoot.matrixWorld).clone();
    const at = new THREE.Vector3();
    while (this.puffDue >= 1) {
      this.puffDue -= 1;
      for (const w of this.car.wheels) {
        if (w.front) continue;
        w.node.getWorldPosition(at);
        const r = () => (this.rand() - 0.5) * 2;
        // (smoke starts above the road so its puffs don't cut flat where they meet it)
        const y0 = kind === "smoke" ? at.y + size * 0.25 : at.y - w.r * 0.6;
        this.puffs.emit(at.x + r() * 0.2, y0, at.z + r() * 0.2, -fwd.x * v * 0.12 + r(), lift * (0.6 + this.rand() * 0.6), -fwd.z * v * 0.12 + r(), life * (0.7 + this.rand() * 0.6), size, color, opacity);
      }
    }
  }

  private updateLights(drive: Drive) {
    const night = this.atmo.light.night;
    const dim = Math.max(night, this.atmo.light.wet * 0.6);
    this.car.tail.emissiveIntensity = drive.ignition ? 0.35 + dim * 1.4 + drive.brake * 3.2 : 0.05;
    this.car.head.emissiveIntensity = drive.ignition ? 0.6 + dim * 4 : 0.05;
    // the headlights' beam on the road ahead
    const on = drive.ignition ? dim : 0;
    this.beam.intensity = on * 900;
    this.beam.visible = on > 0.02;
    if (this.beam.visible) {
      const lamp = this.car.headlights[0] ?? new THREE.Vector3(this.car.length, 0.6, 0);
      this.carRoot.updateMatrixWorld();
      this.beam.position.copy(this.car.root.localToWorld(tmpV.set(lamp.x, lamp.y + 0.1, 0)));
      this.beam.target.position.copy(this.car.root.localToWorld(tmpV.set(lamp.x + 30, -1.5, 0)));
      this.beam.target.updateMatrixWorld();
    }
  }

  private applyLook(look: Look, force: boolean) {
    const key = `${look.hour.toFixed(3)}|${look.weather}`;
    if (!force && key === this.lastLook) return;
    this.lastLook = key;
    this.atmo.set(look.hour, look.weather, this.scene);
    const L = this.atmo.light;
    this.world.setLight(L.wet, L.night);
    this.bloom.strength = 0.3 + L.night * 0.5;
    this.bloomOn = this.bloomAllowed && (L.night > 0.15 || L.wet > 0);
  }

  private placeCamera(dt: number, mode: CameraMode, v: number, snap: boolean) {
    if (mode !== this.camMode) {
      this.camMode = mode;
      this.cine = null;
      snap = true;
    }
    const cam = this.camera;
    const car = this.carRoot;
    car.updateMatrixWorld();
    if (mode !== "chase" && mode !== "far") this.lastCarPos.copy(car.position);
    if (snap) this.lastCarPos.copy(car.position);
    const fwd = tmpV.set(1, 0, 0).transformDirection(car.matrixWorld).clone();
    fwd.y = 0;
    fwd.normalize();
    const carPos = car.position;
    const tall = this.car.width < 1 ? 1.1 : 0.9;

    if (mode === "hood") {
      const eye = this.car.root.localToWorld(new THREE.Vector3(this.car.length * (this.car.width < 1 ? 0.45 : 0.62), this.car.width < 1 ? 1.45 : 1.18, 0));
      cam.position.copy(eye);
      cam.up.set(0, 1, 0);
      const ahead = this.car.root.localToWorld(new THREE.Vector3(this.car.length + 25, 0.6, 0));
      this.camLook.copy(ahead);
      cam.lookAt(this.camLook);
      cam.fov = damp(cam.fov, this.fovBase + 10 + v * 0.06, 3, dt || 1);
      cam.updateProjectionMatrix();
      return;
    }

    if (mode === "cinematic") {
      // a camera by the road ahead; the car drives up to it and past, then the next one is set up
      const passed = this.cine && (this.free ? fwd.dot(carPos.clone().sub(this.cine.pos)) > 28 || carPos.distanceTo(this.cine.pos) > 320 : this.s > this.cine.s + 28);
      if (!this.cine || passed) {
        const ahead = 110 + this.rand() * 90;
        const side = this.rand() < 0.5 ? -1 : 1;
        const high = this.rand() < 0.25;
        const lift = high ? 9 + this.rand() * 10 : 1.2 + this.rand() * 3;
        let pos: THREE.Vector3;
        if (this.free) {
          // ahead of wherever the car is pointing, off to one side, standing on the ground
          const off = side * (8 + this.rand() * 18);
          const x = carPos.x + fwd.x * ahead - fwd.z * off;
          const z = carPos.z + fwd.z * ahead + fwd.x * off;
          pos = new THREE.Vector3(x, Math.max(this.probe.at(x, z).y, WATER_Y) + lift, z);
        } else {
          const p = this.land.road.at(this.s + ahead);
          const [rx, rz] = rightOf(p.heading);
          const off = side * (ROAD_HALF + 4 + this.rand() * 14);
          const x = p.x + rx * off;
          const z = p.z + rz * off;
          pos = new THREE.Vector3(x, Math.max(p.y, this.probe.at(x, z).y) + lift, z);
        }
        this.cine = { pos, s: this.s + ahead, fov: high ? 50 : 26 + this.rand() * 18 };
        snap = true;
      }
      cam.position.copy(this.cine.pos);
      const target = carPos.clone().add(new THREE.Vector3(0, tall * 0.7, 0));
      if (snap) this.camLook.copy(target);
      else this.camLook.lerp(target, 1 - Math.exp(-dt * 8));
      cam.lookAt(this.camLook);
      // zoom in as the car comes close, so it stays a good size in the frame
      const dist = cam.position.distanceTo(carPos);
      cam.fov = THREE.MathUtils.clamp((this.cine.fov * 60) / Math.max(25, dist), 12, this.cine.fov);
      cam.updateProjectionMatrix();
      return;
    }

    // chase, far and drone follow the way the car is travelling (its heading plus any slide),
    // turning a moment after it does, so a bend or a slide shows the car a little from the side
    const v2 = Math.max(v, 3);
    const travel = this.yaw + Math.atan2(this.motion.vy, v2) * 0.5;
    // brisk round town, floatier at speed so a quick correction doesn't jerk the picture
    const follow = mode === "drone" ? 2 : THREE.MathUtils.lerp(4.5, 2.4, THREE.MathUtils.clamp((v - 15) / 30, 0, 1));
    if (snap) this.camYaw = travel;
    else this.camYaw += wrapAngle(travel - this.camYaw) * (1 - Math.exp(-follow * dt));
    const settle = this.time - this.orbit.at > 2.5;
    if (settle) {
      this.orbit.yaw = damp(this.orbit.yaw, 0, 2, dt || 1);
      this.orbit.pitch = damp(this.orbit.pitch, 0, 2, dt || 1);
    }
    // a tall, narrow screen crops the sides: stand further back and higher so the car still fits
    const narrow = Math.pow(THREE.MathUtils.clamp(1.25 / cam.aspect, 1, 2.6), 0.85);
    const size = (this.car.length - 4.5) * 0.6;
    const [baseBack, baseUp] = mode === "far" ? [10.5, 3.4] : mode === "drone" ? [16, 17] : [5.0, 1.5];
    // a little further back while it pulls hard, closer as it brakes: you feel the speed
    const surge = mode === "drone" ? 0 : THREE.MathUtils.clamp(this.accelSm * 0.12, -0.5, 0.9);
    const back = (baseBack + Math.min(v, 70) * (mode === "far" ? 0.02 : 0.012) + size + surge) * narrow;
    const up = baseUp * Math.pow(narrow, 1.15);
    const yaw = this.camYaw + Math.PI + this.orbit.yaw;
    const pitch = Math.atan2(up, back) + this.orbit.pitch;
    const r = Math.hypot(up, back);
    const want = new THREE.Vector3(
      carPos.x + Math.cos(yaw) * Math.cos(pitch) * r,
      carPos.y + Math.sin(pitch) * r,
      carPos.z + Math.sin(yaw) * Math.cos(pitch) * r,
    );
    // never down in the ground (or a hillside): at least a metre over whatever is under the camera
    want.y = Math.max(want.y, this.probe.at(want.x, want.z).y + 1, WATER_Y + 0.5);
    if (snap) cam.position.copy(want);
    else {
      cam.position.x = want.x;
      cam.position.z = want.z;
      // height eases, so bumps and crests don't shake the picture
      cam.position.y = damp(cam.position.y, want.y, 6, dt);
    }
    const ahead = mode === "drone" ? 6 : 4 + Math.min(v, 50) * 0.06;
    const look = carPos.clone().add(new THREE.Vector3(Math.cos(this.camYaw) * ahead, mode === "drone" ? 0 : tall * 0.95, Math.sin(this.camYaw) * ahead));
    if (snap) this.camLook.copy(look);
    else this.camLook.lerp(look, 1 - Math.exp(-dt * 14));
    this.lastCarPos.copy(carPos);
    cam.lookAt(this.camLook);
    // the road comes up through the camera: a fine hum at speed on tarmac, a jolt and a judder
    // over rough ground, a shudder in a slide
    if (mode !== "drone" && dt) {
      const f = this.footing;
      const rough = f && !f.road ? Math.min(1, v / 15) * 0.006 : 0;
      const hum = Math.min(1, (v / 70) ** 2) * 0.0011;
      this.jolt = Math.max(0, this.jolt - dt * 3);
      const shake = hum + rough + this.slide * 0.0018 + this.jolt * 0.02;
      const t = this.time;
      cam.rotateX(shake * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 61.7) * 0.4));
      cam.rotateY(shake * 0.6 * (Math.sin(t * 29.3 + 1.3) * 0.7 + Math.sin(t * 53.9) * 0.3));
    }
    // the faster you go, the wider it opens up
    const fov0 = this.fovBase + (mode === "far" ? -8 : mode === "drone" ? -13 : 0);
    cam.fov = damp(cam.fov, fov0 + Math.min(v, 80) * 0.18, 2, dt || 1);
    cam.updateProjectionMatrix();
  }

  private updateRain(on: boolean, v: number, heading: number) {
    this.rain.visible = on;
    if (!on) return;
    const pos = this.rain.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const c = this.camera.position;
    const n = this.rainSeeds.length / 3;
    const BOX = 26;
    const FALL = 14;
    const wrap = (v: number) => ((v % BOX) + BOX) % BOX - BOX / 2;
    // each drop has a fixed place in the world, wrapped into a box round the camera, so the
    // car drives through them; streaks slant back against its motion
    const fx = Math.cos(heading) * v * 0.025;
    const fz = Math.sin(heading) * v * 0.025;
    for (let i = 0; i < n; i++) {
      const px = c.x + wrap(this.rainSeeds[i * 3] * BOX - c.x);
      const pz = c.z + wrap(this.rainSeeds[i * 3 + 2] * BOX - c.z);
      const py = c.y - 6 + (1 - ((this.time * FALL) / BOX + this.rainSeeds[i * 3 + 1]) % 1) * BOX * 0.6;
      arr.set([px, py, pz, px + fx * 0.6, py + 0.32, pz + fz * 0.6], i * 6);
    }
    pos.needsUpdate = true;
  }

  dispose(): void {
    this.car.dispose();
    this.world.dispose();
    this.atmo.dispose();
    this.rain.geometry.dispose();
    this.rain.material.dispose();
    this.puffs.dispose();
    this.flames.dispose();
    this.skids.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
