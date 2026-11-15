"use client";

import { useEffect, type RefObject } from "react";

/** Phone turned this far, like a wheel, is full lock. */
const FULL_LOCK_DEG = 25;
/** Tilt under this is ignored, so holding the phone a little crooked doesn't drift the car. */
const DEAD_ZONE_DEG = 2.5;
const G = 9.81;

/**
 * Steering, -1 (left) to 1 (right), from a landscape phone turned like a steering wheel.
 * `gravityY` is accelerationIncludingGravity.y (m/s², along the phone's long side, towards its top);
 * `screenAngle` is the screen's rotation: 90 with the top of the phone on the left, 270 on the right.
 * Turning right lifts the left edge, so the top rises when it is on the left and drops when it is on the right.
 */
export function tiltToSteer(gravityY: number, screenAngle: number): number {
  const angle = ((screenAngle % 360) + 360) % 360;
  if (angle !== 90 && angle !== 270) return 0; // upright: no wheel to turn
  const sign = angle === 90 ? 1 : -1;
  const deg = (Math.asin(Math.max(-1, Math.min(1, gravityY / G))) * 180) / Math.PI;
  const past = Math.max(0, Math.abs(deg) - DEAD_ZONE_DEG) * Math.sign(deg);
  return Math.max(-1, Math.min(1, (sign * past) / (FULL_LOCK_DEG - DEAD_ZONE_DEG)));
}

type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

/** iOS only hands out motion after asking, from a tap. Elsewhere it is just there. */
export async function askTiltPermission(): Promise<boolean> {
  const ask = (globalThis.DeviceMotionEvent as unknown as MotionPermission | undefined)?.requestPermission;
  if (!ask) return typeof DeviceMotionEvent !== "undefined";
  try {
    return (await ask()) === "granted";
  } catch {
    return false;
  }
}

function screenAngle(): number {
  if (screen.orientation) return screen.orientation.angle;
  return Number((window as unknown as { orientation?: number }).orientation ?? 0);
}

/** While `on`, keeps `steerRef` at the latest tilt steering (smoothed a little) for the drive loop to read. */
export function useTiltSteer(on: boolean, steerRef: RefObject<number>): void {
  useEffect(() => {
    steerRef.current = 0;
    if (!on) return;
    const onMotion = (e: DeviceMotionEvent) => {
      const y = e.accelerationIncludingGravity?.y;
      if (y == null) return;
      steerRef.current += (tiltToSteer(y, screenAngle()) - steerRef.current) * 0.35;
    };
    // after a reload iOS wants asking again, and only from a tap
    const retry = () => void askTiltPermission();
    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("pointerdown", retry, { once: true });
    return () => {
      window.removeEventListener("devicemotion", onMotion);
      window.removeEventListener("pointerdown", retry);
      steerRef.current = 0;
    };
  }, [on, steerRef]);
}
