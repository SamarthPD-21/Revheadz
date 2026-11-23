import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { finishBody } from "../components/cruise/carFinish";

const part = (name: string, color: number, size: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ name, color, roughness: 0.6, ...extra }));

const car = (...meshes: THREE.Mesh[]) => {
  const body = new THREE.Group();
  meshes.forEach((m) => body.add(m));
  return body;
};

describe("cruise: a downloaded car's paint and glass", () => {
  it("lacquers the paint named as such, even when something else covers more", () => {
    const paint = part("CarPaint2", 0xff3300, 1);
    const trim = part("Silver", 0xb0b0b0, 3);
    finishBody(car(paint, trim), new Set());
    const m = paint.material as THREE.MeshPhysicalMaterial;
    expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(m.clearcoat).toBe(1);
    expect(m.color.getHex()).toBe(0xff3300);
    expect(m.roughness).toBeLessThanOrEqual(0.45);
    expect(trim.material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it("with no paint named, lacquers the biggest coloured part, not a bigger black underbody", () => {
    const shell = part("Material.001", 0x881010, 2);
    const under = part("Black_Matt", 0x050505, 4);
    finishBody(car(shell, under), new Set());
    expect((shell.material as THREE.MeshPhysicalMaterial).clearcoat).toBe(1);
    expect(under.material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it("makes glass smooth and reflective", () => {
    const glass = part("WindowGlass", 0x222222, 1, { transparent: true, opacity: 0.4 });
    finishBody(car(glass), new Set());
    const m = glass.material as THREE.MeshStandardMaterial;
    expect(m.roughness).toBeLessThanOrEqual(0.05);
    expect(m.metalness).toBe(0);
  });

  it("leaves the game's own lamp materials alone and hands back what it swapped", () => {
    const lamp = part("head_lamp", 0xffffff, 5);
    const paint = part("body", 0x2244ff, 1);
    const old = paint.material;
    const { replaced, added } = finishBody(car(lamp, paint), new Set([lamp.material]));
    expect(lamp.material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(replaced).toEqual([old]);
    expect(added).toEqual([paint.material]);
  });
});
