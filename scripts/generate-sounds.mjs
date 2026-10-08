#!/usr/bin/env node
/**
 * Generates original engine sounds for every sample-based vehicle and writes the
 * matching `audio` section into its config.json.
 *
 * The model is physical-ish rather than musical:
 *  - real firing orders and crank angles (cross-plane V8 burble, 45-degree V-twin,
 *    unequal-length boxer headers, rotary), per-bank exhaust pipes
 *  - each combustion is a pressure pulse whose length is set in crank degrees
 *  - each bank's pulses ring through a pipe (waveguide with a reflecting open end),
 *    then saturate and pass through a muffler (resonances + low-pass)
 *  - intake roar, valvetrain ticks, turbo whistle/hiss, overrun crackle
 *  - fixed per-cylinder imbalance, so there is energy at half-orders like a real engine
 *
 * Every loop holds a whole number of engine cycles and starts at the same crank angle,
 * and all timing is in crank degrees. The player starts every loop at the same instant
 * and sets playbackRate = rpm / sampleRpm on all of them, so loops stay phase-locked
 * and crossfades between them don't smear or flange.
 *
 * Original works, released CC0. Swap any file for a real recording with the same name.
 *
 *   node scripts/generate-sounds.mjs              # all vehicles
 *   node scripts/generate-sounds.mjs muscle_v8    # one vehicle
 *
 * Requires ffmpeg (libvorbis + libmp3lame).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SR = 44100;
const ROOT = path.resolve(import.meta.dirname, "..");
const SPEED_OF_SOUND = 343;

// ---------------------------------------------------------------- utilities

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** RBJ biquad; returns a per-sample processor. */
function biquad(type, freq, q = 0.707) {
  const w0 = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (type === "lp") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === "hp") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha]; // band-pass, 0 dB peak
  const a0 = 1 + alpha;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  b0 /= a0; b1 /= a0; b2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

/** Filters a copy of `buf`. With `loop`, primes the state with one pass so the end flows into the start. */
function filtered(buf, type, freq, q, loop) {
  const f = biquad(type, freq, q);
  const out = new Float32Array(buf.length);
  if (loop) for (let i = 0; i < buf.length; i++) f(buf[i]);
  for (let i = 0; i < buf.length; i++) out[i] = f(buf[i]);
  return out;
}

/** Exhaust pipe: comb with a lossy, phase-inverting reflection at the open end. Circular for loops. */
function pipe(buf, lengthM, reflect, damping, loop) {
  const n = buf.length;
  const d = Math.max(1, Math.round(((2 * lengthM) / SPEED_OF_SOUND) * SR));
  const out = new Float32Array(n);
  let lp = 0;
  const passes = loop ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      const j = i - d;
      const back = j >= 0 ? out[j] : loop ? out[j + n] : 0;
      lp += (back - lp) * damping;
      out[i] = buf[i] + reflect * lp;
    }
  }
  return out;
}

const rms = (b) => Math.sqrt(b.reduce((s, v) => s + v * v, 0) / b.length);

function softClip(buf, knee = 0.8) {
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const a = Math.abs(x);
    if (a > knee) buf[i] = Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
}

function fade(buf, inMs, outMs) {
  const ni = Math.round((inMs / 1000) * SR);
  const no = Math.round((outMs / 1000) * SR);
  for (let i = 0; i < ni && i < buf.length; i++) buf[i] *= i / ni;
  for (let i = 0; i < no && i < buf.length; i++) buf[buf.length - 1 - i] *= i / no;
}

function wav(samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + samples.length * 2, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return data;
}

// ------------------------------------------------------------ firing orders

/** Even firing; `bankOf(i)` picks the exhaust bank of the i-th firing in order. */
const evenFire = (cyl, bankOf = () => 0, delayDeg = () => 0) =>
  Array.from({ length: cyl }, (_, i) => ({ deg: (i * 720) / cyl, bank: bankOf(i), cyl: i, delayDeg: delayDeg(i) }));

/** Cross-plane V8, firing order 1-8-4-3-6-5-7-2; odd cylinders on the left bank. Each bank fires unevenly. */
const crossPlaneV8 = () =>
  [1, 8, 4, 3, 6, 5, 7, 2].map((c, i) => ({ deg: i * 90, bank: c % 2 ? 0 : 1, cyl: c - 1, delayDeg: 0 }));

