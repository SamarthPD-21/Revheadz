#!/usr/bin/env node
/**
 * Builds vehicle sound sets from real recordings listed in scripts/real-sounds.json.
 *
 * For each vehicle:
 *  - downloads its source recordings (cached in .sound-cache/, not committed)
 *  - tracks the engine's pitch and calibrates Hz -> RPM from the idle section
 *  - cuts each listed steady section, flattens its pitch to one exact RPM, and makes a
 *    seamless loop; ready-made RPM loops ("designed") are used as they are
 *  - makes off-load (overrun) variants: same loop, darker and softer
 *  - cuts start / stop one-shots; keeps generated shift, pop and blow-off one-shots
 *    where the manifest doesn't provide real ones
 *  - normalises loudness along a smooth rpm curve, encodes .ogg + .mp3, and writes the
 *    vehicle's audio config and credits.json entries
 *
 *   node scripts/build-real-sounds.mjs             # all vehicles in the manifest
 *   node scripts/build-real-sounds.mjs muscle_v8   # one vehicle
 *
 * Requires ffmpeg. Run scripts/generate-sounds.mjs first if you want generated fallbacks
 * for one-shots (they are kept unless the manifest replaces them).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SR, decode, filterLoop, filterOnce, flatten, makeLoop, rms, trackPitch, wav } from "./audio-analysis.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, ".sound-cache");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "scripts", "real-sounds.json"), "utf8"));

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function fetchSource(src) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, src.cacheName);
  if (!existsSync(file) || statSync(file).size === 0) {
    console.log(`  downloading ${src.title}`);
    execFileSync("curl", ["-sSL", "--retry", "5", "--retry-delay", "3", "-o", file, src.url], { stdio: "inherit" });
  }
  return file;
}

/**
 * Tracks the engine *cycle* frequency (rpm / 120): the spacing of the harmonic comb every
 * real engine shows. Using ~40 harmonics makes it far more robust than chasing the
 * firing frequency, which flips between harmonics on real recordings.
 */
const CYCLE_TRACKER = { harmonics: 40, nFft: 32768, hop: 2048, maxHz: 3000 };

const decoded = new Map();
function load(src, range) {
  const key = `${src.cacheName}:${range.join("-")}`;
  if (!decoded.has(key)) {
    const x = decode(fetchSource(src));
    const trackFile = path.join(CACHE, `${src.cacheName}.cycle.${range[0]}-${range[1]}.json`);
    let track;
    if (existsSync(trackFile)) track = JSON.parse(readFileSync(trackFile, "utf8"));
    else {
      track = trackPitch(x, { fMin: range[0], fMax: range[1], ...CYCLE_TRACKER });
      writeFileSync(trackFile, JSON.stringify(track));
    }
    if (src.anchors?.length) track = applyAnchors(track, src.anchors);
    decoded.set(key, { x, track });
  }
  return decoded.get(key);
}

/**
 * Replaces the tracked pitch between the first and last anchor with a piecewise-linear
 * line through hand-verified [time, rpm] points (read off a spectrogram), for sweeps the
 * tracker can't follow through noise.
 */
function applyAnchors(track, anchors) {
  const a = [...anchors].sort((p, q) => p[0] - q[0]);
  const at = (t) => {
    for (let i = 1; i < a.length; i++) {
      if (t <= a[i][0]) return a[i - 1][1] + ((a[i][1] - a[i - 1][1]) * (t - a[i - 1][0])) / (a[i][0] - a[i - 1][0]);
    }
    return a[a.length - 1][1];
  };
  return track.map((f) => (f.t >= a[0][0] && f.t <= a[a.length - 1][0] ? { ...f, f0: at(f.t) / 120 } : f));
}

const slice = (x, [a, b]) => x.slice(Math.round(a * SR), Math.round(b * SR));

function fade(buf, inS, outS) {
  const ni = Math.round(inS * SR);
  const no = Math.round(outS * SR);
  for (let i = 0; i < ni && i < buf.length; i++) buf[i] *= i / ni;
  for (let i = 0; i < no && i < buf.length; i++) buf[buf.length - 1 - i] *= i / no;
  return buf;
}

function softClip(buf, knee = 0.85) {
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const a = Math.abs(x);
    if (a > knee) buf[i] = Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
}

function encode(samples, base, tmp) {
  const w = path.join(tmp, `${path.basename(base)}.wav`);
  writeFileSync(w, wav(samples));
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-i", w, "-ac", "1", "-ar", String(SR)];
  execFileSync("ffmpeg", [...common, "-c:a", "libvorbis", "-q:a", "5", `${base}.ogg`]);
  execFileSync("ffmpeg", [...common, "-c:a", "libmp3lame", "-q:a", "4", `${base}.mp3`]);
}

