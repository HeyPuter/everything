// Orbit camera with orthographic/perspective projection, zoom-to-cursor,
// rotation about a pivot and animated transitions between orientations.

import {
  type Mat4, type Quat, type Vec3, add, cross, dist, dot, fromRotationTranslation, invert4, mul4, normalize, ortho,
  perspective, qAxisAngle, qFromBasis, qMul, qNormalize, qRotate, qSlerp, scale, sub, transformPoint,
} from '../math/vec';

export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'isometric' | 'trimetric' | 'dimetric';

const Y: Vec3 = [0, 1, 0];

/** Orientation looking along -back with the given up vector. */
export function orientation(back: Vec3, up: Vec3 = Y): Quat {
  const b = normalize(back);
  let r = cross(up, b);
  if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = cross([0, 0, -1], b);
  r = normalize(r);
  const u = cross(b, r);
  return qFromBasis(r, u, b);
}

export const VIEWS: Record<ViewName, Quat> = {
  front: orientation([0, 0, 1]),
  back: orientation([0, 0, -1]),
  left: orientation([-1, 0, 0]),
  right: orientation([1, 0, 0]),
  top: orientation([0, 1, 0], [0, 0, -1]),
  bottom: orientation([0, -1, 0], [0, 0, 1]),
  isometric: orientation([1, 1, 1]),
  dimetric: orientation([0.5, 0.42, 1]),
  trimetric: orientation([0.62, 0.48, 1]),
};

export const VIEW_LABELS: Record<ViewName, string> = {
  front: 'Front', back: 'Back', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom',
  isometric: 'Isometric', trimetric: 'Trimetric', dimetric: 'Dimetric',
};

export interface CameraState {
  target: Vec3;
  distance: number;
  rot: Quat;
  ortho: boolean;
}

/**
 * Wheel zoom limits. A view framed beyond them (zoom to fit on a part of
 * several km) is not snapped back: it can still zoom in, just not further out.
 */
function clampDistance(d: number, from: number): number {
  return Math.min(Math.max(1e7, from), Math.max(Math.min(1e-3, from), d));
}

export class Camera {
  target: Vec3 = [0, 0, 0];
  distance = 200;
  rot: Quat = VIEWS.trimetric;
  private isOrtho = true;
  fov = (30 * Math.PI) / 180;
  width = 1;
  height = 1;
  /** Scene radius used for clip planes. */
  sceneRadius = 100;
  /** Bounding sphere of everything drawn (model and overlays such as sketches), kept up to date by the renderer. */
  sceneBounds: { center: Vec3; radius: number } | null = null;
  private anim: { from: CameraState; to: CameraState; t0: number; dur: number } | null = null;
  onChange: () => void = () => {};

  get ortho(): boolean { return this.isOrtho; }

  /** Switching the projection during a view animation also changes where it lands. */
  set ortho(v: boolean) {
    this.isOrtho = v;
    if (this.anim) { this.anim.from = { ...this.anim.from, ortho: v }; this.anim.to = { ...this.anim.to, ortho: v }; }
  }

  get right(): Vec3 { return qRotate(this.rot, [1, 0, 0]); }
  get up(): Vec3 { return qRotate(this.rot, [0, 1, 0]); }
  get back(): Vec3 { return qRotate(this.rot, [0, 0, 1]); }
  get eye(): Vec3 { return add(this.target, scale(this.back, this.distance)); }

  /** World units per pixel at the target distance. */
  get pixelSize(): number {
    return (2 * this.distance * Math.tan(this.fov / 2)) / Math.max(1, this.height);
  }

  state(): CameraState {
    return { target: [...this.target] as Vec3, distance: this.distance, rot: [...this.rot] as Quat, ortho: this.ortho };
  }

  /** Where the camera is heading: the end of a running animation, else now. */
  goal(): CameraState {
    const to = this.anim?.to;
    return to ? { target: [...to.target] as Vec3, distance: to.distance, rot: [...to.rot] as Quat, ortho: to.ortho } : this.state();
  }

  setState(s: CameraState) {
    this.target = [...s.target] as Vec3;
    this.distance = s.distance;
    this.rot = [...s.rot] as Quat;
    this.ortho = s.ortho;
    this.onChange();
  }

  view(): Mat4 {
    const world = fromRotationTranslation(this.rot, this.eye);
    return invert4(world)!;
  }

  proj(): Mat4 {
    const aspect = this.width / Math.max(1, this.height);
    // The clip range reaches 2r either side of the target; it must also take in
    // what is drawn away from the model, e.g. a large sketch with no body yet.
    const b = this.sceneBounds;
    const r = Math.max(this.sceneRadius, 1, b ? (dist(this.target, b.center) + b.radius) / 2 : 0);
    const far = this.distance + r * 4 + 10;
    if (this.ortho) {
      const h = this.distance * Math.tan(this.fov / 2);
      return ortho(-h * aspect, h * aspect, -h, h, -far, far);
    }
    const near = Math.max(this.distance - r * 2, this.distance * 0.01, 0.01);
    return perspective(this.fov, aspect, near, far);
  }

  viewProj(): Mat4 {
    return mul4(this.proj(), this.view());
  }

