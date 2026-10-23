"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "../../lib/analytics";
import { AudioEngine } from "../../lib/audio/AudioEngine";
import { CPU_LEVELS } from "../../lib/drag/cpu";
import { hostRoom, joinRoom, normaliseCode, randomCode, type Message, type Player, type Room } from "../../lib/drag/net";
import { CLASSES, classOf, type DragClass } from "../../lib/drag/classes";
import { decide, dialIn, type DriveKey, type DriveLog, type RunResult } from "../../lib/drag/race";
import { Simulation } from "../../lib/sim/Simulation";
import { getVehicle, vehicles } from "../../lib/vehicles";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { Logo } from "../Logo";
import { Silhouette } from "../Silhouette";
import { RaceView, type Opponent, type RaceOutcome } from "./RaceView";
import { Sfx } from "./sfx";

type Mode = "cpu" | "online";
type CpuLevel = keyof typeof CPU_LEVELS;
type Phase = "menu" | "hosting" | "joining" | "lobby" | "race" | "results";

interface RaceSetup {
  id: number;
  startAt: number;
  myOffset: number;
  oppOffset: number;
}

interface Result {
  outcome: "win" | "lose" | "tie";
  marginMs: number;
  mine: RunResult;
  theirs: RunResult | null;
}

/** Time from "go" to the cars rolling into the beams: the VS intro plays meanwhile. */
const LEAD_MS = 3200;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

const fmt = (ms: number | null | undefined, digits = 3) => (ms === null || ms === undefined || !Number.isFinite(ms) ? "–" : (ms / 1000).toFixed(digits));