/** 45-degree V-twin on a shared crankpin: fires at 0 and 405 degrees, then a long gap. */
const vTwin45 = () => [
  { deg: 0, bank: 0, cyl: 0, delayDeg: 0 },
  { deg: 405, bank: 0, cyl: 1, delayDeg: 0 },
];

// ---------------------------------------------------------------- voices
// pulse.openDeg: exhaust event length in crank degrees; noise: turbulence share.
// muffler.res: [Hz, Q, gain] resonances added to the dry signal; lp: final low-pass.

const VOICES = {
  muscle_v8: {
    firing: crossPlaneV8(),
    banks: [{ m: 2.3, r: -0.62 }, { m: 2.42, r: -0.62 }],
    pulse: { openDeg: 230, attackDeg: 6, noise: 0.28 },
    muffler: { lp: 2500, res: [[95, 1.5, 0.9], [310, 2, 0.35], [900, 3, 0.12]] },
    drive: 2.4, intake: 0.08, mech: 0.015, cylVar: 0.12, rough: 0.1, idleRough: 0.28, crackle: 0.15,
  },
  superbike_i4: {
    firing: evenFire(4),
    banks: [{ m: 0.95, r: -0.5 }],
    pulse: { openDeg: 200, attackDeg: 4, noise: 0.4 },
    muffler: { lp: 7500, res: [[620, 1.5, 0.5], [1800, 2, 0.35]] },
    drive: 1.9, intake: 0.32, mech: 0.05, cylVar: 0.04, rough: 0.05, idleRough: 0.18, crackle: 0.5,
  },
  jdm_i6_turbo: {
    firing: evenFire(6, (i) => i % 2),
    banks: [{ m: 2.6, r: -0.55 }, { m: 2.6, r: -0.55 }],
    pulse: { openDeg: 240, attackDeg: 8, noise: 0.22 },
    muffler: { lp: 3400, res: [[140, 1.4, 0.6], [520, 2, 0.45], [1500, 3, 0.2]] },
    drive: 1.8, intake: 0.12, mech: 0.03, cylVar: 0.04, rough: 0.05, idleRough: 0.12, crackle: 0.1,
    turbo: { whistle: 0.07, hiss: 0.06, hzPerRpm: 1.05 },
  },
  flat6_sports: {
    firing: evenFire(6, (i) => i % 2),
    banks: [{ m: 1.35, r: -0.55 }, { m: 1.42, r: -0.55 }],
    pulse: { openDeg: 210, attackDeg: 4, noise: 0.38 },
    muffler: { lp: 6800, res: [[260, 1.6, 0.5], [880, 2.5, 0.5], [2300, 3, 0.3]] },
    drive: 2.0, intake: 0.38, mech: 0.06, cylVar: 0.05, rough: 0.06, idleRough: 0.2, crackle: 0.25,
  },
  rotary_twin: {
    firing: evenFire(4),
    banks: [{ m: 1.8, r: -0.6 }],
    pulse: { openDeg: 300, attackDeg: 2, noise: 0.7 },
    muffler: { lp: 5200, res: [[180, 1.5, 0.5], [720, 2, 0.45]] },
    drive: 2.9, intake: 0.18, mech: 0.0, cylVar: 0.12, rough: 0.16, idleRough: 0.55, crackle: 0.4,
  },
  v10_supercar: {
    firing: evenFire(10, (i) => i % 2),
    banks: [{ m: 1.3, r: -0.52 }, { m: 1.3, r: -0.52 }],
    pulse: { openDeg: 200, attackDeg: 3, noise: 0.35 },
    muffler: { lp: 8000, res: [[420, 1.6, 0.45], [1300, 2.5, 0.45], [3200, 3, 0.2]] },
    drive: 2.1, intake: 0.3, mech: 0.05, cylVar: 0.05, rough: 0.05, idleRough: 0.16, crackle: 0.45,
  },
  v12_gt: {
    firing: evenFire(12, (i) => i % 2),
    banks: [{ m: 1.5, r: -0.5 }, { m: 1.55, r: -0.5 }],
    pulse: { openDeg: 190, attackDeg: 3, noise: 0.28 },
    muffler: { lp: 8500, res: [[350, 1.4, 0.4], [1100, 2.2, 0.4], [2700, 3, 0.25]] },
    drive: 1.7, intake: 0.32, mech: 0.05, cylVar: 0.03, rough: 0.04, idleRough: 0.1, crackle: 0.2,
  },
  boxer4_rally: {
    // unequal-length headers: two cylinders' pulses arrive late at the collector -> off-beat rumble
    firing: evenFire(4, () => 0, (i) => (i % 2 ? 32 : 0)),
    banks: [{ m: 2.4, r: -0.6 }],
    pulse: { openDeg: 230, attackDeg: 6, noise: 0.32 },
    muffler: { lp: 3100, res: [[110, 1.4, 0.75], [400, 2, 0.4]] },
    drive: 2.2, intake: 0.12, mech: 0.03, cylVar: 0.1, rough: 0.09, idleRough: 0.25, crackle: 0.25,
    turbo: { whistle: 0.06, hiss: 0.07, hzPerRpm: 0.95 },
  },
  hot_hatch: {
    firing: evenFire(4),
    banks: [{ m: 2.0, r: -0.58 }],
    pulse: { openDeg: 220, attackDeg: 5, noise: 0.33 },
    muffler: { lp: 4300, res: [[180, 1.4, 0.55], [650, 2, 0.45]] },
    drive: 2.0, intake: 0.15, mech: 0.04, cylVar: 0.05, rough: 0.06, idleRough: 0.15, crackle: 0.7,
    turbo: { whistle: 0.06, hiss: 0.06, hzPerRpm: 1.15 },
  },
  vtwin_cruiser: {
    firing: vTwin45(),
    banks: [{ m: 1.2, r: -0.6 }],
    pulse: { openDeg: 250, attackDeg: 5, noise: 0.35 },
    muffler: { lp: 2600, res: [[90, 1.3, 0.85], [300, 2, 0.4]] },
    drive: 2.6, intake: 0.1, mech: 0.08, cylVar: 0.15, rough: 0.16, idleRough: 0.38, crackle: 0.3,
  },
};

