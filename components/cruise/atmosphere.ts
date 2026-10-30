import * as THREE from "three";
import { Lensflare, LensflareElement } from "three/examples/jsm/objects/Lensflare.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { mulberry32, smoothstep } from "../../lib/cruise/noise";

export type Weather = "clear" | "haze" | "fog" | "rain";

const lerpC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));
/** A colour picked as sRGB (three.js works in linear light). */
const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

const NIGHT_FOG = srgb(0.018, 0.028, 0.06);
const DUSK_FOG = srgb(0.78, 0.5, 0.38);
const DAY_FOG = srgb(0.66, 0.76, 0.88);
const GREY = srgb(0.52, 0.55, 0.6);

/** What the time of day and weather do to the light, worked out once per change. */
export interface Light {
  /** Sun height above the horizon, degrees. */
  elevation: number;
  /** 0 by day, 1 in full night. */
  night: number;
  fog: THREE.Color;
  /** How wet the road is, 0-1. */
  wet: number;
}

/**
 * Sky, sun, moon, stars, fog and the ambient light, all driven by the hour (0-24) and the
 * weather. The sky is the physical (Preetham) model, so sunrise and sunset colour
 * themselves; a starry dome fades in over it after dark. The car's paint reflects a
 * pre-filtered copy of the sky, refreshed whenever the light has changed enough to see.
 */
