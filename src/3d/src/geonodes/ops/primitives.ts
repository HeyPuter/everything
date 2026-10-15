// Mesh and curve primitives with a fixed element order (vertex/face numbering), so
// index-based node setups behave predictably.
import { CurvesComponent, MeshComponent, type AttrMap } from '../geometry';
import { withEdgeOrder, gridEdgeOrder, ringEdgeOrder, faceUseEdgeOrder } from './edgeorder';

/** Collects faces and builds a mesh component (UVs per corner as an optional attribute). */
export class MeshBuild {
  pos: number[] = [];
  faceOffsets: number[] = [0];
  corners: number[] = [];
  uv: number[] = [];
  loose: number[] = [];
  vert(x: number, y: number, z: number) {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }
  face(vs: number[], uvs?: number[]) {
    for (const v of vs) this.corners.push(v);
    if (uvs) for (const u of uvs) this.uv.push(u);
    else for (let i = 0; i < vs.length * 2; i++) this.uv.push(0);
    this.faceOffsets.push(this.corners.length);
  }
  edge(a: number, b: number) {
    this.loose.push(a, b);
  }
  build(opts: { uvName?: string | null; flat?: boolean } = {}): MeshComponent {
    const attrs: AttrMap = new Map();
    const nf = this.faceOffsets.length - 1;
    if (opts.uvName && this.corners.length)
      attrs.set(opts.uvName, {
        domain: 'CORNER',
        type: 'FLOAT2',
        data: new Float32Array(this.uv),
      });
    if (opts.flat && nf)
      attrs.set('sharp_face', {
        domain: 'FACE',
        type: 'BOOLEAN',
        data: new Uint8Array(nf).fill(1),
      });
    return new MeshComponent(new Float32Array(this.pos), new Uint32Array(this.faceOffsets), new Uint32Array(this.corners), new Uint32Array(this.loose), attrs);
  }
}

export function gridMesh(sizeX: number, sizeY: number, vx: number, vy: number, uvName: string | null): MeshComponent {
  const b = new MeshBuild();
  vx = Math.max(1, vx);
  vy = Math.max(1, vy);
  const dx = vx > 1 ? sizeX / (vx - 1) : 0,
    dy = vy > 1 ? sizeY / (vy - 1) : 0;
  const ox = vx > 1 ? -sizeX / 2 : 0,
    oy = vy > 1 ? -sizeY / 2 : 0;
  for (let x = 0; x < vx; x++) for (let y = 0; y < vy; y++) b.vert(ox + x * dx, oy + y * dy, 0);
  const id = (x: number, y: number) => x * vy + y;
  const u = (x: number) => (vx > 1 ? x / (vx - 1) : 0),
    v = (y: number) => (vy > 1 ? y / (vy - 1) : 0);
  for (let x = 0; x < vx - 1; x++) for (let y = 0; y < vy - 1; y++) b.face([id(x, y), id(x + 1, y), id(x + 1, y + 1), id(x, y + 1)], [u(x), v(y), u(x + 1), v(y), u(x + 1), v(y + 1), u(x), v(y + 1)]);
  if (vx === 1 || vy === 1) for (let i = 0; i < vx * vy - 1; i++) b.edge(i, i + 1);
  return withEdgeOrder(b.build({ uvName, flat: true }), gridEdgeOrder(vx, vy));
}

