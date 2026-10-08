# Revheadz: engine sound simulator

A free, browser-based engine simulator: pick a vehicle, start it, rev it, shift gears and hear it respond in real time.
Built with Next.js (App Router, static export), TypeScript, Tailwind and the Web Audio API. No server, no accounts, ₹0 to run.

Based on the MVP plan in `Engine Sound Simulator MVP — Detailed Plan.pdf`.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # Vitest: simulation, audio maths, configs, input
npm run build      # runs tests first, then exports a static site to out/
```

## Shifting

Shifts happen in two phases: a torque cut with the clutch open (rpm falls under engine braking on upshifts;
an automatic blip rev-matches downshifts, and you hear it), then clutch engagement where rpm blends onto the new
gear and drive torque ramps back. Gearbox types (`gearbox.type`): `manual` (slow, long clutch slip), `dct`
(near-seamless, ignition-cut crack on loaded upshifts) and `sequential` (bike quickshifter + auto-blipper).

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Throttle (hold) |
| `S` / `↓` | Brake (hold) |
| `E` / `Q` | Shift up / down |
| `N` | Neutral |
| `Space` | Throttle blip |
| `I` | Ignition on/off |

On touch devices: vertical throttle slider (right, springs back), brake pad and shift buttons (left). Landscape is preferred.

## How it is put together

```
lib/sim/        pure TypeScript, no React: Engine, Gearbox, Simulation (fixed 120 Hz step)
lib/audio/      Web Audio: AudioEngine, SampleLayer (RPM crossfade), SynthEngine (AudioWorklet), OneShots
lib/assets/     fetch + decode + cache of a vehicle's sounds
lib/input/      keyboard / touch -> throttle, brake, commands
lib/vehicles/   typed configs, validation (build fails if a sound file is missing)
components/     React UI; gauges draw on <canvas> every frame, outside React
public/vehicles/<id>/config.json (+ sounds/)   one folder per vehicle
```

Only the simulation loop changes engine state. Audio and UI read it. RPM and speed never go through React state;
only gear and ignition do (`hooks/useEngineState.ts`, via `useSyncExternalStore`).

## Adding a vehicle

1. Create `public/vehicles/<id>/config.json` (copy one; set `engine`, `gearbox`, `dynamics`, optional `turbo`, and `ui`).
2. Add a voice for it in `VOICES` in `scripts/generate-sounds.mjs` and run `node scripts/generate-sounds.mjs <id>`
   (or supply your own `.ogg` **and** `.mp3` files and write the `audio` section by hand).
3. Import the config in `lib/vehicles/index.ts` and add it to the list.
4. Add its sounds to `credits.json`.

`npm test` and `npm run build` fail if a referenced sound file (either format) is missing or a config is invalid.

## Vehicles

Eleven: Muscle V8, Inline-6 Turbo, Flat-6 Sports Coupe, V10 Supercar, V12 Grand Tourer, Hot Hatch Turbo-4,
Boxer-4 Rally Turbo, Twin-Rotor Rotary, Inline-4 Superbike, V-Twin Cruiser, and the live-synthesized Synth V6.
Names are generic on purpose (no brands or model names) to avoid trademark issues.

## Sounds

**Real recordings (5 vehicles).** Muscle V8, Flat-6 Sports Coupe, V12 Grand Tourer, Hot Hatch Turbo-4 and Inline-4
Superbike use professional recordings from the free Sonniss #GameAudioGDC bundles (royalty-free, commercial use,
no attribution required; credited anyway on the Credits page). They are built by `scripts/build-real-sounds.mjs`
from the manifest `scripts/real-sounds.json`:

1. download each source recording (cached in `.sound-cache/`, not committed)
2. track the engine **cycle frequency** (rpm / 120, the spacing of the harmonic comb every engine shows) with a
   40-harmonic tracker; for noisy sweeps the manifest can give hand-verified `[time, rpm]` anchors read off a spectrogram
3. cut each steady section (or windows of a full-throttle ramp), flatten its pitch to one exact rpm, and crossfade it
   into a seamless loop; idle stays unflattened to keep its natural lope
4. make overrun variants (darker, softer), normalise loudness along a smooth rpm curve, cut real start/stop sounds,
   encode `.ogg` + `.mp3`, and write the vehicle's `audio` config and `credits.json`

```bash
node scripts/build-real-sounds.mjs             # all real-sound vehicles (needs ffmpeg + internet the first time)
node scripts/build-real-sounds.mjs muscle_v8
```

Each vehicle's idle and redline were matched to its source engine. Shift, backfire and blow-off one-shots are still
generated.

**Generated (5 vehicles + synth).** Inline-6 Turbo, V10 Supercar, Boxer-4 Rally Turbo, Twin-Rotor Rotary and V-Twin
Cruiser use original sounds from a physical engine model (`scripts/generate-sounds.mjs`, CC0), because the free
recordings available for them only cover idle and quick blips, not steady or ramping high RPM. Synth V6 is
synthesised live in the browser.

```bash
npm run sounds                 # regenerate generated sounds (needs ffmpeg, ~1 min)
```

Smoothness: all loops of a vehicle start at the same instant and every loop's `playbackRate` is driven by
`rpm / sampleRpm`, so they advance together; crossfades use a constant-loudness law for partly correlated loops.

## Adding a vehicle

1. Create `public/vehicles/<id>/config.json` (copy one; set `engine`, `gearbox`, `dynamics`, optional `turbo`, and `ui`).
2. Add a voice for it in `VOICES` in `scripts/generate-sounds.mjs` and run `node scripts/generate-sounds.mjs <id>`
   (or supply your own `.ogg` **and** `.mp3` files and write the `audio` section by hand).
3. Import the config in `lib/vehicles/index.ts` and add it to the list.
4. Add its sounds to `credits.json`.

`npm test` and `npm run build` fail if a referenced sound file (either format) is missing or a config is invalid.

## Vehicles

Eleven: Muscle V8, Inline-6 Turbo, Flat-6 Sports Coupe, V10 Supercar, V12 Grand Tourer, Hot Hatch Turbo-4,
Boxer-4 Rally Turbo, Twin-Rotor Rotary, Inline-4 Superbike, V-Twin Cruiser, and the live-synthesized Synth V6.
Names are generic on purpose (no brands or model names) to avoid trademark issues.

## Sounds

Sample-based vehicles ship with **original sounds from a physical engine model** (`scripts/generate-sounds.mjs`, CC0):
real firing orders and crank angles (cross-plane V8 burble, 45° V-twin lope, unequal-length boxer headers, rotary),
per-bank exhaust pipes with reflections, muffler resonances, intake roar, valvetrain, turbo whistle/hiss, overrun crackle,
plus start, stop, shift, backfire and blow-off one-shots. The generator also writes each config's `audio` section.

Smoothness: every loop holds a whole number of engine cycles and starts at the same crank angle; the player starts
all loops at the same instant and drives every loop's `playbackRate` with `rpm / sampleRpm`, so the loops stay
phase-locked and crossfades don't flange or spike. Loudness follows a smooth curve over rpm and load.

```bash
npm run sounds                 # regenerate all vehicles (needs ffmpeg, ~1 min)
node scripts/generate-sounds.mjs muscle_v8
```

To use real recordings instead, replace files keeping the names and RPMs (`on_3000.ogg` + `.mp3`), and log each one
in `credits.json`. Only CC0 / CC-BY sounds or your own recordings; no NC files.

## Deploy (Vercel Hobby)

Push to GitHub and import in Vercel; it detects Next.js. `next.config.ts` sets `output: "export"`, and `vercel.json` adds
long-lived cache headers for `/vehicles/*` (rename a file when it changes). Optional: set `NEXT_PUBLIC_FEEDBACK_URL`
(Google Form / GitHub Issues) to show a feedback link in the garage footer.
Vercel Hobby is non-commercial; static export moves to Netlify or Cloudflare Pages unchanged.