// -------------------------------------------------------------- engine model

/**
 * Renders the engine.
 *  rpmAt(t), loadAt(t), boostAt(t): engine state over time (t in seconds)
 *  fuel(t): 0..1 combustion strength (0 = motoring with no fuel, e.g. cranking/shutdown)
 *  loop: circular processing, so the result loops seamlessly
 */
function renderEngine(voice, cfg, { seconds, rpmAt, loadAt, boostAt = () => 0, fuel = () => 1, rough, loop, seed, crackle = 0 }) {
  const n = Math.round(seconds * SR);
  const rand = mulberry32(seed);
  const cylRand = mulberry32(hashSeed(cfg.id)); // same imbalance for every file of a vehicle
  const cylBias = Array.from({ length: 16 }, () => 1 + (cylRand() * 2 - 1) * voice.cylVar);
  const banks = voice.banks.map(() => new Float32Array(n));
  const intakeEnv = new Float32Array(n);
  const mechTicks = new Float32Array(n);

  const events = [...voice.firing]
    .map((f) => ({ ...f, phase: ((f.deg + f.delayDeg) / 720) % 1 }))
    .sort((a, b) => a.phase - b.phase);
  const intakeEvents = voice.firing.map((f) => ((f.deg + 360) / 720) % 1);

  const add = (target, idx, v) => {
    if (idx >= n) {
      if (!loop) return;
      idx %= n;
    } else if (idx < 0) {
      if (!loop) return;
      idx += n;
    }
    target[idx] += v;
  };

  // walk the crank and drop events where their phase is crossed
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const rpm = Math.max(1, rpmAt(t));
    const next = phase + rpm / 120 / SR;
    const cyc = Math.floor(phase);
    for (let c = cyc; c <= Math.floor(next); c++) {
      for (const e of events) {
        const at = c + e.phase;
        if (at < phase || at >= next) continue;
        const frac = (at - phase) / (next - phase);
        const pos = i + frac;
        const load = loadAt(t);
        const f = fuel(t);
        const degS = 60 / rpm / 360; // seconds per crank degree
        // combustion pulse (or just compression when there is no fuel)
        const amp = cylBias[e.cyl] * (1 + (rand() * 2 - 1) * rough) * (0.08 + f * (0.25 + 0.75 * load));
        const openS = voice.pulse.openDeg * degS;
        const attackS = voice.pulse.attackDeg * degS;
        const len = Math.min(Math.round(openS * 3 * SR), Math.round(0.15 * SR));
        const noiseAmt = voice.pulse.noise * (0.5 + 0.8 * load) * f;
        const b = banks[e.bank];
        for (let j = 0; j < len; j++) {
          const tt = (j - frac) / SR;
          if (tt < 0) continue;
          const env = (1 - Math.exp(-tt / attackS)) * Math.exp(-tt / (openS * 0.38));
          const noise = (rand() * 2 - 1) * Math.exp(-tt / (openS * 0.18));
          add(b, Math.floor(pos) + j, amp * (env + noise * noiseAmt));
        }
        // valvetrain: two small ticks per cylinder per cycle
        if (voice.mech > 0) {
          add(mechTicks, Math.floor(pos + 0.3 * openS * SR), voice.mech * (0.6 + 0.4 * rand()));
          add(mechTicks, Math.floor(pos + 2.2 * openS * SR), voice.mech * 0.7 * (0.6 + 0.4 * rand()));
        }
      }
      for (const ip of intakeEvents) {
        const at = c + ip;
        if (at < phase || at >= next) continue;
        const openS = 200 * (60 / rpm / 360);
        const len = Math.round(openS * SR);
        const a = voice.intake * (0.25 + loadAt(t)) * fuel(t);
        for (let j = 0; j < len; j++) add(intakeEnv, i + j, a * Math.sin((Math.PI * j) / len));
      }
    }
    phase = next;
  }

  // exhaust: each bank rings through its own pipe, then the banks merge
  const mix = new Float32Array(n);
  voice.banks.forEach((bank, k) => {
    // softened reflection: strong combs make timbre jump between neighbouring loops
    const p = pipe(banks[k], bank.m, bank.r * 0.65, 0.4, loop);
    for (let i = 0; i < n; i++) mix[i] += p[i] / voice.banks.length;
  });
  const dc = filtered(mix, "hp", 25, 0.7, loop);

  // combustion saturation, then the muffler
  const drive = voice.drive;
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) dc[i] = Math.tanh(dc[i] * drive * 2.2) / norm;
  const muffled = Float32Array.from(dc);
  for (const [hz, q, g] of voice.muffler.res) {
    const r = filtered(dc, "bp", hz, q, loop);
    for (let i = 0; i < n; i++) muffled[i] += r[i] * g;
  }
  const out = filtered(muffled, "lp", voice.muffler.lp, 0.6, loop);

  // intake roar: band-limited noise shaped by the intake strokes
  if (voice.intake > 0) {
    const noise = Float32Array.from({ length: n }, () => rand() * 2 - 1);
    const roar = filtered(filtered(noise, "bp", 700, 0.8, loop), "lp", 2500, 0.7, loop);
    for (let i = 0; i < n; i++) out[i] += roar[i] * intakeEnv[i] * 0.9;
  }
  // valvetrain clatter
  if (voice.mech > 0) {
    const ticks = filtered(mechTicks, "bp", 5200, 2.5, loop);
    for (let i = 0; i < n; i++) out[i] += ticks[i] * 2.5;
  }
  // turbo: whistle locked to a whole harmonic of the engine cycle (keeps loops periodic), plus hiss
  if (voice.turbo) {
    const noise = Float32Array.from({ length: n }, () => rand() * 2 - 1);
    const hiss = filtered(noise, "bp", 4200, 1.2, loop);
    let wPhase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const rpm = rpmAt(t);
      const boost = boostAt(t);
      const cycleHz = rpm / 120;
      const harmonic = Math.max(1, Math.round((voice.turbo.hzPerRpm * rpm) / cycleHz));
      wPhase += (2 * Math.PI * harmonic * cycleHz) / SR;
      const w = Math.sin(wPhase) + 0.3 * Math.sin(2 * wPhase);
      out[i] += boost * (voice.turbo.whistle * w + voice.turbo.hiss * hiss[i] * 3);
    }
  }
  // overrun crackle: unburnt fuel popping in the exhaust
  if (crackle > 0) {
    const pops = Math.round(crackle * seconds * 6);
    const burst = new Float32Array(n);
    for (let k = 0; k < pops; k++) {
      const at = Math.floor(rand() * n);
      const len = Math.round((0.004 + rand() * 0.012) * SR);
      const a = (0.25 + rand() * 0.6) * crackle;
      for (let j = 0; j < len; j++) add(burst, at + j, a * (rand() * 2 - 1) * Math.exp(-j / (len * 0.3)));
    }
    const shaped = filtered(burst, "bp", 1800, 0.9, loop);
    for (let i = 0; i < n; i++) out[i] += shaped[i] * 1.5;
  }
  return out;
}