export function cubeMesh(size: [number, number, number], vx: number, vy: number, vz: number, uvName: string | null): MeshComponent {
  vx = Math.max(1, vx);
  vy = Math.max(1, vy);
  vz = Math.max(1, vz);
  const ones = (vx === 1 ? 1 : 0) + (vy === 1 ? 1 : 0) + (vz === 1 ? 1 : 0);
  if (ones >= 1) {
    // degenerate: grid or line in the remaining dimensions
    if (vz === 1 && ones === 1) return gridMesh(size[0], size[1], vx, vy, uvName);
    const b = new MeshBuild();
    const n = Math.max(vx, vy, vz);
    const ax: number = vx > 1 ? 0 : vy > 1 ? 1 : vz > 1 ? 2 : -1;
    const sz: number[] = [size[0], size[1], size[2]];
    if (ones >= 2 || ax < 0) {
      for (let i = 0; i < n; i++) {
        const p = [0, 0, 0];
        if (ax >= 0 && n > 1) p[ax] = -sz[ax] / 2 + (sz[ax] * i) / (n - 1);
        b.vert(p[0], p[1], p[2]);
        if (i) b.edge(i - 1, i);
      }
      return b.build({ uvName: null });
    }
    // one dimension collapsed (X or Y): grid in the other two
    const [a0, a1]: number[] = vx === 1 ? [1, 2] : [0, 2];
    const dims: number[] = [vx, vy, vz];
    const na = dims[a0],
      nb = dims[a1];
    for (let i = 0; i < na; i++)
      for (let j = 0; j < nb; j++) {
        const p = [0, 0, 0];
        p[a0] = -size[a0] / 2 + (size[a0] * i) / (na - 1);
        p[a1] = -size[a1] / 2 + (size[a1] * j) / (nb - 1);
        b.vert(p[0], p[1], p[2]);
      }
    for (let i = 0; i < na - 1; i++) for (let j = 0; j < nb - 1; j++) b.face([i * nb + j, (i + 1) * nb + j, (i + 1) * nb + j + 1, i * nb + j + 1]);
    return b.build({ uvName, flat: true });
  }
  const b = new MeshBuild();
  const idx = new Int32Array(vx * vy * vz).fill(-1);
  const key = (x: number, y: number, z: number) => (z * vy + y) * vx + x;
  for (let z = 0; z < vz; z++)
    for (let y = 0; y < vy; y++)
      for (let x = 0; x < vx; x++) {
        const surface = x === 0 || y === 0 || z === 0 || x === vx - 1 || y === vy - 1 || z === vz - 1;
        if (!surface) continue;
        idx[key(x, y, z)] = b.vert(-size[0] / 2 + (size[0] * x) / (vx - 1), -size[1] / 2 + (size[1] * y) / (vy - 1), -size[2] / 2 + (size[2] * z) / (vz - 1));
      }
  const v = (x: number, y: number, z: number) => idx[key(x, y, z)];
  // UV layout: cross unfold (bottom, front, top, back, left, right) in a 3×2 atlas
  const tile = (col: number, row: number, s: number, t: number) => [(col + s) / 3, (row + t) / 2];
  const quad = (vs: number[], col: number, row: number, s0: number, t0: number, s1: number, t1: number) => {
    const uv = [...tile(col, row, s0, t0), ...tile(col, row, s1, t0), ...tile(col, row, s1, t1), ...tile(col, row, s0, t1)];
    b.face(vs, uv);
  };
  for (let y = 0; y < vy - 1; y++)
    for (let x = 0; x < vx - 1; x++) quad([v(x, y, 0), v(x, y + 1, 0), v(x + 1, y + 1, 0), v(x + 1, y, 0)], 0, 0, y / (vy - 1), x / (vx - 1), (y + 1) / (vy - 1), (x + 1) / (vx - 1));
  for (let z = 0; z < vz - 1; z++)
    for (let x = 0; x < vx - 1; x++) quad([v(x, 0, z), v(x + 1, 0, z), v(x + 1, 0, z + 1), v(x, 0, z + 1)], 1, 0, x / (vx - 1), z / (vz - 1), (x + 1) / (vx - 1), (z + 1) / (vz - 1));
  for (let y = 0; y < vy - 1; y++)
    for (let x = 0; x < vx - 1; x++)
      quad([v(x, y, vz - 1), v(x + 1, y, vz - 1), v(x + 1, y + 1, vz - 1), v(x, y + 1, vz - 1)], 2, 0, x / (vx - 1), y / (vy - 1), (x + 1) / (vx - 1), (y + 1) / (vy - 1));
  for (let z = 0; z < vz - 1; z++)
    for (let x = 0; x < vx - 1; x++)
      quad([v(x, vy - 1, z), v(x, vy - 1, z + 1), v(x + 1, vy - 1, z + 1), v(x + 1, vy - 1, z)], 0, 1, z / (vz - 1), x / (vx - 1), (z + 1) / (vz - 1), (x + 1) / (vx - 1));
  for (let z = 0; z < vz - 1; z++)
    for (let y = 0; y < vy - 1; y++) quad([v(0, y, z), v(0, y, z + 1), v(0, y + 1, z + 1), v(0, y + 1, z)], 1, 1, z / (vz - 1), y / (vy - 1), (z + 1) / (vz - 1), (y + 1) / (vy - 1));
  for (let z = 0; z < vz - 1; z++)
    for (let y = 0; y < vy - 1; y++)
      quad([v(vx - 1, y, z), v(vx - 1, y + 1, z), v(vx - 1, y + 1, z + 1), v(vx - 1, y, z + 1)], 2, 1, y / (vy - 1), z / (vz - 1), (y + 1) / (vy - 1), (z + 1) / (vz - 1));
  return b.build({ uvName, flat: true });
}

