import { describe, expect, it, vi } from "vitest";
import { InputManager } from "../lib/input/InputManager";
import type { SimInput } from "../lib/sim/types";

function setup() {
  const target = new EventTarget();
  const handlers = { ignition: vi.fn(), shiftUp: vi.fn(), shiftDown: vi.fn(), neutral: vi.fn() };
  const input = new InputManager(handlers);
  input.attach(target as unknown as Window);
  const out: SimInput = { throttle: 0, brake: 0 };
  const press = (type: "keydown" | "keyup", code: string, extra: object = {}) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { code, repeat: false, ...extra });
    target.dispatchEvent(e);
    return e;
  };
  return { input, handlers, out, press, target };
}

describe("InputManager", () => {
  it("holds throttle and brake only while keys are down", () => {
    const { input, out, press } = setup();
    press("keydown", "KeyW");
    input.apply(out);
    expect(out.throttle).toBe(1);
    press("keyup", "KeyW");
    input.apply(out);
    expect(out.throttle).toBe(0);
    press("keydown", "ArrowDown");
    input.apply(out);
    expect(out.brake).toBe(1);
    press("keyup", "ArrowDown");
    input.apply(out);
    expect(out.brake).toBe(0);
  });

  it("maps E/Q/N/I to commands and ignores key repeat", () => {
    const { handlers, press } = setup();
    press("keydown", "KeyE");
    press("keydown", "KeyE", { repeat: true });
    press("keydown", "KeyQ");
    press("keydown", "KeyN");
    press("keydown", "KeyI");
    expect(handlers.shiftUp).toHaveBeenCalledTimes(1);
    expect(handlers.shiftDown).toHaveBeenCalledTimes(1);
    expect(handlers.neutral).toHaveBeenCalledTimes(1);
    expect(handlers.ignition).toHaveBeenCalledTimes(1);
  });

  it("space blips the throttle briefly, then lets go", () => {
    const { input, out, press } = setup();
    press("keydown", "Space");
    input.apply(out, performance.now());
    expect(out.throttle).toBeGreaterThan(0.5);
    input.apply(out, performance.now() + 500);
    expect(out.throttle).toBe(0);
  });

  it("touch throttle maps position straight to 0-1 and clamps", () => {
    const { input, out } = setup();
    input.setTouchThrottle(0.5);
    input.apply(out);
    expect(out.throttle).toBe(0.5);
    input.setTouchThrottle(7);
    input.apply(out);
    expect(out.throttle).toBe(1);
    input.setTouchThrottle(-1);
    input.apply(out);
    expect(out.throttle).toBe(0);
  });

  it("clears everything on window blur and detach", () => {
    const { input, out, press, target } = setup();
    press("keydown", "KeyW");
    target.dispatchEvent(new Event("blur"));
    input.apply(out);
    expect(out.throttle).toBe(0);
    input.detach(target as unknown as Window);
    const e = press("keydown", "KeyW");
    input.apply(out);
    expect(out.throttle).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("does not hijack browser shortcuts", () => {
    const { handlers, press } = setup();
    const e = press("keydown", "KeyI", { ctrlKey: true });
    expect(handlers.ignition).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
