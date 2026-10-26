"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "../../lib/analytics";
import { AudioEngine } from "../../lib/audio/AudioEngine";
import { decodeChallenge, shareRun, verifyChallenge, type VerifiedChallenge } from "../../lib/drag/challenge";
import { CPU_LEVELS } from "../../lib/drag/cpu";
import { hostRoom, joinRoom, normaliseCode, randomCode, type Message, type Player, type Room } from "../../lib/drag/net";
import { CLASSES, classOf, type DragClass } from "../../lib/drag/classes";
import { decide, dialIn, type DriveKey, type DriveLog, type RunResult } from "../../lib/drag/race";
import { Simulation } from "../../lib/sim/Simulation";
import { getVehicle } from "../../lib/vehicles";
import type { VehicleConfig } from "../../lib/vehicles/types";
import { Logo } from "../Logo";
import { Silhouette } from "../Silhouette";
import { RaceView, type Opponent, type RaceOutcome } from "./RaceView";
import { Sfx } from "./sfx";

/** cpu: against the computer; online: a friend in a room; ghost: a friend's shared run. */
type Mode = "cpu" | "online" | "ghost";
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
  const [challenge, setChallenge] = useState<VerifiedChallenge | null>(null);
  // my last finished run, so it can be shared as a challenge
  const [lastRun, setLastRun] = useState<{ log: DriveLog; carId: string } | null>(null);
  const [shared, setShared] = useState(false);

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
  const oppCfg =
    mode === "cpu" ? getVehicle(cpuCar)! : mode === "ghost" ? (challenge ? getVehicle(challenge.carId)! : null) : opponent ? getVehicle(opponent.carId) ?? null : null;
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
    // a #c= link is a friend's run to beat: straight to the lobby, in their class
    const code = new URLSearchParams(window.location.hash.slice(1)).get("c");
    if (code) {
      const c = decodeChallenge(code);
      if (typeof c === "string") {
        setError(
          c === "version"
            ? "That challenge was recorded on an older version of the physics, so it can't be replayed exactly. Ask for a fresh link."
            : c === "car"
              ? "That challenge is for a car that isn't in the garage any more."
              : "That challenge link is broken. Ask your friend to share it again.",
        );
      } else {
        const v = verifyChallenge(c);
        setChallenge(v);
        setMode("ghost");
        setCarId(carIdFromStore(store.get("revheadz:drag-car"), c.carId));
        setPhase("lobby");
        trackEvent("drag_challenge_open", { car: c.carId });
      }
    }
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
    store.set(`revheadz:drag-car:${classOf(me.carId).id}`, me.carId);
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
    setMode("cpu");
    setChallenge(null);
    if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
    if (msg) setError(msg);
  };

  // move to a class: the car I last drove in it, else its first car; not ready any more
  const enterClass = (c: DragClass) => {
    const stored = store.get(`revheadz:drag-car:${c.id}`);
    setCarId(stored && c.cars.includes(stored) ? stored : c.cars[0]);
    setMeReady(false);
    send({ type: "ready", ready: false });
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

  const latest = useRef({ beginRace, meReady, oppReady, phase, opponent, myClass, enterClass });
  useEffect(() => {
    latest.current = { beginRace, meReady, oppReady, phase, opponent, myClass, enterClass };
  });

  const onMessage = (m: Message) => {
    const l = latest.current;
    if (m.type === "hello") {
      // joining a room: the guest starts in the host's class, so the two of you can race straight away
      const theirs = getVehicle(m.player.carId) ? classOf(m.player.carId) : null;
      if (!l.opponent && roomRef.current && !roomRef.current.isHost && theirs && theirs.id !== l.myClass.id) l.enterClass(theirs);
      setOpponent(m.player);
    } else if (m.type === "class") {
      // they changed class: follow them into it
      const c = CLASSES.find((k) => k.id === m.classId);
      if (c && c.id !== l.myClass.id) l.enterClass(c);
    } else if (m.type === "ready") setOppReady(m.ready);
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
    if (mode === "cpu" || mode === "ghost") {
      raceCounter.current += 1;
      beginRace(performance.now() + LEAD_MS, raceCounter.current, oppCfg!);
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
    setLastRun({ log: o.myLog, carId });
    setShared(false);
    setPhase("results");
    trackEvent("drag_race", { mode, outcome, reaction: Math.round(o.myResult.reactionMs ?? -1) });
  };

  const opponentView: Opponent =
    mode === "cpu"
      ? { kind: "cpu", skill: CPU_LEVELS[cpuLevel] }
      : mode === "ghost" && challenge
        ? { kind: "remote", events: { current: challenge.log.events }, log: { current: challenge.log } }
        : { kind: "remote", events: remoteEvents, log: remoteLog };
  const oppName = mode === "cpu" ? `CPU (${cpuLevel})` : mode === "ghost" ? `${challenge?.name ?? "Ghost"}'s run` : opponent?.name ?? "Opponent";
  const shareMyRun = async () => {
    if (!lastRun) return;
    const { url, text } = shareRun(window.location.origin, me.name, lastRun.carId, lastRun.log);
    trackEvent("drag_challenge_share", { car: lastRun.carId });
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) await navigator.share({ title: "Revheadz drag challenge", text, url });
      else await navigator.clipboard.writeText(`${text} ${url}`);
      setShared(true);
    } catch {
      /* cancelled */
    }
  };
  const canShare = phase === "results" && lastRun && result && !result.mine.redLight && !result.mine.dnf;
  const shareUrl = typeof window !== "undefined" && code ? `${window.location.origin}/drag?room=${code}` : "";

  if (phase === "race" && race && oppCfg && raceAudio) {
    return (
      <RaceView
        key={race.id}
        me={{ name: me.name, cfg: myCfg, offsetMs: race.myOffset, assist }}
        opp={{ name: oppName, cfg: oppCfg, offsetMs: race.oppOffset, assist: mode === "cpu" ? true : mode === "ghost" ? (challenge?.log.assist ?? false) : (opponent?.assist ?? false) }}
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

        <header className="mt-10">
          <h1 className="display text-5xl text-zinc-50 sm:text-6xl">Drag racing</h1>
          <p className="mt-3 max-w-xl text-zinc-400">
            A quarter mile, heads-up: both lights go green together and the first car to the line wins. Every car in a class runs the same
            perfect time, so it comes down to your launch and your shifts. Leave before the green and you lose.
          </p>
        </header>

        {error && (
          <p role="alert" className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}

        {phase === "menu" && (
          <section className="menu">
            <label className="field">
              <span>Your name</span>
              <input className="drag-input" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="menu-actions">
              <button type="button" className="menu-option menu-option-primary" onClick={practice}>
                <b>Race the CPU</b>
                <span>Pick a class, pick a car, go.</span>
              </button>
              <button type="button" className="menu-option" onClick={() => void create()}>
                <b>Create a room</b>
                <span>You get a four-letter code to send a friend.</span>
              </button>
              <div className="menu-option menu-join">
                <label htmlFor="drag-code">
                  <b>Join a room</b>
                  <span>Enter your friend&apos;s code.</span>
                </label>
                <div className="menu-join-row">
                  <input
                    id="drag-code"
                    className="drag-input font-mono uppercase tracking-[0.3em]"
                    placeholder="ABCD"
                    value={joinCode}
                    onChange={(e) => setJoinCode(normaliseCode(e.target.value))}
                    onKeyDown={(e) => e.key === "Enter" && void join()}
                  />
                  <button type="button" className="btn" onClick={() => void join()} disabled={joinCode.length !== 4}>
                    Join
                  </button>
                </div>
              </div>
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
            <ClassBar
              value={myClass.id}
              locked={mode === "ghost"}
              onChange={(c) => {
                // in a room the class is shared: tapping one moves you both (and re-syncs a mismatch)
                if (mode === "online") send({ type: "class", classId: c.id });
                if (c.id === myClass.id) return;
                enterClass(c);
              }}
            />
            <div className="bays">
              <CarBay
                side="left"
                label={`${me.name} (you)`}
                cfg={myCfg}
                cars={myClass.cars}
                score={score.me}
                ready={mode === "online" && meReady}
                onChange={(id) => {
                  setCarId(id);
                  setMeReady(false);
                  send({ type: "ready", ready: false });
                }}
              />
              <div className="bays-vs" aria-hidden>
                vs
              </div>
              {oppCfg ? (
                <CarBay
                  side="right"
                  label={oppName}
                  cfg={oppCfg}
                  cars={myClass.cars}
                  score={score.them}
                  ready={mode === "online" && oppReady}
                  onChange={mode === "cpu" ? setCpuCarId : undefined}
                  footer={
                    mode === "ghost" && challenge ? (
                      <GhostNote challenge={challenge} />
                    ) : mode === "cpu" ? (
                      <CpuControls
                        level={cpuLevel}
                        onLevel={setCpuLevel}
                        onRandom={() => setCpuCarId(rivalIn(myClass, cpuCar === carId ? "" : cpuCar))}
                      />
                    ) : null
                  }
                />
              ) : (
                <div className="bay bay-empty">Waiting for your opponent to join…</div>
              )}
            </div>
            {oppCfg && <HeadsUpLine me={myCfg} opp={oppCfg} oppName={oppName} />}
            {classMismatch && opponent && (
              <p role="alert" className="notice">
                {opponent.name} is in {classOf(opponent.carId).name}, you&apos;re in {myClass.name}. Races are within a class: tap a class above and you&apos;ll both move to it.
              </p>
            )}
            <button type="button" className={`drag-cta drag-cta-big w-full ${meReady ? "drag-cta-ghost" : ""}`} onClick={ready} disabled={mode === "online" && (!oppCfg || classMismatch)}>
              <b>
                {mode === "ghost"
                  ? phase === "results"
                    ? "Try again"
                    : `Race ${challenge?.name ?? "their"}'s run`
                  : mode === "cpu"
                    ? phase === "results"
                      ? "Race again"
                      : "Go to the line"
                    : meReady
                      ? "Ready. Waiting for them"
                      : phase === "results"
                        ? "Rematch"
                        : "Ready"}
              </b>
              <span>{mode === "online" ? `Room ${code}. The tree starts when you're both ready.` : "Engines start here, so check your volume."}</span>
            </button>
            {canShare && (
              <button type="button" className="btn w-full" onClick={() => void shareMyRun()}>
                {shared ? "Link copied. Send it to a friend" : "Challenge a friend to beat this run"}
              </button>
            )}
            <ControlsPanel
              assist={assist}
              onChange={(a) => {
                setAssist(a);
                setMeReady(false);
                send({ type: "ready", ready: false });
              }}
            />
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

/** One side of the start line: the car, its numbers, and (if you can change it) arrows and the class's cars. */
function CarBay({
  side,
  label,
  cfg,
  cars,
  score,
  ready,
  onChange,
  footer,
}: {
  side: "left" | "right";
  label: string;
  cfg: VehicleConfig;
  cars: string[];
  score: number;
  ready: boolean;
  onChange?: (id: string) => void;
  footer?: React.ReactNode;
}) {
  const i = Math.max(0, cars.indexOf(cfg.id));
  const step = (d: number) => onChange?.(cars[(i + d + cars.length) % cars.length]);
  return (
    <section className="bay" data-ready={ready ? "1" : "0"} style={{ "--accent": cfg.ui.accent } as React.CSSProperties} aria-label={label}>
      <header className="bay-head">
        <span>{label}</span>
        <span className="bay-score" aria-label={`${score} wins`}>
          {score}
        </span>
      </header>
      <div className="bay-stage">
        {onChange && cars.length > 1 && (
          <button type="button" className="bay-arrow" onClick={() => step(-1)} aria-label="Previous car">
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
        )}
        {/* both cars point at the middle */}
        <Silhouette kind={cfg.ui.silhouette} accent={cfg.ui.accent} className={`bay-art ${side === "left" ? "-scale-x-100" : ""}`} />
        {onChange && cars.length > 1 && (
          <button type="button" className="bay-arrow" onClick={() => step(1)} aria-label="Next car">
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M6 3l5 5-5 5" />
            </svg>
          </button>
        )}
      </div>
      <h3 className="bay-name">{cfg.name}</h3>
      <p className="bay-sub">
        {cfg.ui.make} {cfg.ui.year ? `· ${cfg.ui.year}` : ""}
        {ready && <span className="bay-ready">Ready</span>}
      </p>
      <dl className="bay-specs">
        <div>
          <dt>Engine</dt>
          <dd>{cfg.ui.layout}</dd>
        </div>
        <div>
          <dt>Power</dt>
          <dd>{cfg.ui.powerHp} hp</dd>
        </div>
        <div>
          <dt>Perfect 1/4</dt>
          <dd>{fmt(dialIn(cfg))} s</dd>
        </div>
      </dl>
      {onChange && cars.length > 1 && (
        <ul className="bay-rail" aria-label="Cars in this class">
          {cars.map((id) => {
            const v = getVehicle(id)!;
            return (
              <li key={id}>
                <button type="button" aria-pressed={id === cfg.id} onClick={() => onChange(id)} title={v.name} style={{ "--accent": v.ui.accent } as React.CSSProperties}>
                  <Silhouette kind={v.ui.silhouette} accent={v.ui.accent} className={`h-6 w-14 ${side === "left" ? "-scale-x-100" : ""}`} />
                  <span>{v.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {footer}
    </section>
  );
}

const SKILL_NOTE: Record<CpuLevel, string> = {
  easy: "reacts in about 0.26 s, shifts late",
  club: "reacts in about 0.19 s",
  pro: "reacts in about 0.13 s, rarely misses a shift",
};

function CpuControls({ level, onLevel, onRandom }: { level: CpuLevel; onLevel: (l: CpuLevel) => void; onRandom: () => void }) {
  return (
    <div className="bay-cpu">
      <div className="segmented" role="group" aria-label="CPU skill">
        {(Object.keys(CPU_LEVELS) as CpuLevel[]).map((l) => (
          <button key={l} type="button" aria-pressed={level === l} onClick={() => onLevel(l)} className="capitalize">
            {l}
          </button>
        ))}
      </div>
      <button type="button" className="btn-quiet" onClick={onRandom}>
        Random car
      </button>
      <p className="bay-note">The CPU {SKILL_NOTE[level]}.</p>
    </div>
  );
}

function ClassBar({ value, onChange, locked }: { value: string; onChange: (c: DragClass) => void; locked?: boolean }) {
  const current = CLASSES.find((c) => c.id === value)!;
  return (
    <div className="classbar">
      <div className="classbar-tabs" role="tablist" aria-label="Class">
        {CLASSES.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={value === c.id} onClick={() => onChange(c)} disabled={locked && value !== c.id}>
            {c.name}
            <small>{fmt(dialIn(getVehicle(c.cars[0])!), 2)}</small>
          </button>
        ))}
      </div>
      <p className="classbar-note">
        {current.blurb}. Every car in a class runs the same perfect quarter mile, so the race comes down to the driver.
      </p>
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

/** The stored car if it's in the challenge's class, otherwise the challenger's own car. */
function carIdFromStore(stored: string | null, challengeCar: string): string {
  return stored && getVehicle(stored) && classOf(stored).id === classOf(challengeCar).id ? stored : challengeCar;
}

function GhostNote({ challenge }: { challenge: VerifiedChallenge }) {
  const r = challenge.result;
  return (
    <div className="bay-cpu">
      <p className="bay-note">
        {r.redLight
          ? "Their run was a red light: just don't jump the green."
          : `Their run: ${fmt(r.elapsedMs)} s at ${Math.round(r.trapKmh)} km/h, reaction ${fmt(r.reactionMs)}. You race their exact inputs, replayed.`}
      </p>
    </div>
  );
}