export function uvSphereMesh(segments: number, rings: number, radius: number, uvName: string | null): MeshComponent {
  segments = Math.max(3, segments);
  rings = Math.max(2, rings);
  const b = new MeshBuild();
  b.vert(0, 0, radius);
  for (let k = 1; k < rings; k++) {
    const phi = (Math.PI * k) / rings;
    const z = Math.cos(phi) * radius,
      r = Math.sin(phi) * radius;
    for (let j = 0; j < segments; j++) {
      const th = (2 * Math.PI * (j + 1)) / segments;
      b.vert(Math.cos(th) * r, Math.sin(th) * r, z);
    }
  }
  const bottom = b.vert(0, 0, -radius);
  const ring = (k: number, j: number) => 1 + (k - 1) * segments + (((j % segments) + segments) % segments);
  const U = (j: number) => j / segments,
    V = (k: number) => 1 - k / rings;
  for (let j = 0; j < segments; j++) b.face([0, ring(1, j), ring(1, j + 1)], [(j + 0.5) / segments, 1, U(j), V(1), U(j + 1), V(1)]);
  for (let k = 1; k < rings - 1; k++)
    for (let j = 0; j < segments; j++) b.face([ring(k, j), ring(k + 1, j), ring(k + 1, j + 1), ring(k, j + 1)], [U(j), V(k), U(j), V(k + 1), U(j + 1), V(k + 1), U(j + 1), V(k)]);
  for (let j = 0; j < segments; j++) b.face([bottom, ring(rings - 1, j + 1), ring(rings - 1, j)], [(j + 0.5) / segments, 0, U(j + 1), V(rings - 1), U(j), V(rings - 1)]);
  const m = b.build({ uvName, flat: true });
  return withEdgeOrder(m, ringEdgeOrder(m.vertCount, segments, true, true, true));
}

const ICO_V = [
  [0, 0, -1],
  [0.7236, -0.52572, -0.44721],
  [-0.27639, -0.85064, -0.44721],
  [-0.89442, 0, -0.44721],
  [-0.27639, 0.85064, -0.44721],
  [0.7236, 0.52572, -0.44721],
  [0.27639, -0.85064, 0.44721],
  [-0.7236, -0.52572, 0.44721],
  [-0.7236, 0.52572, 0.44721],
  [0.27639, 0.85064, 0.44721],
  [0.89442, 0, 0.44721],
  [0, 0, 1],
];
const ICO_F = [
  [0, 1, 2],
  [1, 0, 5],
  [0, 2, 3],
  [0, 3, 4],
  [0, 4, 5],
  [1, 5, 10],
  [2, 1, 6],
  [3, 2, 7],
  [4, 3, 8],
  [5, 4, 9],
  [1, 10, 6],
  [2, 6, 7],
  [3, 7, 8],
  [4, 8, 9],
  [5, 9, 10],
  [6, 10, 11],
  [7, 6, 11],
  [8, 7, 11],
  [9, 8, 11],
  [10, 9, 11],
];