  /** World-space ray through a canvas pixel (CSS pixels). */
  ray(x: number, y: number): { o: Vec3; d: Vec3 } {
    const nx = (x / this.width) * 2 - 1;
    const ny = 1 - (y / this.height) * 2;
    const inv = invert4(this.viewProj())!;
    const a = transformPoint(inv, [nx, ny, -1]);
    const b = transformPoint(inv, [nx, ny, 1]);
    return { o: a, d: normalize(sub(b, a)) };
  }

  /** Projects a world point to canvas pixels; z is NDC depth. */
  project(p: Vec3, vp: Mat4 = this.viewProj()): [number, number, number] {
    const q = transformPoint(vp, p);
    return [((q[0] + 1) / 2) * this.width, ((1 - q[1]) / 2) * this.height, q[2]];
  }

  /** Rotates around the screen axes, keeping `pivot` fixed on screen. */
  orbit(dxPx: number, dyPx: number, pivot?: Vec3) {
    this.stopAnimation();
    const k = Math.PI / Math.max(300, Math.min(this.width, this.height));
    const qa = qAxisAngle(this.up, -dxPx * k);
    const qb = qAxisAngle(this.right, -dyPx * k);
    const q = qMul(qa, qb);
    this.rotateAbout(q, pivot ?? this.target);
  }

  /** Rolls around the view direction. */
  roll(angle: number) {
    // Like orbiting, the user takes over the orientation from an animation.
    this.stopAnimation();
    this.rotateAbout(qAxisAngle(this.back, angle), this.target);
  }

  rotateAbout(q: Quat, pivot: Vec3) {
    const rel = sub(this.target, pivot);
    this.target = add(pivot, qRotate(q, rel));
    this.rot = qNormalize(qMul(q, this.rot));
    this.onChange();
  }

  pan(dxPx: number, dyPx: number) {
    const s = this.pixelSize;
    const shift = add(scale(this.right, -dxPx * s), scale(this.up, dyPx * s));
    this.target = add(this.target, shift);
    this.shiftAnimation(shift, 1);
    this.onChange();
  }

  /** factor < 1 zooms in. Keeps the world point under (x, y) fixed. */
  zoomAt(factor: number, x: number, y: number) {
    const nd = clampDistance(this.distance * factor, this.distance);
    const f = nd / this.distance;
    // Offset of the cursor from the view centre, in world units on the target plane.
    const s = this.pixelSize;
    const ox = (x - this.width / 2) * s;
    const oy = (this.height / 2 - y) * s;
    const shift = add(scale(this.right, ox * (1 - f)), scale(this.up, oy * (1 - f)));
    this.target = add(this.target, shift);
    this.distance = nd;
    this.shiftAnimation(shift, f);
    this.onChange();
  }

  /**
   * Applies a pan or zoom made during a view animation to both of its ends,
   * so the animation keeps turning and still lands on its orientation (with
   * the pan or zoom applied) instead of freezing part-way.
   */
  private shiftAnimation(shift: Vec3, factor: number) {
    const a = this.anim;
    if (!a) return;
    const move = (s: CameraState): CameraState => ({ ...s, target: add(s.target, shift), distance: clampDistance(s.distance * factor, s.distance) });
    a.from = move(a.from);
    a.to = move(a.to);
  }

  /** Target state that frames a bounding sphere. */
  fitState(center: Vec3, radius: number, rot: Quat = this.rot): CameraState {
    const r = Math.max(radius, 1e-3);
    const aspect = this.width / Math.max(1, this.height);
    const half = Math.tan(this.fov / 2) * Math.min(1, aspect);
    const distance = (r * 1.1) / half;
    return { target: center, distance, rot, ortho: this.ortho };
  }

  animateTo(to: CameraState, dur = 280) {
    if (dur <= 0 || matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.anim = null;
      this.setState(to);
      return;
    }
    this.anim = { from: this.state(), to, t0: performance.now(), dur };
    this.onChange();
  }

  stopAnimation() {
    this.anim = null;
  }

  get animating(): boolean {
    return !!this.anim;
  }

  /** Advances an animation; returns true while still animating. */
  tick(now: number): boolean {
    const a = this.anim;
    if (!a) return false;
    let t = Math.min(1, (now - a.t0) / a.dur);
    t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.rot = qSlerp(a.from.rot, a.to.rot, t);
    this.target = [0, 1, 2].map((i) => a.from.target[i] + (a.to.target[i] - a.from.target[i]) * t) as Vec3;
    this.distance = a.from.distance * Math.pow(a.to.distance / a.from.distance, t);
    this.isOrtho = a.to.ortho;
    if (t >= 1) this.anim = null;
    return !!this.anim;
  }

  /** Name of the standard view matching the current orientation, if any. */
  viewName(): ViewName | null {
    for (const [k, q] of Object.entries(VIEWS) as [ViewName, Quat][]) {
      const d = Math.abs(q[0] * this.rot[0] + q[1] * this.rot[1] + q[2] * this.rot[2] + q[3] * this.rot[3]);
      if (d > 1 - 1e-6) return k;
    }
    return null;
  }

  /** Orientation looking straight at a plane with the given normal and x axis. */
  static normalTo(n: Vec3, x?: Vec3): Quat {
    const b = normalize(n);
    if (x) {
      const r = normalize(sub(x, scale(b, dot(x, b))));
      return qFromBasis(r, cross(b, r), b);
    }
    return orientation(b, Math.abs(b[1]) > 0.99 ? [0, 0, -Math.sign(b[1])] : Y);
  }
}
