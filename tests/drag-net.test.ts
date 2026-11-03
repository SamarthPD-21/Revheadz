import { describe, expect, it } from "vitest";
import { iceServers, normaliseCode } from "../lib/drag/net";

describe("drag rooms: connecting", () => {
  it("uses working STUN servers, and none of the shut-down PeerJS relays", () => {
    const servers = iceServers({});
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    expect(urls.some((u) => u.startsWith("stun:"))).toBe(true);
    expect(urls.some((u) => u.includes("peerjs.com"))).toBe(false);
    expect(urls.some((u) => u.startsWith("turn"))).toBe(false);
  });

  it("adds a TURN relay when one is configured", () => {
    const servers = iceServers({
      NEXT_PUBLIC_TURN_URLS: "turn:relay.example.com:80, turns:relay.example.com:443?transport=tcp",
      NEXT_PUBLIC_TURN_USERNAME: "user",
      NEXT_PUBLIC_TURN_CREDENTIAL: "secret",
    });
    const relay = servers.find((s) => [s.urls].flat().some((u) => u.startsWith("turn")));
    expect(relay).toEqual({ urls: ["turn:relay.example.com:80", "turns:relay.example.com:443?transport=tcp"], username: "user", credential: "secret" });
  });

  it("reads room codes the way people type them", () => {
    expect(normaliseCode(" ab-c d ")).toBe("ABCD");
    expect(normaliseCode("wxyz9")).toBe("WXYZ");
  });
});