export function icoSphereMesh(radius: number, subdivisions: number, uvName: string | null): MeshComponent {
  const pos: number[][] = ICO_V.map((p) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l];
  });
  let faces = ICO_F.map((f) => [...f]);
  for (let s = 1; s < Math.min(10, Math.max(1, subdivisions)); s++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = mid.get(k);
      if (i === undefined) {
        const p = [(pos[a][0] + pos[b][0]) / 2, (pos[a][1] + pos[b][1]) / 2, (pos[a][2] + pos[b][2]) / 2];
        const l = Math.hypot(p[0], p[1], p[2]) || 1;
        i = pos.length;
        pos.push([p[0] / l, p[1] / l, p[2] / l]);
        mid.set(k, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = m(a, b),
        bc = m(b, c),
        ca = m(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    faces = next;
  }
  const b = new MeshBuild();
  for (const p of pos) b.vert(p[0] * radius, p[1] * radius, p[2] * radius);
  const uvOf = (p: number[]) => [0.5 + Math.atan2(p[1], p[0]) / (2 * Math.PI), 0.5 + Math.asin(Math.max(-1, Math.min(1, p[2]))) / Math.PI];
  for (const f of faces) {
    const uv = f.flatMap((v) => uvOf(pos[v]));
    // fix seam wrap within a triangle
    const us = [uv[0], uv[2], uv[4]];
    if (Math.max(...us) - Math.min(...us) > 0.5) for (let k = 0; k < 3; k++) if (uv[k * 2] < 0.5) uv[k * 2] += 1;
    b.face(f, uv);
  }
  const m = b.build({ uvName, flat: true });
  return subdivisions <= 1 ? withEdgeOrder(m, faceUseEdgeOrder(m)) : m;
}

export type FillType = 'NONE' | 'NGON' | 'TRIANGLE_FAN';

/** Cone/cylinder with side and fill segments. Returns the mesh and Top/Side/Bottom face flags. */
export function coneMesh(
  verts: number,
  sideSegs: number,
  fillSegs: number,
  rTop: number,
  rBottom: number,
  zTop: number,
  zBottom: number,
  fill: FillType,
  uvName: string | null,
): {
  mesh: MeshComponent;
  top: Uint8Array;
  side: Uint8Array;
  bottom: Uint8Array;
} {
  verts = Math.max(3, verts);
  sideSegs = Math.max(1, sideSegs);
  fillSegs = Math.max(1, fillSegs);
  const b = new MeshBuild();
  const flags: ('T' | 'S' | 'B')[] = [];
  const ring = (r: number, z: number) => {
    const start = b.pos.length / 3;
    for (let i = 0; i < verts; i++) {
      const th = (2 * Math.PI * i) / verts;
      b.vert(Math.cos(th) * r, Math.sin(th) * r, z);
    }
    return start;
  };
  const topPoint = rTop <= 0,
    bottomPoint = rBottom <= 0;
  const capTop = !topPoint && fill !== 'NONE',
    capBottom = !bottomPoint && fill !== 'NONE';
  // vertices
  let topCenter = -1;
  const topFill: number[] = [];
  if (capTop) {
    if (fill === 'TRIANGLE_FAN') topCenter = b.vert(0, 0, zTop);
    for (let s = 1; s < fillSegs; s++) topFill.push(ring((rTop * s) / fillSegs, zTop));
  }
  const sides: number[] = []; // ring start or -(point index + 1)
  for (let k = 0; k <= sideSegs; k++) {
    const t = k / sideSegs;
    const r = rTop + (rBottom - rTop) * t,
      z = zTop + (zBottom - zTop) * t;
    if ((k === 0 && topPoint) || (k === sideSegs && bottomPoint)) sides.push(-(b.vert(0, 0, z) + 1));
    else sides.push(ring(r, z));
  }
  const bottomFill: number[] = [];
  let bottomCenter = -1;
  if (capBottom) {
    for (let s = fillSegs - 1; s >= 1; s--) bottomFill.push(ring((rBottom * s) / fillSegs, zBottom));
    if (fill === 'TRIANGLE_FAN') bottomCenter = b.vert(0, 0, zBottom);
  }
  const R = (start: number, i: number) => start + (((i % verts) + verts) % verts);
  // UVs: side band in the upper half, caps as discs in the lower half
  const capUV = (r: number, rMax: number, i: number, cx: number) => {
    const th = (2 * Math.PI * i) / verts;
    const k = rMax > 0 ? (0.25 * r) / rMax : 0;
    return [cx + Math.cos(th) * k, 0.25 + Math.sin(th) * k];
  };
  const sideUV = (k: number, i: number) => [i / verts, 0.5 + 0.5 * (1 - k / sideSegs)];
  // top cap faces
  if (capTop) {
    const inner = topFill.length ? topFill[0] : sides[0];
    const innerR = rTop / fillSegs;
    if (fill === 'TRIANGLE_FAN') {
      for (let i = 0; i < verts; i++) {
        b.face([R(inner, i), R(inner, i + 1), topCenter], [...capUV(innerR, rTop, i, 0.25), ...capUV(innerR, rTop, i + 1, 0.25), 0.25, 0.25]);
        flags.push('T');
      }
    } else {
      b.face(
        Array.from({ length: verts }, (_, i) => R(inner, i)),
        Array.from({ length: verts }, (_, i) => capUV(innerR, rTop, i, 0.25)).flat(),
      );
      flags.push('T');
    }
    const rings = [...topFill, sides[0]];
    for (let s = 0; s < rings.length - 1; s++) {
      const a = rings[s],
        c = rings[s + 1];
      const ra = (rTop * (s + 1)) / fillSegs,
        rc = (rTop * (s + 2)) / fillSegs;
      for (let i = 0; i < verts; i++) {
        b.face([R(a, i), R(c, i), R(c, i + 1), R(a, i + 1)], [...capUV(ra, rTop, i, 0.25), ...capUV(rc, rTop, i, 0.25), ...capUV(rc, rTop, i + 1, 0.25), ...capUV(ra, rTop, i + 1, 0.25)]);
        flags.push('T');
      }
    }
  }
  // sides
  for (let k = 0; k < sideSegs; k++) {
    const a = sides[k],
      c = sides[k + 1];
    for (let i = 0; i < verts; i++) {
      if (a < 0) b.face([R(c, i), R(c, i + 1), -a - 1], [...sideUV(k + 1, i), ...sideUV(k + 1, i + 1), ...sideUV(k, i + 0.5)]);
      else if (c < 0) b.face([R(a, i), -c - 1, R(a, i + 1)], [...sideUV(k, i), ...sideUV(k + 1, i + 0.5), ...sideUV(k, i + 1)]);
      else b.face([R(a, i), R(c, i), R(c, i + 1), R(a, i + 1)], [...sideUV(k, i), ...sideUV(k + 1, i), ...sideUV(k + 1, i + 1), ...sideUV(k, i + 1)]);
      flags.push('S');
    }
  }
  // bottom cap faces
  if (capBottom) {
    const rings = [sides[sideSegs], ...bottomFill];
    for (let s = 0; s < rings.length - 1; s++) {
      const a = rings[s],
        c = rings[s + 1];
      const ra = (rBottom * (fillSegs - s)) / fillSegs,
        rc = (rBottom * (fillSegs - s - 1)) / fillSegs;
      for (let i = 0; i < verts; i++) {
        b.face(
          [R(a, i), R(c, i), R(c, i + 1), R(a, i + 1)],
          [...capUV(ra, rBottom, -i, 0.75), ...capUV(rc, rBottom, -i, 0.75), ...capUV(rc, rBottom, -i - 1, 0.75), ...capUV(ra, rBottom, -i - 1, 0.75)],
        );
        flags.push('B');
      }
    }
    const inner = rings[rings.length - 1];
    const innerR = rBottom / fillSegs;
    if (fill === 'TRIANGLE_FAN') {
      for (let i = 0; i < verts; i++) {
        b.face([R(inner, i), bottomCenter, R(inner, i + 1)], [...capUV(innerR, rBottom, -i, 0.75), 0.75, 0.25, ...capUV(innerR, rBottom, -i - 1, 0.75)]);
        flags.push('B');
      }
    } else {
      b.face(
        Array.from({ length: verts }, (_, i) => R(inner, verts - 1 - i)),
        Array.from({ length: verts }, (_, i) => capUV(innerR, rBottom, -(verts - 1 - i), 0.75)).flat(),
      );
      flags.push('B');
    }
  }
  // without caps the open rims are boundary edges of the side faces; loose edges only when no side faces
  const mesh = withEdgeOrder(
    b.build({ uvName, flat: true }),
    ringEdgeOrder(b.pos.length / 3, verts, topPoint || (capTop && fill === 'TRIANGLE_FAN'), bottomPoint || (capBottom && fill === 'TRIANGLE_FAN')),
  );
  const nf = flags.length;
  const top = new Uint8Array(nf),
    side = new Uint8Array(nf),
    bottom = new Uint8Array(nf);
  flags.forEach((f, i) => {
    if (f === 'T') top[i] = 1;
    else if (f === 'S') side[i] = 1;
    else bottom[i] = 1;
  });
  return { mesh, top, side, bottom };
}

export function circleMesh(verts: number, radius: number, fill: FillType, uvName: string | null): MeshComponent {
  verts = Math.max(3, verts);
  const b = new MeshBuild();
  for (let i = 0; i < verts; i++) {
    const th = (2 * Math.PI * i) / verts;
    b.vert(Math.cos(th) * radius, Math.sin(th) * radius, 0);
  }
  const uv = (i: number) => {
    const th = (2 * Math.PI * i) / verts;
    return [0.5 + Math.cos(th) * 0.5, 0.5 + Math.sin(th) * 0.5];
  };
  if (fill === 'NONE') for (let i = 0; i < verts; i++) b.edge(i, (i + 1) % verts);
  else if (fill === 'NGON')
    b.face(
      Array.from({ length: verts }, (_, i) => i),
      Array.from({ length: verts }, (_, i) => uv(i)).flat(),
    );
  else {
    const c = b.vert(0, 0, 0);
    for (let i = 0; i < verts; i++) b.face([i, (i + 1) % verts, c], [...uv(i), ...uv(i + 1), 0.5, 0.5]);
  }
  const m = b.build({ uvName, flat: fill !== 'NONE' });
  const loop: number[] = [];
  for (let i = 0; i < verts; i++) loop.push(i, (i + 1) % verts);
  if (fill === 'TRIANGLE_FAN') for (let i = 0; i < verts; i++) loop.push(verts, i);
  return withEdgeOrder(m, loop);
}

export function lineMesh(count: number, start: number[], offset: number[]): MeshComponent {
  const b = new MeshBuild();
  for (let i = 0; i < count; i++) b.vert(start[0] + offset[0] * i, start[1] + offset[1] * i, start[2] + offset[2] * i);
  for (let i = 0; i + 1 < count; i++) b.edge(i, i + 1);
  return b.build();
}

// ---------------------------------------------------------------------------
// Curves

export function curveFromPoints(points: number[][], cyclic: boolean, radius = 1): CurvesComponent {
  const pos = new Float32Array(points.flat());
  const attrs: AttrMap = new Map([
    [
      'radius',
      {
        domain: 'POINT',
        type: 'FLOAT',
        data: new Float32Array(points.length).fill(radius),
      },
    ],
  ]);
  return new CurvesComponent(pos, new Uint32Array([0, points.length]), new Uint8Array([cyclic ? 1 : 0]), attrs);
}

export function spiralPoints(resolution: number, rotations: number, startR: number, endR: number, height: number, reverse: boolean): number[][] {
  const count = Math.max(1, Math.round(resolution * rotations)) + 1;
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const th = (reverse ? 1 : -1) * 2 * Math.PI * rotations * t;
    const r = startR + (endR - startR) * t;
    out.push([Math.cos(th) * r, Math.sin(th) * r, height * t]);
  }
  return out;
}

export function quadrilateralPoints(mode: string, v: Record<string, number | number[]>): number[][] {
  const n = (k: string) => v[k] as number;
  switch (mode) {
    case 'PARALLELOGRAM': {
      const w = n('Width'),
        h = n('Height'),
        o = n('Offset');
      return [
        [w / 2 + o / 2, h / 2, 0],
        [-w / 2 + o / 2, h / 2, 0],
        [-w / 2 - o / 2, -h / 2, 0],
        [w / 2 - o / 2, -h / 2, 0],
      ];
    }
    case 'TRAPEZOID': {
      const bw = n('Bottom Width'),
        tw = n('Top Width'),
        h = n('Height'),
        o = n('Offset');
      return [
        [tw / 2 + o, h / 2, 0],
        [-tw / 2 + o, h / 2, 0],
        [-bw / 2, -h / 2, 0],
        [bw / 2, -h / 2, 0],
      ];
    }
    case 'KITE': {
      const w = n('Width'),
        bh = n('Bottom Height'),
        th = n('Top Height');
      return [
        [0, -bh, 0],
        [w / 2, 0, 0],
        [0, th, 0],
        [-w / 2, 0, 0],
      ];
    }
    case 'POINTS':
      return [v['Point 1'], v['Point 2'], v['Point 3'], v['Point 4']].map((p) => [...(p as number[])]);
    default: {
      const w = n('Width'),
        h = n('Height');
      return [
        [w / 2, h / 2, 0],
        [-w / 2, h / 2, 0],
        [-w / 2, -h / 2, 0],
        [w / 2, -h / 2, 0],
      ];
    }
  }
}

/** Circle through three points: center, radius and an orthonormal basis of its plane. */
export function circleFrom3(p1: number[], p2: number[], p3: number[]): { center: number[]; radius: number; u: number[]; v: number[] } | null {
  const a = p1.map((x, i) => x - p3[i]),
    b = p2.map((x, i) => x - p3[i]);
  const axb = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const d = 2 * (axb[0] ** 2 + axb[1] ** 2 + axb[2] ** 2);
  if (d < 1e-12) return null;
  const la = a[0] ** 2 + a[1] ** 2 + a[2] ** 2,
    lb = b[0] ** 2 + b[1] ** 2 + b[2] ** 2;
  const t = a.map((_, i) => la * b[i] - lb * a[i]);
  const c = [t[1] * axb[2] - t[2] * axb[1], t[2] * axb[0] - t[0] * axb[2], t[0] * axb[1] - t[1] * axb[0]].map((x, i) => x / d + p3[i]);
  const radius = Math.hypot(p1[0] - c[0], p1[1] - c[1], p1[2] - c[2]);
  const nl = Math.hypot(axb[0], axb[1], axb[2]);
  const n = axb.map((x) => x / nl);
  const u = p1.map((x, i) => (x - c[i]) / (radius || 1));
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return { center: c, radius, u, v };
}
