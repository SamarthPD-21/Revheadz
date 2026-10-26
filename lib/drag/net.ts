"use client";

import type { DataConnection, Peer as PeerT } from "peerjs";
import type { DriveKey, DriveLog } from "./race";

/**
 * Two-player rooms over WebRTC (PeerJS). The host's peer id is derived from the room code,
 * so the guest only needs the code. Signalling goes through the public PeerJS broker; once
 * connected, all traffic is browser to browser.
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

async function makePeer(id?: string): Promise<PeerT> {
  const { default: Peer } = await import("peerjs"); // browser-only: load on demand
  return id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
}

function friendly(err: unknown): string {
  const type = (err as { type?: string })?.type;
  if (type === "unavailable-id") return "That room code is taken. Try creating again.";
  if (type === "peer-unavailable") return "No room with that code. Check the code and that your friend's room is still open.";
  if (type === "network" || type === "server-error" || type === "socket-error") return "Couldn't reach the matchmaking server. Check your connection.";
  if (type === "browser-incompatible") return "This browser doesn't support peer-to-peer connections.";
  return (err as Error)?.message || "Connection failed.";
}

function wire(conn: DataConnection, peer: PeerT, code: string, isHost: boolean, ev: RoomEvents) {
  let offset = 0;
  let bestRtt = Infinity;
  let closed = false;
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
    wire(conn, peer, code, true, ev);
  });
  peer.on("error", (e) => ev.onError(friendly(e)));
  return () => peer.destroy();
}

/** Joins a host's room by code. Returns a cancel function. */
export async function joinRoom(code: string, ev: RoomEvents): Promise<() => void> {
  const peer = await makePeer();
  peer.on("open", () => {
    const conn = peer.connect(ID_PREFIX + code, { reliable: true });
    wire(conn, peer, code, false, ev);
  });
  peer.on("error", (e) => ev.onError(friendly(e)));
  return () => peer.destroy();
}
