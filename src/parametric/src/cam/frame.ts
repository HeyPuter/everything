// The machine frame of a setup: the part as it sits on the machine, with Z
// toward the spindle, and the work origin on the stock. The CAM engine works
// in work coordinates (millimetres from the work origin); toolpaths are drawn
// in the model by mapping them back.

import type { Vec3 } from '../math/vec';
import type { CamAxis, CamSetup } from '../model/cam';

export interface Box3 { min: Vec3; max: Vec3 }

export interface MachineFrame {
  /** Model directions of the machine's X, Y and Z axes. */
  x: Vec3;
  y: Vec3;
  z: Vec3;
  /** Work origin in model coordinates. */
  origin: Vec3;
  /** The stock in work coordinates. */
  stock: Box3;
  /** The part's bounding box in work coordinates. */
  part: Box3;
}

const AXIS: Record<CamAxis, { z: Vec3; x: Vec3 }> = {
  // X runs left to right as the part is seen from the spindle (as in the
  // model's standard view from that side), so Y = Z × X points away from the operator.
  '+Y': { z: [0, 1, 0], x: [1, 0, 0] },
  '-Y': { z: [0, -1, 0], x: [1, 0, 0] },
  '+Z': { z: [0, 0, 1], x: [1, 0, 0] },
  '-Z': { z: [0, 0, -1], x: [-1, 0, 0] },
  '+X': { z: [1, 0, 0], x: [0, 0, -1] },
  '-X': { z: [-1, 0, 0], x: [0, 0, 1] },
};

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Machine axes of a setup (before the work origin is placed). */
export function setupAxes(axis: CamAxis, rotation: number): { x: Vec3; y: Vec3; z: Vec3 } {
  const a = AXIS[axis];
  const z = a.z;
  const x0 = a.x;
  const y0 = cross(z, x0);
  const t = (rotation * Math.PI) / 180;
  const c = Math.round(Math.cos(t) * 1e12) / 1e12, s = Math.round(Math.sin(t) * 1e12) / 1e12;
  const x: Vec3 = [c * x0[0] + s * y0[0], c * x0[1] + s * y0[1], c * x0[2] + s * y0[2]];
  return { x, y: cross(z, x), z };
}

/** Bounding box of triangles (9 numbers each) seen along the given axes. */
export function boxAlong(tris: ArrayLike<number>, axes: { x: Vec3; y: Vec3; z: Vec3 }): Box3 | null {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const p: Vec3 = [tris[i], tris[i + 1], tris[i + 2]];
    const q = [dot(p, axes.x), dot(p, axes.y), dot(p, axes.z)];
    for (let k = 0; k < 3; k++) { if (q[k] < min[k]) min[k] = q[k]; if (q[k] > max[k]) max[k] = q[k]; }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** The machine frame of a setup for a part with these triangles (model coordinates). */
export function machineFrame(setup: Pick<CamSetup, 'axis' | 'rotation' | 'origin' | 'stock'>, tris: ArrayLike<number>): MachineFrame | null {
  const axes = setupAxes(setup.axis, setup.rotation);
  const b = boxAlong(tris, axes);
  if (!b) return null;
  const st = setup.stock;
  let smin: Vec3, smax: Vec3;
  if (st.mode === 'fixed') {
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
    const [w, d, hgt] = st.size.map((v, k) => Math.max(v, b.max[k] - b.min[k])) as Vec3;
    const top = b.max[2] + st.top;
    smin = [cx - w / 2, cy - d / 2, Math.min(top - hgt, b.min[2])];
    smax = [cx + w / 2, cy + d / 2, top];
  } else {
    smin = [b.min[0] - st.side, b.min[1] - st.side, b.min[2] - st.bottom];
    smax = [b.max[0] + st.side, b.max[1] + st.side, b.max[2] + st.top];
  }
  let o: Vec3;
  switch (setup.origin) {
    case 'topCenter': o = [(smin[0] + smax[0]) / 2, (smin[1] + smax[1]) / 2, smax[2]]; break;
    case 'topFrontLeft': o = [smin[0], smin[1], smax[2]]; break;
    case 'topBackLeft': o = [smin[0], smax[1], smax[2]]; break;
    case 'bottomFrontLeft': o = [smin[0], smin[1], smin[2]]; break;
    default: o = [0, 0, 0];
  }
  const origin: Vec3 = [
    axes.x[0] * o[0] + axes.y[0] * o[1] + axes.z[0] * o[2],
    axes.x[1] * o[0] + axes.y[1] * o[1] + axes.z[1] * o[2],
    axes.x[2] * o[0] + axes.y[2] * o[1] + axes.z[2] * o[2],
  ];
  const sub = (p: Vec3): Vec3 => [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  return { ...axes, origin, stock: { min: sub(smin), max: sub(smax) }, part: { min: sub(b.min), max: sub(b.max) } };
}

/** Triangles in work coordinates (a new array). */
export function toWork(tris: ArrayLike<number>, f: MachineFrame): Float64Array {
  const out = new Float64Array(tris.length);
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const px = tris[i] - f.origin[0], py = tris[i + 1] - f.origin[1], pz = tris[i + 2] - f.origin[2];
    out[i] = px * f.x[0] + py * f.x[1] + pz * f.x[2];
    out[i + 1] = px * f.y[0] + py * f.y[1] + pz * f.y[2];
    out[i + 2] = px * f.z[0] + py * f.z[1] + pz * f.z[2];
  }
  return out;
}

/** A point in work coordinates to model coordinates. */
export function toModel(f: MachineFrame, x: number, y: number, z: number): Vec3 {
  return [
    f.origin[0] + f.x[0] * x + f.y[0] * y + f.z[0] * z,
    f.origin[1] + f.x[1] * x + f.y[1] * y + f.z[1] * z,
    f.origin[2] + f.x[2] * x + f.y[2] * y + f.z[2] * z,
  ];
}

/** A model direction in work coordinates. */
export function dirToWork(f: MachineFrame, d: Vec3): Vec3 {
  return [dot(d, f.x), dot(d, f.y), dot(d, f.z)];
}

export function pointToWork(f: MachineFrame, p: Vec3): Vec3 {
  const q: Vec3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
  return [dot(q, f.x), dot(q, f.y), dot(q, f.z)];
}
