// Wire shapes for non-geometry objects (cameras, lights, empties, bones, lattices).
import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { CameraData, LightData, ObjectData, ArmatureData, LatticeData } from '../data/types';
import { lightWireShape } from '../editors/view3d/lightshapes';

type Seg = number[]; // flat xyz pairs

function circle(out: Seg, r: number, n = 32, plane: 'xy' | 'xz' | 'yz' = 'xy', cx = 0, cy = 0, cz = 0, dashed = false) {
  for (let i = 0; i < n; i++) {
    if (dashed && i % 2) continue;
    const a0 = (i / n) * Math.PI * 2,
      a1 = ((i + 1) / n) * Math.PI * 2;
    const p = (a: number) => {
      const c = Math.cos(a) * r,
        s = Math.sin(a) * r;
      return plane === 'xy' ? [cx + c, cy + s, cz] : plane === 'xz' ? [cx + c, cy, cz + s] : [cx, cy + c, cz + s];
    };
    out.push(...p(a0), ...p(a1));
  }
}

function line(out: Seg, a: number[], b: number[]) {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function dashedLine(out: Seg, a: number[], b: number[], dash = 0.12) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.floor(d / dash));
  for (let i = 0; i < n; i += 2) {
    const t0 = i / n,
      t1 = Math.min(1, (i + 1) / n);
    line(out, [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2] + (b[2] - a[2]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2] + (b[2] - a[2]) * t1]);
  }
}

export function geom(seg: Seg) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(seg, 3));
  return g;
}

/** A small cross across the camera axis at distance `d` (limits / mist markers). */
function axisCross(out: Seg, d: number, r: number) {
  line(out, [-r, 0, -d], [r, 0, -d]);
  line(out, [0, -r, -d], [0, r, -d]);
}

/** Camera frustum in camera local space (looks down -Z), with the clipping limits and mist range when shown. */
export function cameraWire(ca: CameraData, aspect: number, mist?: { start: number; depth: number } | null): Seg {
  const out: Seg = [];
  const s = ca.display_size;
  let w: number, h: number, d: number;
  if (ca.type === 'ORTHO') {
    w = ca.ortho_scale / 2;
    h = w / aspect;
    d = s;
    if (aspect < 1) {
      h = ca.ortho_scale / 2;
      w = h * aspect;
    }
  } else {
    const fit = ca.sensor_fit === 'VERTICAL' || (ca.sensor_fit === 'AUTO' && aspect < 1);
    const sensor = ca.sensor_fit === 'VERTICAL' ? ca.sensor_height : ca.sensor_width;
    d = s;
    const half = (sensor / 2 / ca.lens) * d;
    if (fit) {
      h = half;
      w = h * aspect;
    } else {
      w = half;
      h = w / aspect;
    }
  }
  const sx = ca.shift_x * 2 * Math.max(w, h),
    sy = ca.shift_y * 2 * Math.max(w, h);
  const c = [
    [-w + sx, -h + sy, -d],
    [w + sx, -h + sy, -d],
    [w + sx, h + sy, -d],
    [-w + sx, h + sy, -d],
  ];
  for (let i = 0; i < 4; i++) line(out, c[i], c[(i + 1) % 4]);
  if (ca.type !== 'ORTHO') for (let i = 0; i < 4; i++) line(out, [0, 0, 0], c[i]);
  else for (let i = 0; i < 4; i++) line(out, [c[i][0], c[i][1], 0], c[i]);
  // "up" triangle above the frame: base 1.4 and height 0.7 frame half-widths
  const ty = h + sy + w * 0.1,
    th = w * 0.7;
  line(out, [-w * 0.7 + sx, ty, -d], [w * 0.7 + sx, ty, -d]);
  line(out, [-w * 0.7 + sx, ty, -d], [sx, ty + th, -d]);
  line(out, [w * 0.7 + sx, ty, -d], [sx, ty + th, -d]);
  return out;
}

/** Filled "up" triangle of the camera as triangles (drawn solid). */
export function cameraTriangle(ca: CameraData, aspect: number): Seg {
  const s = ca.display_size;
  const sensor = ca.sensor_fit === 'VERTICAL' ? ca.sensor_height : ca.sensor_width;
  const fit = ca.sensor_fit === 'VERTICAL' || (ca.sensor_fit === 'AUTO' && aspect < 1);
  let w: number, h: number;
  const half = ca.type === 'ORTHO' ? ca.ortho_scale / 2 : (sensor / 2 / ca.lens) * s;
  if (fit) {
    h = half;
    w = h * aspect;
  } else {
    w = half;
    h = w / aspect;
  }
  const sx = ca.shift_x * 2 * Math.max(w, h),
    sy = ca.shift_y * 2 * Math.max(w, h);
  const ty = h + sy + w * 0.1,
    th = w * 0.7;
  return [-w * 0.7 + sx, ty, -s, w * 0.7 + sx, ty, -s, sx, ty + th, -s];
}