// --------------------------------------------------------------- loop plans

/** Geometric RPM points from lo to hi, neighbours at most `ratio` apart. */
function rpmPoints(lo, hi, ratio) {
  const count = Math.max(2, Math.ceil(Math.log(hi / lo) / Math.log(ratio)) + 1);
  return Array.from({ length: count }, (_, i) => lo * Math.pow(hi / lo, i / (count - 1)));
}

/** Loop of exactly N engine cycles. Returns the samples and the exact RPM they represent. */
function loopAt(voice, cfg, { rpm, load, boost, rough, crackle, seconds, seed }) {
  const cycle = 120 / rpm;
  const cycles = Math.max(4, Math.round(seconds / cycle));
  const len = Math.round(cycles * cycle * SR);
  const exactRpm = (120 * cycles * SR) / len;
  const samples = renderEngine(voice, cfg, {
    seconds: len / SR,
    rpmAt: () => exactRpm,
    loadAt: () => load,
    boostAt: () => boost,
    rough,
    crackle,
    loop: true,
    seed,
  });
  return { samples, rpm: exactRpm };
}

// ----------------------------------------------------------------- one-shots

function starter(voice, cfg) {
  const crankS = 0.8; // matches the simulation's cranking time
  const total = 1.35;
  const idle = cfg.engine.idleRpm;
  const rpmAt = (t) => (t < crankS ? 200 + 30 * Math.sin(t * 40) : Math.min(idle * 1.5, 200 + (idle * 1.5 - 200) * ((t - crankS) / 0.12)));
  const s = renderEngine(voice, cfg, {
    seconds: total,
    rpmAt,
    loadAt: (t) => (t < crankS ? 0 : 0.8),
    fuel: (t) => (t < crankS ? 0.05 : 1),
    rough: 0.3,
    loop: false,
    seed: 11,
  });
  // starter motor whine and gear rattle
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    if (t > crankS + 0.02) break;
    const spin = 140 + 50 * Math.min(1, t * 5) + 10 * Math.sin(t * 40);
    const gate = Math.min(1, t * 30) * Math.min(1, (crankS + 0.02 - t) * 60);
    s[i] += (Math.sin(2 * Math.PI * spin * t) * 0.5 + Math.sin(2 * Math.PI * spin * 3.02 * t) * 0.2) * gate * 0.12;
  }
  // the first catch flares, then fades into the running loops
  for (let i = Math.round((crankS + 0.12) * SR); i < s.length; i++) s[i] *= Math.max(0, 1 - (i / SR - crankS - 0.12) / (total - crankS - 0.12));
  fade(s, 3, 40);
  return s;
}