function buildVehicle(id, spec, tmp) {
  const cfgPath = path.join(ROOT, "public", "vehicles", id, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const e = cfg.engine;
  const sources = spec.sources;
  const src = (k) => {
    if (!sources[k]) throw new Error(`${id}: unknown source "${k}"`);
    return sources[k];
  };

  // Hz -> rpm: the tracked pitch is the engine cycle frequency (rpm / 120 for a four-stroke)
  const cal = spec.calibration ?? {};
  let rpmPerHz = cal.rpmPerHz ?? 120; // cycle frequency -> rpm
  if (cal.idle) {
    const calData = load(src(cal.source), spec.pitchRange);
    const idleF0 = median(calData.track.filter((f) => f.t >= cal.idle[0] && f.t <= cal.idle[1]).map((f) => f.f0));
    rpmPerHz = e.idleRpm / idleF0;
  }
  console.log(`  ${rpmPerHz.toFixed(2)} rpm/Hz`);

  // expand "ramp" entries: for each target rpm, a short window where a rising sweep crosses it
  const segments = [];
  for (const seg of spec.loops) {
    if (!seg.ramp) {
      segments.push(seg);
      continue;
    }
    const { track } = load(src(seg.source), spec.pitchRange);
    const frames = track.filter((f) => f.t >= seg.ramp[0] && f.t <= seg.ramp[1]);
    for (const rpm of seg.targets) {
      const f0 = rpm / rpmPerHz;
      const falling = seg.dir === "fall";
      const i = frames.findIndex((f, k) => k > 0 && (falling ? frames[k - 1].f0 > f0 && f.f0 <= f0 : frames[k - 1].f0 < f0 && f.f0 >= f0));
      if (i < 0) {
        console.log(`  (ramp never crosses ${rpm} rpm, skipped)`);
        continue;
      }
      // widen the window while the pitch stays within +-10% of the target
      let a = i;
      let b = i;
      const tol = seg.tol ?? 0.1;
      const near = (f) => f.f0 > f0 * (1 - tol) && f.f0 < f0 * (1 + tol);
      while (a > 0 && near(frames[a - 1]) && frames[i].t - frames[a - 1].t < (seg.maxHalfS ?? 0.4)) a--;
      while (b < frames.length - 1 && near(frames[b + 1]) && frames[b + 1].t - frames[i].t < (seg.maxHalfS ?? 0.4)) b++;
      segments.push({ kind: seg.kind, source: seg.source, t: [frames[a].t, frames[b].t] });
    }
  }

  const loops = [];
  for (const seg of segments) {
    let samples;
    let rpm;
    if (seg.designed) {
      // ready-made loop with a known rpm: use it whole (crossfade-loop it once to be safe)
      const { x } = load(src(seg.source), spec.pitchRange);
      const body = seg.t ? slice(x, seg.t) : x;
      rpm = seg.rpm;
      samples = makeLoop(body, (rpm / rpmPerHz) || 50, { crossfadeS: 0.04 }).loop;
    } else {
      const { x, track } = load(src(seg.source), spec.pitchRange);
      const f0s = track.filter((f) => f.t >= seg.t[0] && f.t <= seg.t[1]).map((f) => f.f0 * (seg.octave ?? 1));
      if (!f0s.length) throw new Error(`${id}: no pitch frames in ${seg.t}`);
      const target = median(f0s);
      const scaledTrack = seg.octave ? track.map((f) => ({ ...f, f0: f.f0 * seg.octave })) : track;
      // idle is often left unflattened: its natural lope is the point, and trackers wander at idle
      const body = seg.flatten === false ? slice(x, seg.t) : flatten(x, scaledTrack, seg.t[0], seg.t[1], target);
      const made = makeLoop(body, target, { crossfadeS: Math.min(0.06, (body.length / SR) * 0.2) });
      samples = made.loop;
      rpm = seg.rpm ?? target * rpmPerHz;
      console.log(`  ${seg.kind.padEnd(4)} ${seg.t[0]}-${seg.t[1]}s  f0 ${target.toFixed(1)} Hz -> ${Math.round(rpm)} rpm  loop ${(samples.length / SR).toFixed(2)}s corr ${made.correlation.toFixed(2)}`);
    }
    samples = filterLoop(samples, "hp", 28, 0.7);
    loops.push({ kind: seg.kind, rpm, samples });
  }

  const idle = loops.find((l) => l.kind === "idle");
  const on = loops.filter((l) => l.kind === "on").sort((a, b) => a.rpm - b.rpm);
  if (!idle || on.length < 2) throw new Error(`${id}: need an idle loop and at least two on-load loops`);

  // overrun: the same loops, darker and softer (they stay phase-aligned with the on-load ones)
  const off = on.map((l) => ({ kind: "off", rpm: l.rpm, samples: filterLoop(filterLoop(l.samples, "lp", spec.offLoadLowpassHz ?? 1400, 0.6), "lp", (spec.offLoadLowpassHz ?? 1400) * 1.6, 0.6) }));

  // loudness along a smooth curve
  const span = e.limiterRpm - e.idleRpm;
  const target = (l) => {
    const x = Math.min(1, Math.max(0, (l.rpm - e.idleRpm) / span));
    if (l.kind === "idle") return 0.11;
    return l.kind === "on" ? 0.13 + 0.09 * Math.sqrt(x) : 0.075 + 0.04 * x;
  };
  for (const l of [idle, ...on, ...off]) {
    const g = target(l) / (rms(l.samples) || 1);
    for (let i = 0; i < l.samples.length; i++) l.samples[i] *= g;
    softClip(l.samples);
  }

  // one-shots cut from the recordings
  const shots = {};
  for (const [name, cut] of Object.entries(spec.oneShots ?? {})) {
    const { x } = load(src(cut.source), spec.pitchRange);
    let s = filterOnce(slice(x, cut.t), "hp", 28, 0.7);
    s = fade(s, cut.fadeIn ?? 0.01, cut.fadeOut ?? 0.15);
    const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
    for (let i = 0; i < s.length; i++) s[i] *= (cut.peak ?? 0.8) / peak;
    shots[name] = s;
  }

  // write files: drop old loops, keep generated one-shots the manifest doesn't replace
  const dir = path.join(ROOT, "public", "vehicles", id, "sounds");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^(idle|on|off)_/.test(f) || Object.keys(shots).some((k) => f.startsWith(`${k}.`))) unlinkSync(path.join(dir, f));
  const name = (l) => `${l.kind}_${Math.round(l.rpm)}`;
  for (const l of [idle, ...on, ...off]) encode(l.samples, path.join(dir, name(l)), tmp);
  for (const [n, s] of Object.entries(shots)) encode(s, path.join(dir, n), tmp);

  const ref = (l) => ({ file: `${name(l)}.ogg`, rpm: Math.round(l.rpm * 1000) / 1000 });
  const present = (f) => existsSync(path.join(dir, f));
  const prev = cfg.audio?.oneShots ?? {};
  cfg.audio = {
    mode: "samples",
    onLoad: on.map(ref),
    offLoad: off.map(ref),
    idle: ref(idle),
    oneShots: {
      start: present("start.ogg") ? "start.ogg" : prev.start,
      stop: present("stop.ogg") ? "stop.ogg" : prev.stop,
      shift: (prev.shift ?? []).filter(present),
      backfire: (prev.backfire ?? []).filter(present),
      ...(prev.blowoff ? { blowoff: prev.blowoff.filter(present) } : {}),
    },
    masterGainDb: cfg.audio?.masterGainDb ?? 0,
  };
  cfg.ui = { ...cfg.ui, recorded: true };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const kb = readdirSync(dir).filter((f) => f.endsWith(".ogg")).reduce((s, f) => s + statSync(path.join(dir, f)).size, 0) / 1024;
  console.log(`  -> ${on.length} on-load loops (${on.map((l) => Math.round(l.rpm)).join(", ")} rpm), ${kb.toFixed(0)} KB ogg`);
}