/** Object-space lines of a light; the screen-facing marker is added by the viewport (editors/view3d/lightdraw.ts). */
export function lightWire(la: LightData, groundZ: number | null): Seg {
  void groundZ;
  return lightWireShape(la);
}

/** Thin vertical line to the ground plane drawn in world space for point/spot/area lights. */
export function groundLine(x: number, y: number, z: number): Seg {
  const out: Seg = [];
  line(out, [x, y, z], [x, y, 0]);
  return out;
}

export function emptyWire(ob: ObjectData): Seg {
  const out: Seg = [];
  const s = ob.empty_display_size;
  switch (ob.empty_display_type) {
    case 'ARROWS':
      // three axes with small arrow heads (their letters are drawn screen-facing by the viewport)
      for (const ax of [0, 1, 2]) {
        const tip = [0, 0, 0];
        tip[ax] = s;
        line(out, [0, 0, 0], tip);
        const u = (ax + 1) % 3,
          w = (ax + 2) % 3;
        for (const [du, dw] of [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ]) {
          const b = [0, 0, 0];
          b[ax] = s * 0.94;
          b[u] = du * s * 0.025;
          b[w] = dw * s * 0.025;
          line(out, tip, b);
        }
      }
      break;
    case 'SINGLE_ARROW': {
      // shaft along Z with a cone tip
      line(out, [0, 0, 0], [0, 0, s]);
      const n = 8,
        r = s * 0.035,
        z = s * 0.75;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2,
          a1 = ((i + 1) / n) * Math.PI * 2;
        line(out, [Math.cos(a0) * r, Math.sin(a0) * r, z], [Math.cos(a1) * r, Math.sin(a1) * r, z]);
        if (i % 2 === 0) line(out, [Math.cos(a0) * r, Math.sin(a0) * r, z], [0, 0, s]);
      }
      break;
    }
    case 'CIRCLE':
      // stands in the XZ plane (faces the front view)
      circle(out, s, 32, 'xz');
      break;
    case 'CUBE': {
      const c = [-s, s];
      for (const a of c)
        for (const b of c) {
          line(out, [-s, a, b], [s, a, b]);
          line(out, [a, -s, b], [a, s, b]);
          line(out, [a, b, -s], [a, b, s]);
        }
      break;
    }
    case 'SPHERE':
      circle(out, s, 32, 'xy');
      circle(out, s, 32, 'xz');
      circle(out, s, 32, 'yz');
      break;
    case 'CONE': {
      // octagonal base in the XZ plane, apex along +Y
      circle(out, s, 8, 'xz');
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        line(out, [Math.cos(a) * s, 0, Math.sin(a) * s], [0, 2 * s, 0]);
      }
      break;
    }
    case 'IMAGE':
      line(out, [-s, -s, 0], [s, -s, 0]);
      line(out, [s, -s, 0], [s, s, 0]);
      line(out, [s, s, 0], [-s, s, 0]);
      line(out, [-s, s, 0], [-s, -s, 0]);
      break;
    default:
      line(out, [-s, 0, 0], [s, 0, 0]);
      line(out, [0, -s, 0], [0, s, 0]);
      line(out, [0, 0, -s], [0, 0, s]);
  }
  return out;
}

/** Octahedral bone (rest along +Y of length 1), as line segments. */
export function boneOctahedron(): { lines: Seg; tris: Seg } {
  const r = 0.1;
  const head = [0, 0, 0],
    tail = [0, 1, 0];
  const ring = [
    [r, r, 0],
    [-r, r, 0],
    [-r, r, 0],
    [0, r, 0],
  ];
  void ring;
  const q = [
    [r, r, r],
    [r, r, -r],
    [-r, r, -r],
    [-r, r, r],
  ];
  const lines: Seg = [];
  for (let i = 0; i < 4; i++) {
    line(lines, head, q[i]);
    line(lines, tail, q[i]);
    line(lines, q[i], q[(i + 1) % 4]);
  }
  const tris: Seg = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i],
      b = q[(i + 1) % 4];
    tris.push(...head, ...b, ...a);
    tris.push(...tail, ...a, ...b);
  }
  return { lines, tris };
}

export function armatureStick(arm: ArmatureData): Seg {
  const out: Seg = [];
  for (const b of arm.bones) line(out, b.head, b.tail);
  return out;
}

export function latticeWire(lt: LatticeData): Seg {
  const out: Seg = [];
  const { points_u: U, points_v: V, points_w: W, points: P } = lt;
  const at = (u: number, v: number, w: number) => {
    const i = ((w * V + v) * U + u) * 3;
    return [P[i], P[i + 1], P[i + 2]];
  };
  for (let w = 0; w < W; w++)
    for (let v = 0; v < V; v++)
      for (let u = 0; u < U; u++) {
        if (u + 1 < U) line(out, at(u, v, w), at(u + 1, v, w));
        if (v + 1 < V) line(out, at(u, v, w), at(u, v + 1, w));
        if (w + 1 < W) line(out, at(u, v, w), at(u, v, w + 1));
      }
  return out;
}

export { circle, line, dashedLine };
