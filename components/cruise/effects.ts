import * as THREE from "three";

/**
 * Skid marks: dark rubber left on the road where a tyre slides or spins (or ruts torn in the
 * ground off it). Each tyre lays a ribbon of quads behind it while it's sliding; they're kept
 * in one ring of segments, so the oldest fade out of existence as new ones are laid.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private next = 0;
  /** Where each tyre's ribbon last reached, and how dark it was there (null: not laying one). */
  private readonly last = new Map<number, { l: THREE.Vector3; r: THREE.Vector3; a: number } | null>();

  constructor(segments = 3000) {
    this.max = segments;
    this.pos = new Float32Array(segments * 4 * 3);
    this.col = new Float32Array(segments * 4 * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(segments * 6);
    for (let i = 0; i < segments; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /**
   * A tyre at `at` (on the ground), heading along `fwd`, `width` wide, sliding this hard (0-1;
   * 0 lifts the ribbon). `ground` is the colour of what it marks.
   */
  lay(tyre: number, at: THREE.Vector3, fwd: THREE.Vector3, width: number, amount: number, ground: THREE.Color): void {
    const prev = this.last.get(tyre) ?? null;
    if (amount < 0.05) {
      this.last.set(tyre, null);
      return;
    }
    const side = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(width / 2);
    const l = at.clone().add(side);
    const r = at.clone().sub(side);
    l.y += 0.02;
    r.y += 0.02;
    const a = Math.min(0.75, amount * 0.85);
    if (!prev) {
      this.last.set(tyre, { l, r, a });
      return;
    }
    // a new segment every 25 cm or so
    if (prev.l.distanceToSquared(l) < 0.06) return;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const p = this.pos;
    const corners = [prev.l, prev.r, r, l];
    corners.forEach((v, k) => p.set([v.x, v.y, v.z], (i * 4 + k) * 3));
    const alphas = [prev.a, prev.a, a, a];
    alphas.forEach((al, k) => this.col.set([ground.r, ground.g, ground.b, al], (i * 4 + k) * 4));
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.last.set(tyre, { l, r, a });
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * Flames out of the exhaust: a backfire's bang, the crackle and pops on the overrun, the
 * limiter and a hard upshift. Each tip has a flame (a cone whose shader draws a hot blue root,
 * an orange body and a ragged, flickering tip) that bursts and dies in a tenth of a second or
 * so, and one light that flashes orange off the road and the car with it.
 */
export class ExhaustFlames {
  readonly group = new THREE.Group();
  readonly light = new THREE.PointLight(0xff7a2a, 0, 6, 2);
  private readonly flames: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>[] = [];
  private readonly material: THREE.ShaderMaterial;
  /** 0-1 how hard it's burning right now, and how fast that dies away. */
  private heat = 0;
  private decay = 10;
  private size = 1;

  constructor(tips: THREE.Vector3[]) {
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uHeat: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        varying float vAlong;
        varying float vFacing;
        void main() {
          vUv = uv;
          vAlong = uv.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // how squarely the surface faces the eye: the flame is thick in the middle, wispy at its edges
          vec3 n = normalize(normalMatrix * normal);
          vFacing = abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec2 vUv;
        varying float vAlong;
        varying float vFacing;
        uniform float uHeat;
        uniform float uTime;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          // along the flame: 1 at the pipe, 0 at the tip (the cone's uv runs base 0 to apex 1)
          float t = 1.0 - vAlong;
          float flick = 0.75 + 0.25 * hash(vec2(floor(uTime * 40.0), floor(vUv.x * 12.0)));
          float body = smoothstep(0.0, 0.55, t) * flick;
          vec3 blue = vec3(0.35, 0.55, 1.0);
          vec3 orange = vec3(1.0, 0.45, 0.08);
          vec3 yellow = vec3(1.0, 0.85, 0.4);
          vec3 c = mix(orange, yellow, smoothstep(0.35, 0.8, t));
          c = mix(c, blue, smoothstep(0.88, 1.0, t));
          float a = body * uHeat * pow(vFacing, 0.9);
          gl_FragColor = vec4(c * a * 2.6, a);
        }`,
    });
    for (const tip of tips) {
      // a cone pointing out of the back: apex at the end of the flame, base at the pipe
      const geo = new THREE.ConeGeometry(0.1, 0.75, 16, 1, true);
      geo.rotateZ(Math.PI / 2); // apex towards -x
      geo.translate(-0.375, 0, 0);
      const m = new THREE.Mesh(geo, this.material);
      m.position.copy(tip);
      m.visible = false;
      m.frustumCulled = false;
      this.flames.push(m);
      this.group.add(m);
    }
    const mid = tips.reduce((acc, t) => acc.add(t), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, tips.length));
    this.light.position.copy(mid).add(new THREE.Vector3(-0.5, 0.1, 0));
    this.group.add(this.light);
  }

  /** A burst: "bang" (a backfire), "pop" (overrun crackle, limiter), "crack" (a hard upshift). */
  burst(kind: "bang" | "pop" | "crack"): void {
    const [heat, decay, size] = kind === "bang" ? [1, 7, 1.5] : kind === "crack" ? [0.8, 12, 1.1] : [0.55, 16, 0.75];
    if (heat >= this.heat) {
      this.size = size * (0.85 + Math.random() * 0.3);
      this.decay = decay;
    }
    this.heat = Math.max(this.heat, heat);
  }

  update(dt: number, time: number): void {
    this.heat = Math.max(0, this.heat - this.heat * this.decay * dt - dt * 0.5);
    const on = this.heat > 0.02;
    this.material.uniforms.uHeat.value = this.heat;
    this.material.uniforms.uTime.value = time;
    for (const f of this.flames) {
      f.visible = on;
      // a long tongue as it bursts, shrinking back into the pipe as it dies
      const len = this.size * (0.35 + 0.65 * this.heat) * (0.85 + 0.3 * Math.random());
      f.scale.set(len, 0.7 + 0.5 * this.heat, 0.7 + 0.5 * this.heat);
    }
    this.light.intensity = on ? 6 * this.heat * (0.8 + 0.4 * Math.random()) : 0;
  }

  dispose(): void {
    for (const f of this.flames) f.geometry.dispose();
    this.material.dispose();
  }
}