function shutdown(voice, cfg) {
  const total = 1.0;
  const idle = cfg.engine.idleRpm;
  const s = renderEngine(voice, cfg, {
    seconds: total,
    rpmAt: (t) => Math.max(30, idle * Math.pow(Math.max(0, 1 - t / 0.75), 1.6)),
    loadAt: () => 0.1,
    fuel: (t) => Math.max(0, 1 - t / 0.08) * 0.6,
    rough: 0.35,
    loop: false,
    seed: 23,
  });
  // engine rocking back on its mounts
  for (let i = Math.round(0.72 * SR); i < Math.round(0.95 * SR); i++) {
    const t = i / SR - 0.72;
    s[i] += Math.sin(2 * Math.PI * 38 * t) * Math.exp(-t * 18) * 0.25;
  }
  fade(s, 2, 60);
  return s;
}

function shiftClunk(variant, bike) {
  const n = Math.round(0.18 * SR);
  const rand = mulberry32(100 + variant);
  const s = new Float32Array(n);
  const f = (bike ? 160 : 80) + variant * 14;
  const noise = Float32Array.from({ length: n }, () => rand() * 2 - 1);
  const click = filtered(noise, "bp", bike ? 2600 + variant * 400 : 1200 + variant * 300, 1.4, false);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    s[i] = click[i] * Math.exp(-t / 0.01) * 2.2 + Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.03) * 0.5;
  }
  fade(s, 0.5, 20);
  return s;
}

