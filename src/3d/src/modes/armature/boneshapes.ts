// Bone display shapes for the armature Viewport Display types: Octahedral, Stick, B-Bone,
// Envelope and Wire. Geometry is in bone space (Y along the bone); `unit` shapes are built for
// length 1 and scaled by the bone length, the others use real sizes.
import type { ArmatureData, Bone } from '../../data/types';

export interface BoneShape {
  /** line segment endpoints (xyz pairs) */
  lines: number[];
  /** triangles (xyz × 3) */
  tris: number[];
  /** scale the shape by the bone length */
  unit: boolean;
}

const seg = (out: number[], a: number[], b: number[]) => out.push(a[0], a[1], a[2], b[0], b[1], b[2]);

/** Rectangular prism from y=0 to y=len with half widths hx / hz. */
function box(hx: number, hz: number, len: number, segments = 1): { lines: number[]; tris: number[] } {
  const lines: number[] = [],
    tris: number[] = [];
  const ring = (y: number) => [
    [hx, y, hz],
    [-hx, y, hz],
    [-hx, y, -hz],
    [hx, y, -hz],
  ];
  const rings = Array.from({ length: segments + 1 }, (_, i) => ring((len * i) / segments));
  for (let r = 0; r < rings.length; r++)
    for (let k = 0; k < 4; k++) {
      seg(lines, rings[r][k], rings[r][(k + 1) % 4]);
      if (r + 1 < rings.length) {
        seg(lines, rings[r][k], rings[r + 1][k]);
        const a = rings[r][k],
          b = rings[r][(k + 1) % 4],
          c = rings[r + 1][(k + 1) % 4],
          d = rings[r + 1][k];
        tris.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  // end caps
  for (const [r, flip] of [
    [rings[0], true],
    [rings[rings.length - 1], false],
  ] as const) {
    const [a, b, c, d] = r;
    if (flip) tris.push(...a, ...c, ...b, ...a, ...d, ...c);
    else tris.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return { lines, tris };
}

/** Sphere (latitude / longitude) at y = cy. */
function sphere(r: number, cy: number, out: { lines: number[]; tris: number[] }, n = 10) {
  const P = (i: number, j: number) => {
    const th = (i / n) * Math.PI,
      ph = (j / n) * Math.PI * 2;
    return [r * Math.sin(th) * Math.cos(ph), cy + r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)];
  };
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const a = P(i, j),
        b = P(i + 1, j),
        c = P(i + 1, j + 1),
        d = P(i, j + 1);
      out.tris.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  // three outline circles
  for (let j = 0; j < 24; j++) {
    const a = (j / 24) * Math.PI * 2,
      b = ((j + 1) / 24) * Math.PI * 2;
    seg(out.lines, [r * Math.cos(a), cy, r * Math.sin(a)], [r * Math.cos(b), cy, r * Math.sin(b)]);
    seg(out.lines, [r * Math.cos(a), cy + r * Math.sin(a), 0], [r * Math.cos(b), cy + r * Math.sin(b), 0]);
    seg(out.lines, [0, cy + r * Math.sin(a), r * Math.cos(a)], [0, cy + r * Math.sin(b), r * Math.cos(b)]);
  }
}

let octahedral: BoneShape | null = null;

export function octahedralShape(): BoneShape {
  if (octahedral) return octahedral;
  const r = 0.1;
  const head = [0, 0, 0],
    tail = [0, 1, 0];
  const q = [
    [r, r, r],
    [r, r, -r],
    [-r, r, -r],
    [-r, r, r],
  ];
  const lines: number[] = [],
    tris: number[] = [];
  for (let i = 0; i < 4; i++) {
    seg(lines, head, q[i]);
    seg(lines, tail, q[i]);
    seg(lines, q[i], q[(i + 1) % 4]);
    const a = q[i],
      b = q[(i + 1) % 4];
    tris.push(...head, ...b, ...a, ...tail, ...a, ...b);
  }
  return (octahedral = { lines, tris, unit: true });
}

/** Display shape of a bone for an armature display type (null: use the shared octahedron). */
export function boneShape(type: ArmatureData['display_type'], bone: Bone | undefined, length: number): BoneShape | null {
  switch (type) {
    case 'STICK': {
      const b = box(0.025, 0.025, 1);
      return { ...b, unit: true };
    }
    case 'BBONE': {
      const b = box(bone?.bbone_x ?? 0.1 * length, bone?.bbone_z ?? 0.1 * length, length, Math.max(1, Math.min(32, bone?.bbone_segments ?? 1)));
      return { ...b, unit: false };
    }
    case 'ENVELOPE': {
      const out = { lines: [] as number[], tris: [] as number[] };
      const rh = Math.max(1e-4, bone?.head_radius ?? 0.1),
        rt = Math.max(1e-4, bone?.tail_radius ?? 0.05);
      sphere(rh, 0, out);
      sphere(rt, length, out);
      // tapered body between the two spheres
      const n = 16;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2,
          c = ((j + 1) / n) * Math.PI * 2;
        const p = (r: number, y: number, t: number) => [r * Math.cos(t), y, r * Math.sin(t)];
        out.tris.push(...p(rh, 0, a), ...p(rt, length, a), ...p(rt, length, c), ...p(rh, 0, a), ...p(rt, length, c), ...p(rh, 0, c));
      }
      return { ...out, unit: false };
    }
    case 'WIRE': {
      const lines: number[] = [];
      seg(lines, [0, 0, 0], [0, 1, 0]);
      return { lines, tris: [], unit: true };
    }
    default:
      return null;
  }
}
