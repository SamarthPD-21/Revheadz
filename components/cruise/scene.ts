import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { mulberry32 } from "../../lib/cruise/noise";
import { GroundProbe, type Footing } from "../../lib/cruise/ground";
import { LANE_OFFSET, ROAD_HALF, WATER_Y, rightOf, surfaceY, bankOf, type RoadPoint } from "../../lib/cruise/road";
import { Landscape } from "../../lib/cruise/terrain";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { Atmosphere, type Weather } from "./atmosphere";
import { buildCar, type CarModel } from "./carModel";
import { World } from "./world";

export type CameraMode = "chase" | "far" | "hood" | "cinematic";
export const CAMERA_MODES: CameraMode[] = ["chase", "far", "hood", "cinematic"];
export type { Weather };

/** What the scene needs from the car and the driver each frame. */
export interface Drive {
  speedKmh: number;
  /** Brake pedal, 0-1 (taillights). */
  brake: number;
  /** -1 full left .. 1 full right; 0 lets the lane assist take it back to the lane. */
  steer: number;
  ignition: boolean;
}

export interface Look {
  hour: number;
  weather: Weather;
  camera: CameraMode;
}

const G = 9.81;
const tmpV = new THREE.Vector3();
const damp = (current: number, target: number, rate: number, dt: number) => current + (target - current) * (1 - Math.exp(-rate * dt));

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

  /** Distance along the road, m (in free roam: of the nearest road point, for laying the world out). */
  s: number;
  /** Free roam: the car goes wherever it's steered, over the ground, not along the road. */
  private free = false;
  private readonly probe: GroundProbe;
  private fx = 0;
  private fz = 0;
  private yaw = 0;
  private steerAng = 0;
  private yawRate = 0;
  private carY = 0;
  private tiltP = 0;
  private tiltR = 0;
  private footing: Footing | null = null;
  private blocked = false;
  /** Lateral offset from the centre line, + right, m. */
  private d = LANE_OFFSET;
  private dVel = 0;
  private lastSteerAt = -10;
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
    this.mountCar();
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

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  /** Builds the world around the start (slow: do it behind a loading screen). */
  warmUp(look: Look): void {
    const p = this.land.road.at(this.s, this.pt);
    this.applyLook(look, true);
    this.world.warmUp(p.x, p.z, this.s);
    this.placeCar(0);
    this.placeCamera(0, look.camera, 0, true);
  }

  setCar(cfg: VehicleConfig): void {
    this.carRoot.clear();
    this.car.dispose();
    this.car = buildCar(cfg);
    this.mountCar();
  }

  private mountCar() {
    const inner = this.car.root;
    inner.position.x = -this.car.length / 2; // the car's middle sits on the road point
    this.carRoot.add(inner);
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

  /** Turns the chase camera round the car (a mouse or finger drag, in pixels). */
  nudgeOrbit(dx: number, dy: number): void {
    this.orbit.yaw += dx * 0.006;
    this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy * 0.004, -0.25, 0.9);
    this.orbit.at = this.time;
  }

  /** Total distance driven since this scene started, m. */
  get trip(): number {
    return this.distance;
  }

  get freeRoam(): boolean {
    return this.free;
  }

  /**
   * Leaves the road to drive anywhere, or comes back to it: onto the road where you are if
   * you're on or near it, otherwise to the nearest bit of road (or where you left it).
   */
  setFreeRoam(on: boolean): void {
    if (on === this.free) return;
    if (on) {
      const p = this.land.road.at(this.s, this.pt);
      this.fx = this.carRoot.position.x;
      this.fz = this.carRoot.position.z;
      this.carY = this.carRoot.position.y;
      this.yaw = p.heading + Math.atan2(this.dVel, Math.max(this.prevV, 3));
      this.steerAng = 0;
    } else {
      const f = this.probe.at(this.fx, this.fz);
      const limit = ROAD_HALF - Math.min(1.05, this.car.width / 2 + 0.15);
      if (Number.isFinite(f.s)) {
        this.s = f.s;
        this.d = Math.abs(f.d) < limit ? f.d : LANE_OFFSET;
      } else this.d = LANE_OFFSET;
      this.dVel = 0;
    }
    this.free = on;
    this.cine = null;
  }

  /** The slope along the car (rise per metre), for gravity in the simulation. */
  get grade(): number {
    if (this.free) return Math.tan(this.tiltP);
    return this.land.road.at(this.s, this.pt).grade;
  }

  /** Underfoot in free roam: what slows the car (grass, dirt, water) and whether it's run into deep water. */
  get surface(): { offRoad: boolean; depth: number; blocked: boolean } {
    const f = this.footing;
    return { offRoad: this.free && !!f && !f.road, depth: this.free && f ? f.depth : 0, blocked: this.free && this.blocked };
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
    // adaptive resolution: frames are capped at the screen's rate, so "room to spare" can't be
    // seen directly. Step down when frames are missed; after a few steady seconds try a step
    // up, but not back to a level that missed recently (that ceiling relaxes over time).
    this.frameMs = this.frameMs * 0.9 + dt * 1000 * 0.1;
    this.steady = this.frameMs < 18 ? this.steady + dt : 0;
    this.ceiling = Math.min(1, this.ceiling + dt * 0.004);
    let next = this.quality;
    if (this.frameMs > 21 && this.time - this.qualityAt > 0.5) {
      this.ceiling = this.quality - 0.05;
      next = Math.max(0.5, this.quality - 0.1);
    } else if (this.steady > 3 && this.quality < this.ceiling) {
      next = Math.min(this.ceiling, this.quality + 0.05);
      this.steady = 0;
    }
    if (next !== this.quality) {
      this.quality = next;
      this.qualityAt = this.time;
      this.frameMs = 16.7;
      this.applySize();
    }

    const v = drive.speedKmh / 3.6;
    this.distance += v * dt;
    if (this.free) this.driveFree(drive, v, dt);
    else {
      this.s += v * dt;
      this.steer(drive, v, dt);
    }
    const accel = dt > 0 ? (v - this.prevV) / dt : 0;
    this.prevV = v;
    // the body on its springs: squats under power, dives on the brakes
    const pitchTarget = THREE.MathUtils.clamp(accel * 0.0065, -0.05, 0.035);
    this.pitchVel += ((pitchTarget - this.pitch) * 140 - this.pitchVel * 14) * dt;
    this.pitch += this.pitchVel * dt;

    this.applyLook(look, false);
    if (this.free) this.placeFree(dt);
    else this.placeCar(dt);
    const heading = this.free ? this.yaw : this.land.road.at(this.s, this.pt).heading;
    this.world.update(this.camera.position.x, this.camera.position.z, this.s);
    this.updateLights(drive);
    this.placeCamera(dt, look.camera, v, false);
    this.updateRain(look.weather === "rain", v, heading);
    this.atmo.follow(this.camera.position, this.carRoot.position);
    if (this.bloomOn) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  private steer(drive: Drive, v: number, dt: number) {
    const limit = ROAD_HALF - Math.min(1.05, this.car.width / 2 + 0.15);
    let want: number;
    if (Math.abs(drive.steer) > 0.05) {
      this.lastSteerAt = this.time;
      want = drive.steer * THREE.MathUtils.clamp(v * 0.22, 1.2, 5.5);
    } else {
      // lane assist: after a moment hands-off, ease back to the middle of whichever lane we're in
      const lane = this.d >= 0 ? LANE_OFFSET : -LANE_OFFSET;
      want = this.time - this.lastSteerAt > 1.2 ? THREE.MathUtils.clamp((lane - this.d) * 0.8, -1.4, 1.4) : 0;
    }
    if (v < 0.5) want = 0;
    this.dVel = damp(this.dVel, want, 5, dt);
    this.d += this.dVel * dt;
    if (Math.abs(this.d) > limit) {
      this.d = Math.sign(this.d) * limit;
      this.dVel = 0;
    }
  }

  /**
   * Free roam: a bicycle model. The steering lock shrinks with speed, and the yaw rate is
   * capped by grip (less of it off the tarmac), so asking too much just runs wide.
   */
  private driveFree(drive: Drive, v: number, dt: number) {
    const bike = this.car.width < 1;
    const wheelbase = bike ? 1.45 : THREE.MathUtils.clamp(this.car.length * 0.6, 2.3, 3.0);
    const lock = THREE.MathUtils.clamp(0.62 / (1 + v / 9), 0.06, 0.6);
    this.steerAng = damp(this.steerAng, drive.steer * lock, 8, dt);
    const grip = this.footing?.road === false ? 5.5 : 8.5;
    const maxRate = grip / Math.max(v, 1);
    this.yawRate = THREE.MathUtils.clamp((v * Math.tan(this.steerAng)) / wheelbase, -maxRate, maxRate);
    this.yaw += this.yawRate * dt;
    const nx = this.fx + Math.cos(this.yaw) * v * dt;
    const nz = this.fz + Math.sin(this.yaw) * v * dt;
    // deep water stops you at the edge; shallows you can splash through
    const ahead = this.probe.at(nx + Math.cos(this.yaw) * this.car.length * 0.5, nz + Math.sin(this.yaw) * this.car.length * 0.5);
    this.blocked = ahead.depth > 1.1;
    if (!this.blocked) {
      this.fx = nx;
      this.fz = nz;
    }
    // too steep across: the car slides down the hill sideways
    const over = Math.abs(this.tiltR) - 0.5;
    if (over > 0 && this.car.width >= 1) {
      const down = -Math.sign(this.tiltR); // + right when the left side is higher
      this.fx += -Math.sin(this.yaw) * down * over * 9 * dt;
      this.fz += Math.cos(this.yaw) * down * over * 9 * dt;
    }
  }

  /** Free roam: stand the car on the ground under its four corners, tilting with the slope. */
  private placeFree(dt: number) {
    const bike = this.car.width < 1;
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    const L = this.car.length * 0.42;
    const W = Math.max(0.3, this.car.width * 0.42);
    const at = (fwd: number, side: number) => this.probe.at(this.fx + c * fwd - sn * side, this.fz + sn * fwd + c * side).y;
    const f = this.probe.at(this.fx, this.fz);
    this.footing = f;
    if (Number.isFinite(f.s)) this.s = f.s;
    const hf = at(L, 0);
    const hb = at(-L, 0);
    const hl = at(0, -W);
    const hr = at(0, W);
    // ride on the crest, never sink into it; in the shallows the wheels stay on the bed
    let y = Math.max(f.y, (hf + hb) / 2, (hl + hr) / 2);
    if (f.depth > 0) y = Math.max(y, WATER_Y - 0.5);
    const pitch = Math.atan2(hf - hb, 2 * L);
    const roll = bike ? 0 : Math.atan2(hl - hr, 2 * W);
    if (!dt) {
      this.carY = y;
      this.tiltP = pitch;
      this.tiltR = roll;
    } else {
      this.carY = damp(this.carY, y, 20, dt);
      this.tiltP = damp(this.tiltP, pitch, 12, dt);
      this.tiltR = damp(this.tiltR, roll, 12, dt);
    }
    const v = this.prevV;
    const latAccel = v * this.yawRate;
    const rollTarget = bike ? Math.atan(latAccel / G) : THREE.MathUtils.clamp(-latAccel * 0.008, -0.06, 0.06);
    this.roll = dt ? damp(this.roll, rollTarget, 6, dt) : rollTarget;
    // off the tarmac the body jiggles over the rough ground
    const rough = f.road ? 0 : Math.min(1, v / 12) * 0.018;
    this.car.body.position.y = rough * (Math.sin(this.time * 31) * 0.6 + Math.sin(this.time * 17.3) * 0.4);
    this.carRoot.position.set(this.fx, this.carY, this.fz);
    this.carRoot.rotation.set(this.tiltR + (bike ? this.roll : 0), -this.yaw, this.tiltP, "YZX");
    this.car.body.rotation.set(bike ? 0 : this.roll, 0, this.pitch);
    for (const w of this.car.wheels) w.node.rotation.set(0, w.front ? -this.steerAng : 0, -this.distance / w.r, "YZX");
  }

  private placeCar(dt: number) {
    this.car.body.position.y = 0;
    const p = this.land.road.at(this.s, this.pt);
    const [rx, rz] = rightOf(p.heading);
    const v = this.prevV;
    const yawOff = Math.atan2(this.dVel, Math.max(v, 3));
    const latAccel = v * v * p.curvature;
    const bike = this.car.width < 1;
    // cars roll out of a bend on their springs; bikes lean into it
    const rollTarget = bike ? Math.atan(latAccel / G) : THREE.MathUtils.clamp(-latAccel * 0.008, -0.05, 0.05);
    this.roll = dt ? damp(this.roll, rollTarget, 6, dt) : rollTarget;
    this.carRoot.position.set(p.x + rx * this.d, surfaceY(p, this.d), p.z + rz * this.d);
    this.carRoot.rotation.set(Math.atan(bankOf(p.curvature)) + (bike ? this.roll : 0), -(p.heading + yawOff), Math.atan(p.grade), "YZX");
    this.car.body.rotation.set(bike ? 0 : this.roll, 0, this.pitch);
    // wheels: rolling with the distance, the front ones steering into the bend
    const steerAngle = THREE.MathUtils.clamp(Math.atan(p.curvature * 2.6) + yawOff * 1.5, -0.5, 0.5);
    for (const w of this.car.wheels) w.node.rotation.set(0, w.front ? -steerAngle : 0, -this.distance / w.r, "YZX");
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
    this.bloomOn = L.night > 0.15 || L.wet > 0;
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
      cam.fov = damp(cam.fov, 68 + v * 0.06, 3, dt || 1);
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

    const far = mode === "far";
    // a tall, narrow screen crops the sides: stand further back and higher so the car still fits
    const narrow = Math.pow(THREE.MathUtils.clamp(1.25 / cam.aspect, 1, 2.6), 0.85);
    const back = ((far ? 11.5 : 5.4) + Math.min(v, 70) * (far ? 0.025 : 0.015) + (this.car.length - 4.5) * 0.6) * narrow;
    const up = (far ? 3.9 : 1.75) * Math.pow(narrow, 1.15);
    const settle = this.time - this.orbit.at > 2.5;
    if (settle) {
      this.orbit.yaw = damp(this.orbit.yaw, 0, 2, dt || 1);
      this.orbit.pitch = damp(this.orbit.pitch, 0, 2, dt || 1);
    }
    const yaw = Math.atan2(fwd.z, fwd.x) + Math.PI + this.orbit.yaw;
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
      // follow tightly sideways, a touch looser along the road, so speed reads as a little lag
      // follow the car's motion exactly, then ease the rest: speed shows as a slight lag, not a drift
      const moved = carPos.clone().sub(this.lastCarPos);
      cam.position.add(moved.multiplyScalar(0.92));
      cam.position.x = damp(cam.position.x, want.x, 6, dt);
      cam.position.z = damp(cam.position.z, want.z, 6, dt);
      cam.position.y = damp(cam.position.y, want.y, 5, dt);
    }
    const look = carPos.clone().add(new THREE.Vector3(0, tall, 0)).addScaledVector(fwd, far ? 4 : 3);
    if (snap) this.camLook.copy(look);
    else this.camLook.lerp(look, 1 - Math.exp(-dt * 12));
    this.lastCarPos.copy(carPos);
    cam.lookAt(this.camLook);
    // the faster you go, the wider it opens up
    cam.fov = damp(cam.fov, (far ? 52 : 60) + Math.min(v, 80) * 0.16, 2, dt || 1);
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
    this.composer.dispose();
    this.renderer.dispose();
  }
}