export function DragApp() {
  const [phase, setPhase] = useState<Phase>("menu");
  const [mode, setMode] = useState<Mode>("cpu");
  const [name, setName] = useState("Driver");
  const [carId, setCarId] = useState("supra_mk4");
  const [cpuCarId, setCpuCarId] = useState("mustang_gt");
  const [cpuLevel, setCpuLevel] = useState<CpuLevel>("club");
  const [code, setCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opponent, setOpponent] = useState<Player | null>(null);
  const [meReady, setMeReady] = useState(false);
  const [oppReady, setOppReady] = useState(false);
  const [race, setRace] = useState<RaceSetup | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [score, setScore] = useState({ me: 0, them: 0 });
  const [copied, setCopied] = useState(false);
  const [assist, setAssist] = useState(false);
  const [sfx] = useState(() => new Sfx());

  const roomRef = useRef<Room | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const remoteEvents = useRef<[number, DriveKey][]>([]);
  const remoteLog = useRef<DriveLog | null>(null);
  const raceCounter = useRef(0);
  const audioRef = useRef<{ engine: AudioEngine; carId: string } | null>(null);
  // the same engine, as state, for rendering the race
  const [raceAudio, setRaceAudio] = useState<AudioEngine | null>(null);
  // the opponent's engine, heard beside you (quieter)
  const oppAudioRef = useRef<{ engine: AudioEngine; carId: string } | null>(null);
  const [oppAudio, setOppAudio] = useState<AudioEngine | null>(null);
  const warmSim = useRef<Simulation | null>(null);

  const myCfg = getVehicle(carId)!;
  // heads-up classes: the CPU always brings a car from your class
  const myClass = classOf(carId);
  const cpuCar = myClass.cars.includes(cpuCarId) && (cpuCarId !== carId || myClass.cars.length === 1) ? cpuCarId : rivalIn(myClass, carId);
  const oppCfg = mode === "cpu" ? getVehicle(cpuCar)! : opponent ? getVehicle(opponent.carId) ?? null : null;
  const classMismatch = mode === "online" && Boolean(opponent) && classOf(opponent!.carId).id !== myClass.id;

  // remembered name and car; a ?room= link joins straight away
  useEffect(() => {
    const n = store.get("revheadz:drag-name");
    const c = store.get("revheadz:drag-car");
    // restore from storage; a distinct default, so two first-time players aren't both "Driver"
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from storage
    setName(n || `Racer ${Math.floor(1000 + Math.random() * 9000)}`);
    if (c && getVehicle(c)) setCarId(c);
    const a = store.get("revheadz:drag-assist");
    setAssist(a === null ? window.matchMedia("(pointer: coarse)").matches : a === "1");
    const room = new URLSearchParams(window.location.search).get("room");
    if (room) setJoinCode(normaliseCode(room));
  }, []);

  // keep the engine-sound object for my car; the warm sim idles it between races
  const ensureAudio = (cfg: VehicleConfig) => {
    if (audioRef.current?.carId !== cfg.id) {
      audioRef.current?.engine.dispose();
      const engine = new AudioEngine(cfg);
      engine.attach();
      engine.setVolume(0.8);
      audioRef.current = { engine, carId: cfg.id };
      setRaceAudio(engine);
      warmSim.current = null;
    }
    const a = audioRef.current.engine;
    a.unlock(); // inside the tap
    return a;
  };
  const ensureOppAudio = (cfg: VehicleConfig | null) => {
    if (!cfg) return;
    if (oppAudioRef.current?.carId !== cfg.id) {
      oppAudioRef.current?.engine.dispose();
      const engine = new AudioEngine(cfg);
      engine.attach();
      engine.setVolume(0.38);
      oppAudioRef.current = { engine, carId: cfg.id };
      setOppAudio(engine);
    }
    oppAudioRef.current.engine.unlock(); // inside the tap
  };
  const startWarmEngine = (cfg: VehicleConfig) => {
    const a = ensureAudio(cfg);
    if (!warmSim.current) {
      const sim = new Simulation(cfg);
      sim.subscribe((e) => a.handleEvent(e));
      warmSim.current = sim;
      void a.whenReady(2500).then(() => sim.state.ignition === "off" && sim.toggleIgnition());
    }
  };
  // the warm engine idles while we're not racing; hold W to blip it at your opponent
  useEffect(() => {
    if (phase === "race") return;
    const rev = (e: KeyboardEvent) => {
      if ((e.code !== "KeyW" && e.code !== "ArrowUp") || e.target instanceof HTMLInputElement) return;
      const sim = warmSim.current;
      if (sim) sim.input.throttle = e.type === "keydown" ? 1 : 0;
    };
    window.addEventListener("keydown", rev);
    window.addEventListener("keyup", rev);
    return () => {
      window.removeEventListener("keydown", rev);
      window.removeEventListener("keyup", rev);
    };
  }, [phase]);
  useEffect(() => {
    if (phase === "race") return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const sim = warmSim.current;
      const a = audioRef.current?.engine;
      if (sim && a) {
        sim.advance((now - last) / 1000);
        a.update(sim.state);
      }
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase]);
  useEffect(
    () => () => {
      audioRef.current?.engine.dispose();
      oppAudioRef.current?.engine.dispose();
      cancelRef.current?.();
      roomRef.current?.close();
    },
    [],
  );

  const me: Player = useMemo(() => ({ name: name.trim().slice(0, 16) || "Driver", carId, assist }), [name, carId, assist]);
  const send = (m: Message) => roomRef.current?.send(m);

  // tell the opponent when my name or car changes
  useEffect(() => {
    send({ type: "hello", player: me });
    store.set("revheadz:drag-name", me.name);
    store.set("revheadz:drag-car", me.carId);
    store.set("revheadz:drag-assist", me.assist ? "1" : "0");
  }, [me]);

  const leave = (msg?: string) => {
    roomRef.current?.close();
    roomRef.current = null;
    cancelRef.current?.();
    cancelRef.current = null;
    setOpponent(null);
    setMeReady(false);
    setOppReady(false);
    setRace(null);
    setScore({ me: 0, them: 0 });
    setPhase("menu");
    if (msg) setError(msg);
  };

  const beginRace = (startAt: number, id: number, oppCar: VehicleConfig) => {
    void oppCar; // heads-up: no head starts
    const [mine, theirs] = [0, 0];
    remoteEvents.current = [];
    remoteLog.current = null;
    setResult(null);
    setRace({ id, startAt, myOffset: mine, oppOffset: theirs });
    setPhase("race");
  };

  const latest = useRef({ beginRace, meReady, oppReady, phase, opponent });
  useEffect(() => {
    latest.current = { beginRace, meReady, oppReady, phase, opponent };
  });

  const onMessage = (m: Message) => {
    const l = latest.current;
    if (m.type === "hello") setOpponent(m.player);
    else if (m.type === "ready") setOppReady(m.ready);
    else if (m.type === "start") {
      const room = roomRef.current;
      const opp = l.opponent && getVehicle(l.opponent.carId);
      if (!room || !opp) return;
      raceCounter.current = m.race;
      l.beginRace(m.atHost - room.offset(), m.race, opp);
    } else if (m.type === "input") {
      if (m.race === raceCounter.current) remoteEvents.current = [...remoteEvents.current, [m.ms, m.key]];
    } else if (m.type === "log") {
      if (m.race === raceCounter.current) remoteLog.current = m.log;
    }
  };

  const events = {
    onOpen: (room: Room) => {
      roomRef.current = room;
      setError(null);
      setPhase("lobby");
      room.send({ type: "hello", player: me });
      trackEvent("drag_room", { role: room.isHost ? "host" : "guest" });
    },
    onMessage: (m: Message) => onMessage(m),
    onClose: (reason: string) => leave(reason),
    onError: (message: string) => {
      setError(message);
      if (!roomRef.current) setPhase("menu");
    },
  };

  const create = async () => {
    setMode("online");
    setError(null);
    const c = randomCode();
    setCode(c);
    setPhase("hosting");
    cancelRef.current = await hostRoom(c, events);
  };
  const join = async () => {
    const c = normaliseCode(joinCode);
    if (c.length !== 4) {
      setError("Room codes are 4 characters.");
      return;
    }
    setMode("online");
    setError(null);
    setCode(c);
    setPhase("joining");
    cancelRef.current = await joinRoom(c, events);
  };
  const practice = () => {
    setMode("cpu");
    setError(null);
    setPhase("lobby");
  };

  // Ready: warms the engine (this tap unlocks audio). The host starts the race when both are ready.
  const ready = () => {
    startWarmEngine(myCfg);
    ensureOppAudio(oppCfg);
    sfx.unlock();
    if (mode === "cpu") {
      raceCounter.current += 1;
      beginRace(performance.now() + LEAD_MS, raceCounter.current, getVehicle(cpuCar)!);
      return;
    }
    const next = !meReady;
    setMeReady(next);
    send({ type: "ready", ready: next });
  };
  // host: both ready -> schedule the tree
  useEffect(() => {
    const room = roomRef.current;
    if (!room?.isHost || mode !== "online" || !meReady || !oppReady || phase === "race" || !oppCfg || classMismatch) return;
    raceCounter.current += 1;
    const at = performance.now() + LEAD_MS;
    room.send({ type: "start", race: raceCounter.current, atHost: at });
    latest.current.beginRace(at, raceCounter.current, oppCfg);
  }, [meReady, oppReady, phase, mode, oppCfg, classMismatch]);

  const onDone = (o: RaceOutcome) => {
    if (!race) return;
    const theirs = o.oppResult;
    const winner = theirs ? decide(o.myResult, theirs, [race.myOffset, race.oppOffset]) : "a";
    const margin = theirs ? Math.abs(race.myOffset + o.myResult.elapsedMs - (race.oppOffset + theirs.elapsedMs)) : 0;
    const outcome = winner === "a" ? "win" : winner === "b" ? "lose" : "tie";
    setResult({ outcome, marginMs: Number.isFinite(margin) ? margin : 0, mine: o.myResult, theirs });
    setScore((s) => ({ me: s.me + (outcome === "win" ? 1 : 0), them: s.them + (outcome === "lose" ? 1 : 0) }));
    setMeReady(false);
    setOppReady(false);
    setPhase("results");
    trackEvent("drag_race", { mode, outcome, reaction: Math.round(o.myResult.reactionMs ?? -1) });
  };

  const opponentView: Opponent = mode === "cpu" ? { kind: "cpu", skill: CPU_LEVELS[cpuLevel] } : { kind: "remote", events: remoteEvents, log: remoteLog };
  const oppName = mode === "cpu" ? `CPU (${cpuLevel})` : opponent?.name ?? "Opponent";
  const shareUrl = typeof window !== "undefined" && code ? `${window.location.origin}/drag?room=${code}` : "";

  if (phase === "race" && race && oppCfg && raceAudio) {
    return (
      <RaceView
        key={race.id}
        me={{ name: me.name, cfg: myCfg, offsetMs: race.myOffset, assist }}
        opp={{ name: oppName, cfg: oppCfg, offsetMs: race.oppOffset, assist: mode === "cpu" ? true : (opponent?.assist ?? false) }}
        startAt={race.startAt}
        opponent={opponentView}
        audio={raceAudio}
        oppAudio={oppAudio}
        sfx={sfx}
        onInput={mode === "online" ? (ms, key) => send({ type: "input", race: race.id, ms, key }) : undefined}
        onFinish={mode === "online" ? (log) => send({ type: "log", race: race.id, log }) : undefined}
        onDone={onDone}
      />
    );
  }

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="garage-backdrop pointer-events-none absolute inset-x-0 top-0 h-[420px]" />
      <div className="relative mx-auto max-w-4xl px-4 py-6 sm:py-10">
        <nav className="flex items-center justify-between gap-4" aria-label="Site">
          <Link href="/" aria-label="Revheadz home" className="transition active:scale-95">
            <Logo size="md" />
          </Link>
          {phase === "menu" ? (
            <Link href="/" className="chip shrink-0">
              ← Modes
            </Link>
          ) : (
            <button type="button" className="chip shrink-0" onClick={() => leave()}>
              Leave
            </button>
          )}
        </nav>

        <header className="mt-8 flex items-center justify-between gap-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-lime-300">Head to head</p>
            <h1 className="mt-2 text-4xl font-black italic tracking-tight text-zinc-50 sm:text-5xl">Drag Racing</h1>
            <p className="mt-3 max-w-xl text-zinc-400">
              Heads-up drag racing: both trees go green together and first to the line wins. Cars race in classes, and every car in a class runs
              the same perfect quarter mile, so there's no mismatch. Launch on the green, hit every shift light, stay on the gas. Jump the light and
              you red-light.
            </p>
            <ul className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-300">
              <li className="stat-pill">Online PvP · room codes</li>
              <li className="stat-pill">{vehicles.length} machines</li>
              <li className="stat-pill">W S E Q · or one button</li>
            </ul>
          </div>
          <div className="tree hidden shrink-0 flex-col gap-3 rounded-2xl border border-white/10 bg-black/40 p-4 sm:flex" aria-hidden>
            {["#facc15", "#facc15", "#facc15", "#22c55e"].map((c, i) => (
              <span key={i} className="tree-light" style={{ "--c": c, animationDelay: `${i * 0.45}s` } as React.CSSProperties} />
            ))}
          </div>
        </header>

        {error && (
          <p role="alert" className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}

        {phase === "menu" && (
          <section className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="drag-panel">
              <label className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500" htmlFor="drag-name">
                Your name
              </label>
              <input id="drag-name" className="drag-input mt-2" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} />
              <CarPicker value={carId} onChange={setCarId} label="Your car" />
            </div>
            <div className="flex flex-col gap-3">
              <button type="button" className="drag-cta" onClick={() => void create()}>
                <b>Create a room</b>
                <span>Get a code to send a friend</span>
              </button>
              <div className="drag-panel">
                <label className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500" htmlFor="drag-code">
                  Join with a code
                </label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="drag-code"
                    className="drag-input font-mono uppercase tracking-[0.3em]"
                    placeholder="ABCD"
                    value={joinCode}
                    onChange={(e) => setJoinCode(normaliseCode(e.target.value))}
                    onKeyDown={(e) => e.key === "Enter" && void join()}
                  />
                  <button type="button" className="chip chip-on shrink-0" onClick={() => void join()}>
                    Join
                  </button>
                </div>
              </div>
              <button type="button" className="drag-cta drag-cta-ghost" onClick={practice}>
                <b>Practice vs CPU</b>
                <span>No friend handy? Race the computer</span>
              </button>
            </div>
          </section>
        )}

        {(phase === "hosting" || phase === "joining") && (
          <section className="drag-panel mt-8 text-center">
            {phase === "hosting" ? (
              <>
                <p className="text-sm text-zinc-400">Send this code to your opponent</p>
                <p className="mt-2 font-mono text-5xl font-black tracking-[0.3em] text-white">{code}</p>
                <button
                  type="button"
                  className="chip mt-4"
                  onClick={() => {
                    void navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Link copied" : "Copy invite link"}
                </button>
                <p className="mt-6 animate-pulse text-sm text-zinc-500">Waiting for them to join…</p>
              </>
            ) : (
              <p className="animate-pulse text-zinc-400">Connecting to room {code}…</p>
            )}
          </section>
        )}

        {(phase === "lobby" || phase === "results") && (
          <section className="mt-8 space-y-5">
            {phase === "results" && result && race && oppCfg && (
              <TimeSlip result={result} meName={me.name} oppName={oppName} myCfg={myCfg} oppCfg={oppCfg} offsets={[race.myOffset, race.oppOffset]} />
            )}
            <div className="faceoff">
              <PlayerCard side="left" title={me.name} you cfg={myCfg} ready={mode === "cpu" || meReady} score={score.me} />
              <div className="faceoff-vs">
                <span>VS</span>
                {oppCfg && <HeadsUpLine me={myCfg} opp={oppCfg} oppName={oppName} />}
              </div>
              {oppCfg ? (
                <PlayerCard side="right" title={oppName} cfg={oppCfg} ready={mode === "cpu" || oppReady} score={score.them} />
              ) : (
                <div className="drag-panel grid place-items-center text-center text-sm text-zinc-500">
                  <span className="animate-pulse">Waiting for your opponent…</span>
                </div>
              )}
            </div>
            {classMismatch && opponent && (
              <p role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-center text-sm text-amber-100">
                {opponent.name} is in the <b>{classOf(opponent.carId).name}</b> class. Pick a {classOf(opponent.carId).name} car (or ask them to pick a {myClass.name} one): heads-up races are within a class.
              </p>
            )}
            <button type="button" className={`drag-cta drag-cta-big w-full ${meReady ? "drag-cta-ghost" : ""}`} onClick={ready} disabled={mode === "online" && (!oppCfg || classMismatch)}>
              <b>{mode === "cpu" ? (phase === "results" ? "Race again" : "Stage it") : meReady ? "Ready! Waiting for them…" : phase === "results" ? "Rematch" : "I'm ready"}</b>
              <span>{mode === "online" ? `Room ${code} · the tree starts when you're both ready` : "Engines start now. Turn your volume down a little."}</span>
            </button>
            <div className="grid items-start gap-4 lg:grid-cols-[1.3fr_1fr]">
              <div className="drag-panel">
                <ClassPicker
                  value={myClass.id}
                  onChange={(c) => {
                    if (c.id === myClass.id) return;
                    setCarId(c.cars[0]);
                    setMeReady(false);
                    send({ type: "ready", ready: false });
                  }}
                />
                <CarPicker
                  value={carId}
                  ids={myClass.cars}
                  onChange={(id) => {
                    setCarId(id);
                    setMeReady(false);
                    send({ type: "ready", ready: false });
                  }}
                  label={`Your ${myClass.name} car`}
                />
              </div>
              <div className="space-y-4">
                <ControlsPanel
                  assist={assist}
                  onChange={(a) => {
                    setAssist(a);
                    setMeReady(false);
                    send({ type: "ready", ready: false });
                  }}
                />
                {mode === "cpu" && (
                  <div className="drag-panel">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">CPU skill</p>
                    <div className="mt-3 flex gap-2" role="group" aria-label="CPU skill">
                      {(Object.keys(CPU_LEVELS) as CpuLevel[]).map((l) => (
                        <button key={l} type="button" aria-pressed={cpuLevel === l} onClick={() => setCpuLevel(l)} className={`chip capitalize ${cpuLevel === l ? "chip-on" : ""}`}>
                          {l}
                        </button>
                      ))}
                    </div>
                    <CarPicker value={cpuCar} ids={myClass.cars} onChange={setCpuCarId} label={`CPU ${myClass.name} car`} compact />
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ControlsPanel({ assist, onChange }: { assist: boolean; onChange: (assist: boolean) => void }) {
  return (
    <div className="drag-panel">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Controls</p>
      <div className="segmented mt-3 w-fit" style={{ "--accent": "#a3e635" } as React.CSSProperties} role="group" aria-label="Controls">
        <button type="button" aria-pressed={!assist} onClick={() => onChange(false)}>
          Pro
        </button>
        <button type="button" aria-pressed={assist} onClick={() => onChange(true)}>
          Simple
        </button>
      </div>
      {assist ? (
        <dl className="controls-table mt-4">
          <dt>
            <kbd className="keycap">Space</kbd>
            <span className="text-zinc-600">/ tap</span>
          </dt>
          <dd>Launch on the green, then shift on every light</dd>
          <dt>
            <kbd className="keycap">Q</kbd>
          </dt>
          <dd>Shift down</dd>
          <dt className="text-zinc-500">Gas</dt>
          <dd>Held flat for you</dd>
        </dl>
      ) : (
        <dl className="controls-table mt-4">
          <dt>
            <kbd className="keycap">S</kbd>+<kbd className="keycap">W</kbd>
          </dt>
          <dd>Hold to stage on the two-step</dd>
          <dt>
            <kbd className="keycap">S</kbd>
            <span className="text-zinc-600">release</span>
          </dt>
          <dd>Launch on the green (early = red light)</dd>
          <dt>
            <kbd className="keycap">E</kbd>
            <kbd className="keycap">Space</kbd>
          </dt>
          <dd>Shift up when the lights flash</dd>
          <dt>
            <kbd className="keycap">Q</kbd>
          </dt>
          <dd>Shift down</dd>
          <dt>
            <kbd className="keycap">W</kbd>
            <span className="text-zinc-600">hold</span>
          </dt>
          <dd>Stay flat: lifting costs time</dd>
        </dl>
      )}
    </div>
  );
}

function CarPicker({ value, onChange, label, compact, ids }: { value: string; onChange: (id: string) => void; label: string; compact?: boolean; ids?: string[] }) {
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = vehicles.filter((v) => (!ids || ids.includes(v.id)) && words.every((w) => `${v.name} ${v.ui.make ?? ""} ${v.ui.layout}`.toLowerCase().includes(w)));
  return (
    <div className="mt-4 first:mt-0">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">{label}</p>
        <span className="text-xs text-zinc-600">{list.length} machines</span>
      </div>
      <input className="drag-input mt-2" placeholder="Search Supra, V12, bike…" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${label}`} />
      <ul className={`car-grid no-scrollbar mt-3 ${compact ? "car-grid-compact" : ""}`} role="listbox" aria-label={label}>
        {list.map((v) => (
          <li key={v.id} role="option" aria-selected={v.id === value}>
            <button type="button" onClick={() => onChange(v.id)} className="car-tile" data-on={v.id === value ? "1" : "0"} style={{ "--accent": v.ui.accent } as React.CSSProperties}>
              <Silhouette kind={v.ui.silhouette} accent={v.ui.accent} className="car-tile-art" />
              <span className="car-tile-name">{v.name}</span>
              <span className="car-tile-meta">
                {v.ui.powerHp} hp · {v.ui.layout}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlayerCard({ title, cfg, ready, score, you, side }: { title: string; cfg: VehicleConfig; ready: boolean; score: number; you?: boolean; side: "left" | "right" }) {
  const dial = dialIn(cfg);
  return (
    <div className={`player-card player-card-${side}`} data-ready={ready ? "1" : "0"} style={{ "--accent": cfg.ui.accent } as React.CSSProperties}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-bold uppercase tracking-[0.18em] text-[var(--accent)]">{you ? `${title} · you` : title}</span>
        <span className="player-score">{score}</span>
      </div>
      <div className="player-art">
        {/* both cars point at the VS in the middle */}
        <Silhouette kind={cfg.ui.silhouette} accent={cfg.ui.accent} className={`h-20 w-full ${side === "left" ? "-scale-x-100" : ""}`} />
      </div>
      <p className="truncate text-lg font-bold text-white">{cfg.name}</p>
      <p className="text-xs text-zinc-500">
        {cfg.ui.make} · {cfg.ui.layout} · {cfg.ui.displacement}
      </p>
      <dl className="player-stats">
        <div>
          <dt>Power</dt>
          <dd>
            <span className="stat-bar" style={{ "--v": Math.min(1, cfg.ui.powerHp / 1500) } as React.CSSProperties} />
            {cfg.ui.powerHp} hp
          </dd>
        </div>
        <div>
          <dt>Perfect</dt>
          <dd>
            <span className="stat-bar" style={{ "--v": Math.min(1, Math.max(0.05, (16 - dial / 1000) / 9)) } as React.CSSProperties} />
            {fmt(dial)} s
          </dd>
        </div>
        <div>
          <dt>Class</dt>
          <dd className="!font-sans font-semibold">{classOf(cfg.id).name}</dd>
        </div>
      </dl>
      {ready && <span className="player-ready">Ready</span>}
    </div>
  );
}

function HeadsUpLine({ me, opp, oppName }: { me: VehicleConfig; opp: VehicleConfig; oppName: string }) {
  const c = classOf(me.id);
  if (classOf(opp.id).id !== c.id) return <p className="text-sm text-amber-200">Different classes</p>;
  const gap = Math.abs(dialIn(me) - dialIn(opp));
  return (
    <p className="text-sm text-zinc-400">
      Heads-up · <b className="text-zinc-200">{c.name}</b> class
      <br />
      Perfect runs within {Math.max(1, Math.round(gap))} ms of each other. First to the line beats {oppName}: reactions decide it.
    </p>
  );
}

/** A random car from the class other than `not` (or `not` itself in a one-car class). */
function rivalIn(c: DragClass, not: string): string {
  const others = c.cars.filter((id) => id !== not);
  return others.length ? others[Math.floor(Math.random() * others.length)] : not;
}

function ClassPicker({ value, onChange }: { value: string; onChange: (c: DragClass) => void }) {
  return (
    <div className="mb-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Class</p>
      <div className="class-chips mt-2" role="group" aria-label="Class">
        {CLASSES.map((c) => (
          <button key={c.id} type="button" aria-pressed={value === c.id} onClick={() => onChange(c)} className="class-chip" title={c.blurb}>
            <b>{c.name}</b>
            <span>{fmt(dialIn(getVehicle(c.cars[0])!), 2)} s · {c.cars.length}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">{CLASSES.find((c) => c.id === value)?.blurb}. Every car in a class runs the same perfect quarter mile (performance parity), so the driver decides it.</p>
    </div>
  );
}

function quality(ms: number) {
  if (ms < 0) return { label: "early", cls: "q-early" };
  if (ms < 150) return { label: "great", cls: "q-great" };
  if (ms < 250) return { label: "good", cls: "q-good" };
  return { label: "slow", cls: "q-slow" };
}

function TimeSlip({
  result,
  meName,
  oppName,
  myCfg,
  oppCfg,
  offsets,
}: {
  result: Result;
  meName: string;
  oppName: string;
  myCfg: VehicleConfig;
  oppCfg: VehicleConfig;
  offsets: [number, number];
}) {
  void offsets; // heads-up: both zero
  const { outcome, marginMs, mine, theirs } = result;
  const headline = mine.redLight
    ? "Red light! You jumped the start."
    : theirs?.redLight
      ? `${oppName} red-lit. You win.`
      : outcome === "win"
        ? `You win by ${fmt(marginMs)} s`
        : outcome === "lose"
          ? `${oppName} wins by ${fmt(marginMs)} s`
          : "Dead heat!";
  const t = theirs;
  const lostVsPerfect = (r: RunResult) => (r.redLight || r.dnf ? null : r.elapsedMs - dialIn(r === mine ? myCfg : oppCfg));
  type Row = [string, (r: RunResult) => number | null, (r: RunResult) => string, "low" | "high" | null];
  const rows: Row[] = [
    ["Perfect run", () => null, (r) => fmt(r === mine ? dialIn(myCfg) : dialIn(oppCfg)), null],
    ["Reaction", (r) => (r.redLight || r.reactionMs === null ? null : r.reactionMs), (r) => (r.reactionMs === null ? "–" : r.redLight ? `RED ${fmt(r.reactionMs)}` : fmt(r.reactionMs)), "low"],
    ["60 ft", () => null, (r) => fmt(r.sixtyFtMs), null],
    ["1/8 mile", () => null, (r) => fmt(r.eighthMs), null],
    ["1/4 mile ET", () => null, (r) => fmt(r.etMs), null],
    ["Trap speed", () => null, (r) => (r.trapKmh ? `${Math.round(r.trapKmh)} km/h` : "–"), null],
    // what decides a heads-up race in a class: time given away against the (shared) perfect run
    ["Lost vs perfect", (r) => lostVsPerfect(r), (r) => (lostVsPerfect(r) === null ? "–" : `+${fmt(lostVsPerfect(r)!)}`), "low"],
    ["Avg shift", (r) => (r.shiftReactionsMs.length ? r.shiftReactionsMs.reduce((a, b) => a + b, 0) / r.shiftReactionsMs.length : null), (r) => (r.shiftReactionsMs.length ? `${Math.round(r.shiftReactionsMs.reduce((a, b) => a + b, 0) / r.shiftReactionsMs.length)} ms` : "–"), "low"],
    ["Off the gas", (r) => r.offGasMs, (r) => (r.offGasMs > 0.5 ? `${fmt(r.offGasMs, 2)} s` : "–"), "low"],
  ];
  const better = (row: Row, r: RunResult, other: RunResult | null) => {
    if (!row[3] || !other) return false;
    const a = row[1](r);
    const b = row[1](other);
    if (a === null || !Number.isFinite(a)) return false;
    if (b === null || !Number.isFinite(b)) return true;
    return row[3] === "low" ? a < b : a > b;
  };
  return (
    <div className="slip-wrap">
      <p className={`slip-headline slip-headline-${outcome}`}>{headline}</p>
      <div className="slip" role="table" aria-label="Time slip">
        <div className="slip-head" role="row">
          <span role="columnheader">REVHEADZ RACEWAY · 1/4 MILE</span>
        </div>
        <div className="slip-row slip-lanes" role="row">
          <span role="columnheader" />
          <span role="columnheader">
            {meName}
            <small>{myCfg.name}</small>
            {outcome === "win" && <i className="slip-stamp">WIN</i>}
          </span>
          <span role="columnheader">
            {oppName}
            <small>{oppCfg.name}</small>
            {outcome === "lose" && <i className="slip-stamp">WIN</i>}
          </span>
        </div>
        {rows.map((row, i) => (
          <div key={row[0]} className="slip-row" role="row" style={{ animationDelay: `${250 + i * 70}ms` }}>
            <span role="rowheader">{row[0]}</span>
            <span role="cell" data-better={better(row, mine, t) ? "1" : "0"}>
              {row[2](mine)}
            </span>
            <span role="cell" data-better={t && better(row, t, mine) ? "1" : "0"}>
              {t ? row[2](t) : "–"}
            </span>
          </div>
        ))}
        {mine.shiftReactionsMs.length > 0 && (
          <div className="slip-shifts">
            {mine.shiftReactionsMs.map((ms, i) => {
              const q = quality(ms);
              return (
                <span key={i} className={q.cls}>
                  {i + 1}→{i + 2} {ms < 0 ? "early" : ms >= 900 ? "missed" : `${Math.round(ms)}ms`}
                </span>
              );
            })}
          </div>
        )}
        <div className="slip-foot">
          {classOf(myCfg.id).name} class · heads-up · margin {fmt(marginMs)} s
        </div>
      </div>
      {t && <Breakdown mine={mine} theirs={t} myCfg={myCfg} oppCfg={oppCfg} oppName={oppName} outcome={outcome} />}
    </div>
  );
}

/**
 * Why it went the way it did: the finish-line gap split exactly into reaction off the line,
 * shifting and throttle (everything else the driver gave away against a perfect run), and the
 * car (the tiny parity residual within a class). The three parts add up to the margin.
 */
function Breakdown({ mine, theirs, myCfg, oppCfg, oppName, outcome }: { mine: RunResult; theirs: RunResult; myCfg: VehicleConfig; oppCfg: VehicleConfig; oppName: string; outcome: Result["outcome"] }) {
  if (mine.redLight || theirs.redLight || mine.dnf || theirs.dnf) {
    const who = mine.redLight ? "You" : theirs.redLight ? oppName : mine.dnf ? "You" : oppName;
    const what = mine.redLight || theirs.redLight ? "left before the green: a red light loses, whatever happens after" : "never launched";
    return (
      <div className="breakdown">
        <p className="breakdown-verdict">
          {who} {what}.
        </p>
      </div>
    );
  }
  const reaction = mine.reactionMs! - theirs.reactionMs!;
  const myDrive = mine.elapsedMs - dialIn(myCfg) - mine.reactionMs!;
  const theirDrive = theirs.elapsedMs - dialIn(oppCfg) - theirs.reactionMs!;
  const driving = myDrive - theirDrive;
  const car = dialIn(myCfg) - dialIn(oppCfg);
  const parts: [string, number, string][] = [
    ["Reaction off the line", reaction, "the time from green to launch"],
    ["Shifts and throttle", driving, "late or early shifts, lifting, bogging"],
    ["Car", car, "parity keeps this to a few ms"],
  ];
  const scale = Math.max(30, ...parts.map((p) => Math.abs(p[1])));
  const decisive = [...parts].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  const won = outcome === "win";
  const verdict =
    outcome === "tie"
      ? "Dead heat: nothing between you."
      : `${won ? "You won it" : `${oppName} won it`} ${decisive[0] === "Reaction off the line" ? "off the line" : decisive[0] === "Shifts and throttle" ? "on the shifts" : "on the car"}: ${fmt(Math.abs(decisive[1]))} s ${decisive[1] < 0 ? "in your favour" : "against you"}.`;
  return (
    <div className="breakdown">
      <p className="breakdown-title">Why you {outcome === "win" ? "won" : outcome === "lose" ? "lost" : "tied"}</p>
      <ul>
        {parts.map(([label, ms, help], i) => {
          const good = ms < 0;
          const w = Math.min(50, (Math.abs(ms) / scale) * 50);
          return (
            <li key={label} style={{ animationDelay: `${900 + i * 120}ms` }}>
              <div className="breakdown-row">
                <span>{label}</span>
                <b className={Math.abs(ms) < 0.5 ? "" : good ? "text-lime-300" : "text-red-300"}>
                  {Math.abs(ms) < 0.5 ? "even" : `${good ? "−" : "+"}${fmt(Math.abs(ms))} s`}
                </b>
              </div>
              <div className="breakdown-bar" aria-hidden>
                <span data-good={good ? "1" : "0"} style={good ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }} />
              </div>
              <small>{help}</small>
            </li>
          );
        })}
      </ul>
      <p className="breakdown-verdict">{verdict}</p>
      <p className="breakdown-note">− is time you gained on {oppName}, + is time you gave away. They add up to the margin.</p>
    </div>
  );
}
