import * as THREE from "three";

/**
 * Soft puffs thrown up by the wheels: dust off the road, spray from water and wet tarmac.
 * One pool of points, drawn as round, soft-edged sprites that grow and fade as they drift.
 */
export class Puffs {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly n: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly start: Float32Array;
  private next = 0;

  constructor(count = 600) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.age = new Float32Array(count).fill(1);
    this.life = new Float32Array(count).fill(1);
    this.start = new Float32Array(count);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        fog: true,
        uniforms: { ...THREE.UniformsLib.fog, uScale: { value: 400 }, uLight: { value: 1 } },
        vertexShader: `
          attribute vec3 aColor;
          attribute float aSize;
          attribute float aAlpha;
          varying vec3 vColor;
          varying float vAlpha;
          uniform float uScale;
          #include <fog_pars_vertex>
          void main() {
            vColor = aColor;
            vAlpha = aAlpha;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * uScale / max(0.5, -mvPosition.z);
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: `
          varying vec3 vColor;
          varying float vAlpha;
          uniform float uLight;
          #include <fog_pars_fragment>
          void main() {
            float r = length(gl_PointCoord - 0.5) * 2.0;
            float a = vAlpha * smoothstep(1.0, 0.2, r);
            if (a < 0.01) discard;
            gl_FragColor = vec4(vColor * uLight, a);
            #include <fog_fragment>
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.points.frustumCulled = false;
  }

  /** Throws one puff from a point with a velocity (m/s), lasting `life` s, growing from `size` m. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: THREE.Color, opacity: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.start[i] = opacity;
    this.age[i] = 0;
    this.life[i] = life;
  }

  /** Moves every puff on (slowing in the air), grows it and fades it out. */
  update(dt: number, light: number, viewportHeight: number, fovDeg: number): void {
    const drag = Math.exp(-2.2 * dt);
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) {
        this.alpha[i] = 0;
        continue;
      }
      this.age[i] += dt;
      const t = Math.min(1, this.age[i] / this.life[i]);
      for (let k = 0; k < 3; k++) {
        this.vel[i * 3 + k] *= drag;
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      }
      this.vel[i * 3 + 1] -= 0.4 * dt; // dust settles slowly
      this.size[i] *= 1 + 0.9 * dt;
      this.alpha[i] = this.start[i] * (1 - t) * Math.min(1, t * 8);
    }
    const g = this.points.geometry;
    for (const name of ["position", "aSize", "aAlpha"]) g.getAttribute(name).needsUpdate = true;
    g.getAttribute("aColor").needsUpdate = true;
    const m = this.points.material;
    m.uniforms.uLight.value = light;
    // a point of `size` m at 1 m away covers this many pixels
    m.uniforms.uScale.value = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
