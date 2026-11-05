import { rightOf, type Road, type RoadPoint } from "./road";

/** How far behind the furthest point reached the world is kept, m (room to turn round in). */
export const KEEP_BEHIND = 320;

/**
 * The road only goes one way. This keeps the furthest point along it the car has reached, and
 * closes everything a little way behind that: the world there is taken away and an invisible
 * line stands across it, which the car can't pass. The closed line is the road's cross-section at
 * the boundary, extended either side; since a winding road can curl back past that line, ground
 * by road still ahead is never counted as behind.
 */
export class Progress {
  /** Furthest distance along the road reached, m. */
  reached: number;
  private readonly pt: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, grade: 0 };
  /** The closed line: a point on it, and the way ahead (unit vector). */
  readonly line = { x: 0, z: 0, ax: 1, az: 0 };

  constructor(private readonly road: Road, start: number) {
    this.reached = start;
    this.place();
  }

  /** Where along the road the world is closed, m. */
  get boundary(): number {
    return Math.max(0, this.reached - KEEP_BEHIND);
  }

  /** The car is at `s` along the road: carry the boundary forward if it's further than ever. */
  advance(s: number): boolean {
    if (!Number.isFinite(s) || s <= this.reached) return false;
    this.reached = s;
    this.place();
    return true;
  }

  private place() {
    const p = this.road.at(this.boundary, this.pt);
    this.line.x = p.x;
    this.line.z = p.z;
    this.line.ax = Math.cos(p.heading);
    this.line.az = Math.sin(p.heading);
  }

  /** How far ahead of the closed line a point is, m (negative: behind it). */
  ahead(x: number, z: number): number {
    return (x - this.line.x) * this.line.ax + (z - this.line.z) * this.line.az;
  }

  /**
   * Is a point in the closed part of the world? `nearS` is how far along the road its nearest
   * road is, if there's road near it (NaN if not): by road that's still ahead, it never is.
   */
  isBehind(x: number, z: number, nearS = NaN, margin = 0): boolean {
    if (Number.isFinite(nearS) && nearS >= this.boundary - margin) return false;
    return this.ahead(x, z) < -margin;
  }

  /** The road's direction at `s` (unit vector), for telling which way the car is going along it. */
  directionAt(s: number): [number, number] {
    const p = this.road.at(Math.max(0, s), this.pt);
    return [Math.cos(p.heading), Math.sin(p.heading)];
  }

  /** The road's sideways direction at the closed line. */
  get across(): [number, number] {
    return rightOf(Math.atan2(this.line.az, this.line.ax));
  }
}

/**
 * Notices a car going the wrong way along the road: travelling against it, at more than a
 * crawl, for a second or so (a reverse into a parking spot or a spin doesn't count).
 */
export class WrongWay {
  private timer = 0;
  /** True while the car has been heading back down the road long enough to say so. */
  active = false;

  update(dt: number, travelX: number, travelZ: number, speed: number, roadX: number, roadZ: number): boolean {
    const along = speed > 0.1 ? (travelX * roadX + travelZ * roadZ) / Math.max(1e-6, Math.hypot(travelX, travelZ)) : 0;
    const back = speed > 3 && along < -0.45;
    this.timer = back ? Math.min(3, this.timer + dt) : Math.max(0, this.timer - dt * 2);
    this.active = this.active ? this.timer > 0.3 : this.timer > 1.1;
    return this.active;
  }
}