export class Atmosphere {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly moon = new THREE.DirectionalLight(0x9fb4ff, 0.2);
  readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x3a3020, 1);
  private readonly sky = new Sky();
  private readonly night: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly moonDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly clouds: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envKey = "";
  /** The sun's shadows: none, ordinary, or a finer map. */
  shadows: "off" | "on" | "high" = "on";
  readonly light: Light = { elevation: 30, night: 0, fog: DAY_FOG.clone(), wet: 0 };
  private readonly sunDir = new THREE.Vector3();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.sky.scale.setScalar(4500);
    const u = this.sky.material.uniforms;
    u.mieDirectionalG.value = 0.8;
    this.group.add(this.sky);

    // the night: a deep blue dome with a glow along the horizon, fading in over the sky
    this.night = new THREE.Mesh(
      new THREE.SphereGeometry(4300, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        fog: false,
        uniforms: { opacity: { value: 0 }, horizon: { value: new THREE.Color(0.05, 0.07, 0.14) } },
        vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader:
          "uniform float opacity; uniform vec3 horizon; varying vec3 vDir; void main(){ float h = max(vDir.y, 0.0); vec3 top = vec3(0.004,0.008,0.024); vec3 c = mix(horizon, top, pow(h, 0.45)); gl_FragColor = vec4(c, opacity); \n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
      }),
    );
    this.night.renderOrder = -1;
    this.group.add(this.night);

    const rand = mulberry32(42);
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // uniform over the upper sky, a few dipping to the horizon
      const y = Math.pow(rand(), 0.8) * 0.98 + 0.02;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(a) * r * 4000, y * 4000, Math.sin(a) * r * 4000], i * 3);
      const b = 0.35 + Math.pow(rand(), 3) * 0.9;
      const warm = rand();
      col.set([b * (0.85 + warm * 0.15), b * 0.9, b * (1 - warm * 0.15)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    sg.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.group.add(this.stars);

    this.moonDisc = new THREE.Mesh(new THREE.CircleGeometry(60, 32), new THREE.MeshBasicMaterial({ color: 0xe8ecff, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.group.add(this.moonDisc);

    // clouds: one wide layer high overhead, its shapes drawn per pixel from noise in world space
    // (so they stay put as you drive under them, drifting on the wind), lit by the sun
    this.clouds = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 16000).rotateX(Math.PI / 2),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        uniforms: {
          uTime: { value: 0 },
          uCoverage: { value: 0.4 },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color(1, 1, 1) },
          uSky: { value: new THREE.Color(0.5, 0.6, 0.8) },
          uDark: { value: 0 },
        },
        vertexShader: `
          varying vec3 vWorld;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: `
          uniform float uTime, uCoverage, uDark;
          uniform vec3 uSunDir, uSunColor, uSky;
          varying vec3 vWorld;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
          }
          float fbm(vec2 p, int octaves) {
            float s = 0.0, a = 0.5;
            for (int i = 0; i < 4; i++) {
              if (i >= octaves) break;
              s += a * noise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5;
            }
            return s;
          }
          void main() {
            vec2 p = vWorld.xz / 1500.0 + vec2(uTime * 0.0045, uTime * 0.0018);
            float n = fbm(p, 4);
            float density = smoothstep(1.0 - uCoverage, 1.0 - uCoverage + 0.16, n);
            // thicker cloud just towards the sun shades this bit: a cheap self-shadow
            float toward = fbm(p + normalize(uSunDir.xz + 1e-4) * 0.05, 2); // its broad shape is enough for shading
            toward += (n - fbm(p, 2)); // put the fine detail back, so only the broad shape differs
            float shade = clamp(1.0 - (toward - n) * 5.0, 0.3, 1.15);
            // thick middles are darker underneath; thin edges glow with the light through them
            float core = smoothstep(0.0, 0.25, n - (1.0 - uCoverage));
            vec3 col = (uSunColor * shade * (1.0 - core * 0.35) + uSky * 0.45) * (1.0 - uDark * 0.55);
            // per pixel: the layer is two huge triangles, so a distance worked out at its corners is useless
            float fade = 1.0 - smoothstep(4500.0, 8200.0, length(vWorld.xz - cameraPosition.xz));
            gl_FragColor = vec4(col, density * fade * 0.94);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.clouds.position.y = 650;
    this.clouds.renderOrder = 1;
    this.group.add(this.clouds);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const cam = this.sun.shadow.camera;
    // only the car casts, and only onto the road around it
    cam.left = -9;
    cam.right = 9;
    cam.top = 9;
    cam.bottom = -9;
    cam.near = 1;
    cam.far = 120;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene.add(new Sky());
  }

  /** Sets the hour and weather; returns true when the scene's reflections were refreshed. */
  set(hour: number, weather: Weather, scene: THREE.Scene): void {
    // the sun: up at 6:00, highest at 12:45, down at 19:30; under the horizon all night
    const dayFrac = (hour - 6) / 13.5;
    const nightFrac = (((hour - 19.5) % 24) + 24) % 24 / 10.5;
    const elevation = dayFrac >= 0 && dayFrac <= 1 ? 55 * Math.sin(dayFrac * Math.PI) : -20 * Math.sin(nightFrac * Math.PI);
    const azimuth = 100 + ((hour - 6) / 13.5) * 160;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    const cloudy = weather === "rain" ? 1 : weather === "fog" ? 0.7 : weather === "haze" ? 0.35 : 0;
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.turbidity.value = 2.5 + cloudy * 12;
    u.rayleigh.value = 1.2 + cloudy * 1.5 + (1 - smoothstep(0, 18, elevation)) * 1.2;
    u.mieCoefficient.value = 0.004 + cloudy * 0.02;

    const day = smoothstep(-4, 8, elevation);
    const night = 1 - smoothstep(-9, -1, elevation);
    const golden = smoothstep(-3, 2, elevation) * (1 - smoothstep(6, 20, elevation));

    // sunlight: warm and low at the ends of the day, white and strong at noon, dimmed by cloud
    this.sun.position.copy(this.sunDir).multiplyScalar(60);
    this.sun.color.setRGB(1, 0.6 + 0.38 * smoothstep(2, 25, elevation), 0.38 + 0.56 * smoothstep(2, 30, elevation), THREE.SRGBColorSpace);
    this.sun.intensity = 2.9 * day * (1 - cloudy * 0.7);
    this.sun.castShadow = this.shadows !== "off" && day > 0.05 && cloudy < 0.9;
    // the sun's flare, when it's up and the sky's clear enough to see it
    this.flare ??= this.makeFlare();
    if (!this.flare.parent) this.group.add(this.flare);
    this.flare.position.copy(this.sunDir).multiplyScalar(4000);
    this.flare.visible = elevation > 1 && cloudy < 0.5;
    this.moon.position.copy(this.sunDir).multiplyScalar(-60).setY(Math.abs(this.sunDir.y) * 60 + 20);
    this.moon.intensity = 0.32 * night;

    const skyDay = srgb(0.62, 0.76, 1);
    const skyNight = srgb(0.1, 0.14, 0.3);
    this.hemi.color.copy(lerpC(skyNight, skyDay, day)).lerp(srgb(1, 0.7, 0.5), golden * 0.4);
    this.hemi.groundColor.setRGB(0.22 * day + 0.03, 0.18 * day + 0.03, 0.12 * day + 0.04, THREE.SRGBColorSpace);
    this.hemi.intensity = (0.22 + 0.75 * day) * (1 + cloudy * 0.3);

    // fog follows the horizon: blue by day, amber at sunset, near black at night, grey in bad weather
    let fog = lerpC(DUSK_FOG, DAY_FOG, smoothstep(2, 22, elevation));
    fog = lerpC(fog, NIGHT_FOG, night);
    fog = lerpC(fog, GREY.clone().multiplyScalar(0.12 + 0.88 * day), cloudy * 0.85);
    const density = { clear: 0.00028, haze: 0.0007, fog: 0.0045, rain: 0.0022 }[weather];
    // the same fog object, changed in place (a new one would make every material re-check its shader)
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.color.copy(fog);
      scene.fog.density = density;
    } else scene.fog = new THREE.FogExp2(fog, density);

    const cu = this.clouds.material.uniforms;
    cu.uCoverage.value = { clear: 0.44, haze: 0.55, fog: 0.72, rain: 0.97 }[weather];
    cu.uSunDir.value.copy(this.sunDir);
    // lit gold and pink from underneath at the ends of the day, grey-white at noon, a dim blue at night
    (cu.uSunColor.value as THREE.Color).copy(this.sun.color).multiplyScalar(0.25 + 0.9 * day).lerp(srgb(0.05, 0.06, 0.1), night);
    (cu.uSky.value as THREE.Color).copy(this.hemi.color).multiplyScalar(0.25 + 0.5 * day);
    cu.uDark.value = weather === "rain" ? 1 : weather === "fog" ? 0.4 : 0;

    this.night.material.uniforms.opacity.value = night * 0.97;
    (this.night.material.uniforms.horizon.value as THREE.Color).copy(fog).lerp(new THREE.Color(0.05, 0.07, 0.14), 0.5);
    this.stars.material.opacity = night * (1 - cloudy);
    this.moonDisc.material.opacity = night * (1 - cloudy * 0.8);
    this.moonDisc.position.copy(this.moon.position).normalize().multiplyScalar(3900);
    this.moonDisc.lookAt(0, 0, 0);

    this.renderer.toneMappingExposure = 0.55 + night * 0.35 + cloudy * 0.15;
    Object.assign(this.light, { elevation, night, fog, wet: weather === "rain" ? 1 : 0 });

    // reflections: re-filter the sky when the light has moved on enough to notice
    const key = `${Math.round(elevation * 0.5)}|${weather}`;
    if (key !== this.envKey) {
      this.envKey = key;
      const envSky = this.envScene.children[0] as Sky;
      envSky.scale.setScalar(1000);
      const eu = envSky.material.uniforms;
      for (const k of ["sunPosition", "turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG"]) {
        const v = u[k].value;
        if (v instanceof THREE.Vector3) eu[k].value.copy(v);
        else eu[k].value = v;
      }
      this.envScene.background = night > 0.5 ? new THREE.Color(0.01, 0.015, 0.035) : null;
      const next = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
      this.envTarget?.dispose();
      this.envTarget = next;
      scene.environment = next.texture;
      scene.environmentIntensity = 0.2 + 0.45 * day;
    }
  }

  /** The sun seen through a lens: a soft glow round it and faint ghosts across the picture. */
  private flare: Lensflare | null = null;
  private flareTextures: THREE.Texture[] = [];

  private makeFlare(): Lensflare {
    const tex = (inner: string, outer: string, ring = false) => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const g = c.getContext("2d")!;
      const grad = g.createRadialGradient(64, 64, ring ? 40 : 0, 64, 64, 64);
      if (ring) {
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(0.5, inner);
        grad.addColorStop(1, "rgba(0,0,0,0)");
      } else {
        grad.addColorStop(0, inner);
        grad.addColorStop(0.25, outer);
        grad.addColorStop(1, "rgba(0,0,0,0)");
      }
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c);
      this.flareTextures.push(t);
      return t;
    };
    const glow = tex("rgba(255,250,235,1)", "rgba(255,220,160,0.35)");
    const ghost = tex("rgba(255,255,255,0.5)", "rgba(255,255,255,0.12)");
    const halo = tex("rgba(255,240,210,0.18)", "", true);
    const f = new Lensflare();
    f.addElement(new LensflareElement(glow, 420, 0, new THREE.Color(1, 0.95, 0.85)));
    f.addElement(new LensflareElement(halo, 700, 0, new THREE.Color(1, 0.9, 0.75)));
    f.addElement(new LensflareElement(ghost, 50, 0.45, new THREE.Color(0.6, 0.8, 1)));
    f.addElement(new LensflareElement(ghost, 90, 0.62, new THREE.Color(1, 0.75, 0.5)));
    f.addElement(new LensflareElement(ghost, 36, 0.8, new THREE.Color(0.7, 1, 0.8)));
    f.addElement(new LensflareElement(ghost, 140, 1.0, new THREE.Color(0.55, 0.6, 1)));
    return f;
  }

  /** Shadow quality and whether the cloud layer is drawn (the graphics settings). */
  setQuality(shadows: "off" | "on" | "high", clouds: boolean): void {
    if (shadows !== this.shadows) {
      const size = shadows === "high" ? 2048 : 1024;
      if (this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        // a new map at the new size next frame
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
      this.shadows = shadows;
    }
    this.clouds.visible = clouds;
  }

  /** Keeps the sky and its lights centred on the camera (and the sun's shadow on the car). */
  follow(camera: THREE.Vector3, focus: THREE.Vector3, time = 0): void {
    this.clouds.material.uniforms.uTime.value = time;
    this.group.position.copy(camera);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(this.sunDir).multiplyScalar(60).add(focus);
    this.sun.target.updateMatrixWorld();
    this.moon.target.position.copy(focus);
    this.moon.target.updateMatrixWorld();
  }

  dispose(): void {
    this.flare?.dispose();
    this.flareTextures.forEach((t) => t.dispose());
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.night.geometry.dispose();
    this.night.material.dispose();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    this.moonDisc.geometry.dispose();
    this.clouds.geometry.dispose();
    this.clouds.material.dispose();
    this.moonDisc.material.dispose();
  }
}
