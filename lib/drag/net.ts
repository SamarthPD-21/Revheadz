"use client";

import type { DataConnection, Peer as PeerT } from "peerjs";
import type { DriveKey, DriveLog } from "./race";

/**
 * Two-player rooms over WebRTC (PeerJS). The host's peer id is derived from the room code,
 * so the guest only needs the code. Signalling goes through the public PeerJS broker (or your
 * own, see below); once connected, all traffic is browser to browser.
 *
 * Getting two browsers to talk takes ICE servers. STUN (Google's and Cloudflare's, free and
 * always up) finds each player's public address, which is enough on most home networks. When
 * both sit behind strict routers (mobile data, offices, some ISPs) the traffic has to go via a
 * TURN relay. PeerJS's own free relays have been shut down, and there's no free relay left that
 * works without an account, so set yours (Metered and Cloudflare both have free tiers) with:
 *
 *   NEXT_PUBLIC_TURN_URLS        comma-separated, e.g. turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp
 *   NEXT_PUBLIC_TURN_USERNAME
 *   NEXT_PUBLIC_TURN_CREDENTIAL
 *
 * and, to run your own PeerJS broker instead of the public one, NEXT_PUBLIC_PEER_HOST (plus
 * NEXT_PUBLIC_PEER_PORT and NEXT_PUBLIC_PEER_PATH if they aren't 443 and "/").
 *
 * Fairness doesn't depend on the network: each player's reaction is measured against their
 * own tree on their own clock, and results are recomputed by replaying both drive logs. The
 * clock sync below only lines up the two trees so the race looks simultaneous.
 */

const ID_PREFIX = "revheadz-drag-v2-";
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

export interface Player {
  name: string;
  carId: string;
  /** Simple controls (gas held for them). */
  assist: boolean;
}

export type Message =
  | { type: "hello"; player: Player }
  | { type: "ready"; ready: boolean }
  /** The sender moved to this class: races are within a class, so the other player follows. */
  | { type: "class"; classId: string }
  | { type: "ping"; t0: number }
  | { type: "pong"; t0: number; t1: number }
  /** Host -> guest: the tree starts at `atHost` on the host's clock. */
  | { type: "start"; race: number; atHost: number }
  /** A live input, ms since the sender's own green (the opponent's car is replayed from these). */
  | { type: "input"; race: number; ms: number; key: DriveKey }
  /** The sender's complete drive, once they've finished (or given up). */
  | { type: "log"; race: number; log: DriveLog }
  | { type: "leave" };

export function randomCode(): string {
  let c = "";
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

export const normaliseCode = (raw: string) =>
  raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);

export interface Room {
  code: string;
  isHost: boolean;
  send: (m: Message) => void;
  /** Host clock minus local clock, ms (0 on the host). */
  offset: () => number;
  close: () => void;
}

export interface RoomEvents {
  onOpen: (room: Room) => void;
  onMessage: (m: Message) => void;
  onClose: (reason: string) => void;
  onError: (message: string) => void;
}

/** How long to wait for the other browser before saying it isn't going to work, ms. */
const CONNECT_TIMEOUT_MS = 15000;

/** STUN that's always up, and a TURN relay if one is configured. */
export function iceServers(env: Record<string, string | undefined> = PUBLIC_ENV): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }, { urls: "stun:stun.cloudflare.com:3478" }];
  const turn = (env.NEXT_PUBLIC_TURN_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (turn.length) servers.push({ urls: turn, username: env.NEXT_PUBLIC_TURN_USERNAME, credential: env.NEXT_PUBLIC_TURN_CREDENTIAL });
  return servers;
}

// (spelled out so the bundler inlines them in a static build)
const PUBLIC_ENV = {
  NEXT_PUBLIC_TURN_URLS: process.env.NEXT_PUBLIC_TURN_URLS,
  NEXT_PUBLIC_TURN_USERNAME: process.env.NEXT_PUBLIC_TURN_USERNAME,
  NEXT_PUBLIC_TURN_CREDENTIAL: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
  NEXT_PUBLIC_PEER_HOST: process.env.NEXT_PUBLIC_PEER_HOST,
  NEXT_PUBLIC_PEER_PORT: process.env.NEXT_PUBLIC_PEER_PORT,
  NEXT_PUBLIC_PEER_PATH: process.env.NEXT_PUBLIC_PEER_PATH,
};

/** Whether a relay is set up (without one, players on strict networks can't always connect). */
export const hasRelay = () => iceServers().length > 2;