/** Backfire: a sharp crack plus a thump, rung through the vehicle's own exhaust pipe. */
function backfire(voice, variant) {
  const seconds = [0.22, 0.3, 0.25][variant];
  const n = Math.round(seconds * SR);
  const rand = mulberry32(300 + variant);
  const x = new Float32Array(n);
  const decay = [0.012, 0.02, 0.015][variant];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = (rand() * 2 - 1) * Math.exp(-t / decay) * Math.min(1, t * 2000) + Math.sin(2 * Math.PI * (70 + variant * 20) * t) * Math.exp(-t / 0.04) * 0.8;
  }
  const bank = voice.banks[0];
  const p = pipe(x, bank.m, bank.r, 0.35, false);
  const out = filtered(p, "lp", Math.min(9000, voice.muffler.lp * 1.8), 0.7, false);
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 2.5);
  fade(out, 0.3, 30);
  return out;
}

/** Turbo blow-off valve: a burst of air; variant 1 flutters (compressor surge). */
function blowoff(variant) {
  const seconds = variant ? 0.7 : 0.5;
  const n = Math.round(seconds * SR);
  const rand = mulberry32(500 + variant);
  const noise = Float32Array.from({ length: n }, () => rand() * 2 - 1);
  const air = filtered(filtered(noise, "bp", variant ? 2200 : 3200, 0.9, false), "hp", 800, 0.7, false);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let env = Math.min(1, t / 0.008) * Math.exp(-t / (variant ? 0.22 : 0.14));
    if (variant) env *= 0.55 + 0.45 * Math.sin(2 * Math.PI * (28 - t * 20) * t) ** 2;
    out[i] = air[i] * env * 2.2;
  }
  fade(out, 0.5, 40);
  return out;
}

// ---------------------------------------------------------------- per vehicle