function writeCredits() {
  const credits = [];
  for (const [id, spec] of Object.entries(manifest.vehicles)) {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, "public", "vehicles", id, "config.json"), "utf8"));
    const realShots = Object.keys(spec.oneShots ?? {});
    const generated = ["start", "stop"].filter((k) => !realShots.includes(k));
    for (const s of Object.values(spec.sources)) {
      const files = ["Engine loops (idle, on-load, overrun)", ...realShots.map((k) => `${k} sound`)].join(", ");
      credits.push({ vehicle: cfg.name, files, author: s.author, source: s.title + (s.bundle ? ` (${s.bundle})` : ""), license: manifest.license.name });
    }
    const gen = [...generated.map((k) => `${k}`), "shift", "backfire", "blow-off"].join(", ");
    credits.push({ vehicle: cfg.name, files: `Generated one-shots: ${gen}`, author: "Revheadz (generated)", source: "scripts/generate-sounds.mjs", license: "CC0 1.0" });
  }
  const existing = JSON.parse(readFileSync(path.join(ROOT, "credits.json"), "utf8"));
  const realNames = new Set(credits.map((c) => c.vehicle));
  const keep = existing.filter((c) => !realNames.has(c.vehicle));
  writeFileSync(path.join(ROOT, "credits.json"), JSON.stringify([...credits, ...keep], null, 2) + "\n");
}

const only = process.argv[2];
const tmp = mkdtempSync(path.join(tmpdir(), "revheadz-real-"));
try {
  for (const [id, spec] of Object.entries(manifest.vehicles)) {
    if (only && only !== id) continue;
    console.log(`\n${id}`);
    buildVehicle(id, spec, tmp);
  }
  writeCredits();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