async function makePeer(id?: string): Promise<PeerT> {
  const { default: Peer } = await import("peerjs"); // browser-only: load on demand
  const host = PUBLIC_ENV.NEXT_PUBLIC_PEER_HOST;
  const options = {
    debug: 0,
    config: { iceServers: iceServers() },
    ...(host ? { host, port: Number(PUBLIC_ENV.NEXT_PUBLIC_PEER_PORT || 443), path: PUBLIC_ENV.NEXT_PUBLIC_PEER_PATH || "/", secure: true } : {}),
  };
  return id ? new Peer(id, options) : new Peer(options);
}

const CANT_REACH = "Couldn't connect to the other player: one of your networks blocks direct connections. Try another network (or Wi-Fi instead of mobile data).";

function friendly(err: unknown): string {
  const type = (err as { type?: string })?.type;
  if (type === "unavailable-id") return "That room code is taken. Try creating again.";
  if (type === "peer-unavailable") return "No room with that code. Check the code and that your friend's room is still open.";
  if (type === "network" || type === "server-error" || type === "socket-error") return "Couldn't reach the matchmaking server. Check your connection.";
  if (type === "browser-incompatible") return "This browser doesn't support peer-to-peer connections.";
  return (err as Error)?.message || "Connection failed.";
}

/**
 * Wires up a connection. `onFail` is what happens if it never opens: the guest gives up and
 * says why; the host just frees the room for another try.
 */
function wire(conn: DataConnection, peer: PeerT, code: string, isHost: boolean, ev: RoomEvents, onFail?: () => void) {
  let offset = 0;
  let bestRtt = Infinity;
  let closed = false;
  let opened = false;
  // no answer in time, or the browsers found no way through to each other: say so, rather than
  // leaving both players looking at "connecting…" for ever
  const fail = () => {
    if (opened || closed) return;
    closed = true;
    if (onFail) return onFail();
    ev.onError(CANT_REACH);
    peer.destroy();
  };
  const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
  conn.on("iceStateChanged", (state) => {
    if (state === "failed") fail();
  });
  const send = (m: Message) => {
    if (conn.open) conn.send(m);
  };
  const room: Room = {
    code,
    isHost,
    send,
    offset: () => offset,
    close: () => {
      if (closed) return;
      closed = true;
      send({ type: "leave" });
      setTimeout(() => peer.destroy(), 150);
    },
  };

  conn.on("open", () => {
    opened = true;
    clearTimeout(timer);
    ev.onOpen(room);
    // guest: estimate the host clock from the round trips with the smallest delay
    if (!isHost) {
      let n = 0;
      const ping = () => {
        if (closed || n++ >= 8) return;
        send({ type: "ping", t0: performance.now() });
        setTimeout(ping, 120);
      };
      ping();
    }
  });
  conn.on("data", (raw) => {
    const m = raw as Message;
    if (m.type === "ping") send({ type: "pong", t0: m.t0, t1: performance.now() });
    else if (m.type === "pong") {
      const now = performance.now();
      const rtt = now - m.t0;
      if (rtt < bestRtt) {
        bestRtt = rtt;
        offset = m.t1 - (m.t0 + rtt / 2);
      }
    } else if (m.type === "leave") {
      closed = true;
      ev.onClose("Your opponent left.");
    } else ev.onMessage(m);
  });
  conn.on("close", () => {
    if (!closed) {
      closed = true;
      ev.onClose("Connection lost.");
    }
  });
  conn.on("error", (e) => ev.onError(friendly(e)));
}

/** Opens a room and waits for one guest. Returns a cancel function. */
export async function hostRoom(code: string, ev: RoomEvents): Promise<() => void> {
  const peer = await makePeer(ID_PREFIX + code);
  let taken = false;
  peer.on("connection", (conn) => {
    if (taken) {
      conn.on("open", () => conn.close()); // room is full
      return;
    }
    taken = true;
    wire(conn, peer, code, true, ev, () => {
      // that guest couldn't get through: let the next attempt in
      taken = false;
      conn.close();
    });
  });
  peer.on("error", (e) => ev.onError(friendly(e)));
  return () => peer.destroy();
}

/** Joins a host's room by code. Returns a cancel function. */
export async function joinRoom(code: string, ev: RoomEvents): Promise<() => void> {
  const peer = await makePeer();
  // the matchmaking server itself not answering
  const noBroker = setTimeout(() => {
    ev.onError("Couldn't reach the matchmaking server. Check your connection.");
    peer.destroy();
  }, CONNECT_TIMEOUT_MS);
  peer.on("open", () => {
    clearTimeout(noBroker);
    const conn = peer.connect(ID_PREFIX + code, { reliable: true });
    wire(conn, peer, code, false, ev);
  });
  peer.on("error", (e) => {
    clearTimeout(noBroker);
    ev.onError(friendly(e));
  });
  return () => {
    clearTimeout(noBroker);
    peer.destroy();
  };
}