function buildVehicle(cfg) {
  const voice = VOICES[cfg.id];
  const e = cfg.engine;
  const bike = cfg.type === "bike";
  const turbo = Boolean(voice.turbo && cfg.turbo);
  const boostFor = (rpm) => (turbo ? Math.min(1, Math.max(0, (rpm - cfg.turbo.spoolRpm) / (e.redlineRpm * 0.45))) : 0);
  const loops = [];
  let seed = hashSeed(cfg.id);

  const idle = loopAt(voice, cfg, { rpm: e.idleRpm, load: 0.22, boost: 0, rough: voice.idleRough, crackle: 0, seconds: 3, seed: seed++ });
  loops.push({ name: `idle_${Math.round(e.idleRpm)}`, ...idle, kind: "idle" });

  for (const rpm of rpmPoints(e.idleRpm * 1.2, e.limiterRpm * 0.99, 1.28)) {
    const l = loopAt(voice, cfg, { rpm, load: 1, boost: boostFor(rpm), rough: voice.rough, crackle: 0, seconds: 2.4, seed: seed++ });
    loops.push({ name: `on_${Math.round(l.rpm)}`, ...l, kind: "on" });
  }
  for (const rpm of rpmPoints(e.idleRpm * 1.35, e.limiterRpm * 0.97, 1.32)) {
    const l = loopAt(voice, cfg, {
      rpm, load: 0, boost: 0, rough: voice.rough * 1.5,
      crackle: voice.crackle * Math.min(1, Math.max(0, (rpm / e.redlineRpm - 0.25) * 2)),
      seconds: 2.4, seed: seed++,
    });
    loops.push({ name: `off_${Math.round(l.rpm)}`, ...l, kind: "off" });
  }

  // Loudness follows a smooth curve over rpm and load (natural levels jump around where
  // harmonics hit pipe resonances, which would make sweeps wobble).
  const span = e.limiterRpm - e.idleRpm;
  const targetRms = (l) => {
    const x = Math.min(1, Math.max(0, (l.rpm - e.idleRpm) / span));
    if (l.kind === "idle") return 0.11;
    return l.kind === "on" ? 0.13 + 0.09 * Math.sqrt(x) : 0.075 + 0.04 * x;
  };
  for (const l of loops) {
    const g = targetRms(l) / (rms(l.samples) || 1);
    for (let j = 0; j < l.samples.length; j++) l.samples[j] *= g;
    softClip(l.samples, 0.85);
  }

  const oneShots = {
    start: starter(voice, cfg),
    stop: shutdown(voice, cfg),
    shift_1: shiftClunk(0, bike),
    shift_2: shiftClunk(1, bike),
    pop_1: backfire(voice, 0),
    pop_2: backfire(voice, 1),
    pop_3: backfire(voice, 2),
  };
  if (turbo) {
    oneShots.bov_1 = blowoff(0);
    oneShots.bov_2 = blowoff(1);
  }
  for (const [name, s] of Object.entries(oneShots)) {
    const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
    const target = name.startsWith("shift") ? 0.45 : name.startsWith("bov") ? 0.5 : 0.85;
    for (let i = 0; i < s.length; i++) s[i] *= target / peak;
  }
  return { loops, oneShots, turbo };
}

// ---------------------------------------------------------------------- main

function encode(wavPath, base) {
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, "-ac", "1", "-ar", String(SR)];
  execFileSync("ffmpeg", [...common, "-c:a", "libvorbis", "-q:a", "4", `${base}.ogg`]);
  execFileSync("ffmpeg", [...common, "-c:a", "libmp3lame", "-q:a", "5", `${base}.mp3`]);
}

const only = process.argv[2];
const ids = Object.keys(VOICES).filter((id) => !only || id === only);
if (!ids.length) throw new Error(`Unknown vehicle "${only}". Known: ${Object.keys(VOICES).join(", ")}`);
const tmp = mkdtempSync(path.join(tmpdir(), "revheadz-sounds-"));
try {
  for (const id of ids) {
    const cfgPath = path.join(ROOT, "public", "vehicles", id, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const { loops, oneShots, turbo } = buildVehicle(cfg);
    const dir = path.join(ROOT, "public", "vehicles", id, "sounds");
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) unlinkSync(path.join(dir, f)); // drop stale files

    const files = [...loops.map((l) => [l.name, l.samples]), ...Object.entries(oneShots)];
    for (const [name, samples] of files) {
      const w = path.join(tmp, `${id}_${name}.wav`);
      writeFileSync(w, wav(samples));
      encode(w, path.join(dir, name));
    }

    const ref = (l) => ({ file: `${l.name}.ogg`, rpm: Math.round(l.rpm * 1000) / 1000 });
    cfg.audio = {
      mode: "samples",
      onLoad: loops.filter((l) => l.kind === "on").map(ref),
      offLoad: loops.filter((l) => l.kind === "off").map(ref),
      idle: ref(loops.find((l) => l.kind === "idle")),
      oneShots: {
        start: "start.ogg",
        stop: "stop.ogg",
        shift: ["shift_1.ogg", "shift_2.ogg"],
        backfire: ["pop_1.ogg", "pop_2.ogg", "pop_3.ogg"],
        ...(turbo ? { blowoff: ["bov_1.ogg", "bov_2.ogg"] } : {}),
      },
      masterGainDb: cfg.audio?.masterGainDb ?? 0,
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    const total = readdirSync(dir).filter((f) => f.endsWith(".ogg")).reduce((s, f) => s + statSync(path.join(dir, f)).size, 0);
    console.log(`${id.padEnd(14)} ${files.length} sounds, ${(total / 1024).toFixed(0)} KB ogg`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
