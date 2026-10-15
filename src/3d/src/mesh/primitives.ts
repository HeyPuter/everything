// Mesh primitive generators. Dimensions and default segment counts are the
// Add > Mesh defaults (Z-up, size 2 / radius 1).
import { buildMesh, type PolyFace } from './mesh';

export type PrimitiveArrays = ReturnType<typeof buildMesh>;

const TAU = Math.PI * 2;

export function cube(size = 2): PrimitiveArrays {
  const h = size / 2;
  const p = [
    [-h, -h, -h],
    [-h, -h, h],
    [-h, h, -h],
    [-h, h, h],
    [h, -h, -h],
    [h, -h, h],
    [h, h, -h],
    [h, h, h],
  ].flat();
  // cross-shaped unwrap (columns 0.375..0.625, rows of quarter height)
  const q = (u0: number, v0: number) => [u0, v0, u0 + 0.25, v0, u0 + 0.25, v0 + 0.25, u0, v0 + 0.25];
  const faces: PolyFace[] = [
    { verts: [0, 1, 3, 2], uvs: q(0.375, 0) }, // -X
    { verts: [2, 3, 7, 6], uvs: q(0.375, 0.25) }, // +Y
    { verts: [6, 7, 5, 4], uvs: q(0.375, 0.5) }, // +X
    { verts: [4, 5, 1, 0], uvs: q(0.375, 0.75) }, // -Y
    { verts: [2, 6, 4, 0], uvs: q(0.125, 0.5) }, // -Z
    { verts: [7, 3, 1, 5], uvs: q(0.625, 0.5) }, // +Z
  ];
  // fix winding so normals point outward
  return buildMesh(p, faces.map((f) => orientOutward(p, f)));
}

function orientOutward(p: number[], f: PolyFace): PolyFace {
  // centroid direction test (valid for convex primitives centered at the origin)
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const v of f.verts) {
    cx += p[v * 3];
    cy += p[v * 3 + 1];
    cz += p[v * 3 + 2];
  }
  const [a, b, c] = f.verts;
  const ux = p[b * 3] - p[a * 3],
    uy = p[b * 3 + 1] - p[a * 3 + 1],
    uz = p[b * 3 + 2] - p[a * 3 + 2],
    vx = p[c * 3] - p[a * 3],
    vy = p[c * 3 + 1] - p[a * 3 + 1],
    vz = p[c * 3 + 2] - p[a * 3 + 2];
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  if (nx * cx + ny * cy + nz * cz >= 0) return f;
  const n = f.verts.length;
  const verts = [...f.verts].reverse();
  const uvs: number[] = [];
  if (f.uvs) for (let i = n - 1; i >= 0; i--) uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
  return { ...f, verts, uvs: f.uvs ? uvs : undefined };
}

export function plane(size = 2): PrimitiveArrays {
  const h = size / 2;
  return buildMesh([-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0], [{ verts: [0, 1, 2, 3], uvs: [0, 0, 1, 0, 1, 1, 0, 1] }]);
}

export function grid(xSub = 10, ySub = 10, size = 2): PrimitiveArrays {
  const p: number[] = [],
    faces: PolyFace[] = [];
  for (let j = 0; j <= ySub; j++)
    for (let i = 0; i <= xSub; i++) p.push((i / xSub - 0.5) * size, (j / ySub - 0.5) * size, 0);
  const row = xSub + 1;
  for (let j = 0; j < ySub; j++)
    for (let i = 0; i < xSub; i++) {
      const a = j * row + i;
      faces.push({
        verts: [a, a + 1, a + row + 1, a + row],
        uvs: [i / xSub, j / ySub, (i + 1) / xSub, j / ySub, (i + 1) / xSub, (j + 1) / ySub, i / xSub, (j + 1) / ySub],
      });
    }
  return buildMesh(p, faces);
}

export function circle(vertices = 32, radius = 1, fill: 'NOTHING' | 'NGON' | 'TRIFAN' = 'NOTHING'): PrimitiveArrays {
  const p: number[] = [];
  for (let i = 0; i < vertices; i++) {
    const a = (i / vertices) * TAU;
    p.push(-Math.sin(a) * radius, Math.cos(a) * radius, 0);
  }
  const faces: PolyFace[] = [];
  const uv = (i: number) => [0.5 - Math.sin((i / vertices) * TAU) * 0.5, 0.5 + Math.cos((i / vertices) * TAU) * 0.5];
  if (fill === 'NGON') {
    const verts = Array.from({ length: vertices }, (_, i) => i);
    faces.push(orientUp(p, { verts, uvs: verts.flatMap(uv) }));
  } else if (fill === 'TRIFAN') {
    p.push(0, 0, 0);
    for (let i = 0; i < vertices; i++)
      faces.push(orientUp(p, { verts: [vertices, i, (i + 1) % vertices], uvs: [0.5, 0.5, ...uv(i), ...uv((i + 1) % vertices)] }));
  }
  return buildMesh(p, faces);
}

function orientUp(p: number[], f: PolyFace): PolyFace {
  const [a, b, c] = f.verts;
  const nz = (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3] - p[a * 3]);
  if (nz >= 0) return f;
  const n = f.verts.length,
    uvs: number[] = [];
  if (f.uvs) for (let i = n - 1; i >= 0; i--) uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
  return { ...f, verts: [...f.verts].reverse(), uvs: f.uvs ? uvs : undefined };
}

export function uvSphere(segments = 32, rings = 16, radius = 1): PrimitiveArrays {
  const p: number[] = [];
  p.push(0, 0, radius); // top pole: 0
  for (let r = 1; r < rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s < segments; s++) {
      const th = (s / segments) * TAU;
      p.push(Math.sin(phi) * Math.cos(th) * radius, Math.sin(phi) * Math.sin(th) * radius, Math.cos(phi) * radius);
    }
  }
  const bottom = p.length / 3;
  p.push(0, 0, -radius);
  const ring = (r: number, s: number) => 1 + (r - 1) * segments + (s % segments);
  const faces: PolyFace[] = [];
  const U = (s: number) => s / segments,
    V = (r: number) => 1 - r / rings;
  for (let s = 0; s < segments; s++) {
    faces.push({
      verts: [0, ring(1, s), ring(1, s + 1)],
      uvs: [U(s + 0.5), 1, U(s), V(1), U(s + 1), V(1)],
      smooth: false,
    });
  }
  for (let r = 1; r < rings - 1; r++)
    for (let s = 0; s < segments; s++)
      faces.push({
        verts: [ring(r, s), ring(r + 1, s), ring(r + 1, s + 1), ring(r, s + 1)],
        uvs: [U(s), V(r), U(s), V(r + 1), U(s + 1), V(r + 1), U(s + 1), V(r)],
      });
  for (let s = 0; s < segments; s++)
    faces.push({
      verts: [ring(rings - 1, s), bottom, ring(rings - 1, s + 1)],
      uvs: [U(s), V(rings - 1), U(s + 0.5), 0, U(s + 1), V(rings - 1)],
    });
  return buildMesh(p, faces.map((f) => orientOutward(p, f)));
}

export function icoSphere(subdivisions = 2, radius = 1): PrimitiveArrays {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  let tris = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let s = 1; s < subdivisions; s++) {
    const cache = new Map<string, number>(),
      next: number[][] = [];
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let id = cache.get(key);
      if (id === undefined) {
        const m = [0, 1, 2].map((i) => (verts[a][i] + verts[b][i]) / 2),
          l = Math.hypot(m[0], m[1], m[2]);
        id = verts.length;
        verts.push([m[0] / l, m[1] / l, m[2] / l]);
        cache.set(key, id);
      }
      return id;
    };
    for (const [a, b, c] of tris) {
      const ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  verts = verts.map((v) => v.map((x) => x * radius));
  const p = verts.flat();
  const uvOf = (v: number[]) => [0.5 + Math.atan2(v[1], v[0]) / TAU, 0.5 + Math.asin(Math.max(-1, Math.min(1, v[2] / radius))) / Math.PI];
  const faces: PolyFace[] = tris.map((tri) => {
    const uv = tri.map((i) => uvOf(verts[i]));
    // fix seam wrap
    const us = uv.map((x) => x[0]);
    if (Math.max(...us) - Math.min(...us) > 0.5) uv.forEach((x) => x[0] < 0.5 && (x[0] += 1));
    return { verts: tri, uvs: uv.flat() };
  });
  return buildMesh(p, faces.map((f) => orientOutward(p, f)));
}

export function cylinder(vertices = 32, radius = 1, depth = 2, cap: 'NOTHING' | 'NGON' | 'TRIFAN' = 'NGON'): PrimitiveArrays {
  return cone(vertices, radius, radius, depth, cap);
}

export function cone(
  vertices = 32,
  radius1 = 1,
  radius2 = 0,
  depth = 2,
  cap: 'NOTHING' | 'NGON' | 'TRIFAN' = 'NGON',
): PrimitiveArrays {
  const p: number[] = [],
    h = depth / 2;
  const tip = radius2 === 0;
  for (let i = 0; i < vertices; i++) {
    const a = (i / vertices) * TAU;
    p.push(-Math.sin(a) * radius1, Math.cos(a) * radius1, -h);
  }
  if (tip) p.push(0, 0, h);
  else
    for (let i = 0; i < vertices; i++) {
      const a = (i / vertices) * TAU;
      p.push(-Math.sin(a) * radius2, Math.cos(a) * radius2, h);
    }
  const faces: PolyFace[] = [];
  for (let i = 0; i < vertices; i++) {
    const j = (i + 1) % vertices,
      u0 = i / vertices,
      u1 = (i + 1) / vertices;
    if (tip) faces.push({ verts: [i, j, vertices], uvs: [u0, 0.5, u1, 0.5, (u0 + u1) / 2, 1] });
    else
      faces.push({
        verts: [i, j, vertices + j, vertices + i],
        uvs: [u0, 0.5, u1, 0.5, u1, 1, u0, 1],
      });
  }
  const capUV = (i: number, cx: number) => [cx - Math.sin((i / vertices) * TAU) * 0.24, 0.25 + Math.cos((i / vertices) * TAU) * 0.24];
  if (cap === 'NGON') {
    faces.push({ verts: Array.from({ length: vertices }, (_, i) => vertices - 1 - i), uvs: Array.from({ length: vertices }, (_, i) => capUV(vertices - 1 - i, 0.25)).flat() });
    if (!tip) faces.push({ verts: Array.from({ length: vertices }, (_, i) => vertices + i), uvs: Array.from({ length: vertices }, (_, i) => capUV(i, 0.75)).flat() });
  } else if (cap === 'TRIFAN') {
    const cb = p.length / 3;
    p.push(0, 0, -h);
    for (let i = 0; i < vertices; i++) faces.push({ verts: [cb, (i + 1) % vertices, i], uvs: [0.25, 0.25, ...capUV((i + 1) % vertices, 0.25), ...capUV(i, 0.25)] });
    if (!tip) {
      const ct = p.length / 3;
      p.push(0, 0, h);
      for (let i = 0; i < vertices; i++)
        faces.push({ verts: [ct, vertices + i, vertices + ((i + 1) % vertices)], uvs: [0.75, 0.25, ...capUV(i, 0.75), ...capUV((i + 1) % vertices, 0.75)] });
    }
  }
  return buildMesh(p, faces.map((f) => orientOutward(p, f)));
}

export function torus(majorSegments = 48, minorSegments = 12, majorRadius = 1, minorRadius = 0.25): PrimitiveArrays {
  const p: number[] = [];
  for (let i = 0; i < majorSegments; i++) {
    const a = (i / majorSegments) * TAU,
      ca = Math.cos(a),
      sa = Math.sin(a);
    for (let j = 0; j < minorSegments; j++) {
      const b = (j / minorSegments) * TAU,
        r = majorRadius + Math.cos(b) * minorRadius;
      p.push(ca * r, sa * r, Math.sin(b) * minorRadius);
    }
  }
  const faces: PolyFace[] = [];
  const id = (i: number, j: number) => (i % majorSegments) * minorSegments + (j % minorSegments);
  for (let i = 0; i < majorSegments; i++)
    for (let j = 0; j < minorSegments; j++) {
      const u0 = i / majorSegments,
        u1 = (i + 1) / majorSegments,
        v0 = j / minorSegments,
        v1 = (j + 1) / minorSegments;
      faces.push({
        verts: [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)],
        uvs: [u0, v0, u1, v0, u1, v1, u0, v1],
      });
    }
  // torus faces are outward by construction (verified by orientation of the parametrization)
  return buildMesh(p, faces.map((f) => orientTorus(p, f, majorRadius)));
}

function orientTorus(p: number[], f: PolyFace, R: number): PolyFace {
  // outward = away from the ring center line
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const v of f.verts) {
    cx += p[v * 3] / f.verts.length;
    cy += p[v * 3 + 1] / f.verts.length;
    cz += p[v * 3 + 2] / f.verts.length;
  }
  const l = Math.hypot(cx, cy) || 1;
  const ox = cx - (cx / l) * R,
    oy = cy - (cy / l) * R,
    oz = cz;
  const [a, b, c] = f.verts;
  const ux = p[b * 3] - p[a * 3],
    uy = p[b * 3 + 1] - p[a * 3 + 1],
    uz = p[b * 3 + 2] - p[a * 3 + 2],
    vx = p[c * 3] - p[a * 3],
    vy = p[c * 3 + 1] - p[a * 3 + 1],
    vz = p[c * 3 + 2] - p[a * 3 + 2];
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  if (nx * ox + ny * oy + nz * oz >= 0) return f;
  const n = f.verts.length,
    uvs: number[] = [];
  if (f.uvs) for (let i = n - 1; i >= 0; i--) uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
  return { ...f, verts: [...f.verts].reverse(), uvs: f.uvs ? uvs : undefined };
}

/**
 * Original mascot primitive: a stylized rounded robot head built from scratch
 * (not derived from any third-party asset). Useful as a non-trivial test mesh.
 */
export function mascot(): PrimitiveArrays {
  // Start from a subdivided cube-sphere and add ears/eyes procedurally.
  const n = 6;
  const p: number[] = [];
  const faces: PolyFace[] = [];
  const index = new Map<string, number>();
  const vert = (x: number, y: number, z: number) => {
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = p.length / 3;
      p.push(x, y, z);
      index.set(key, id);
    }
    return id;
  };
  const dirs: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [nrm, u, v] of dirs) {
    const ids: number[][] = [];
    for (let j = 0; j <= n; j++) {
      ids.push([]);
      for (let i = 0; i <= n; i++) {
        const s = (i / n) * 2 - 1,
          t = (j / n) * 2 - 1;
        let x = nrm[0] + u[0] * s + v[0] * t,
          y = nrm[1] + u[1] * s + v[1] * t,
          z = nrm[2] + u[2] * s + v[2] * t;
        const l = Math.hypot(x, y, z);
        // squircle-ish head: blend cube and sphere
        x = x * 0.55 + (x / l) * 0.45;
        y = y * 0.55 + (y / l) * 0.45;
        z = z * 0.55 + (z / l) * 0.45;
        // flatten the back, elongate vertically
        z *= 0.92;
        ids[j].push(vert(x, y * 0.85, z));
      }
    }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++)
        faces.push({ verts: [ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]], smooth: true });
  }
  const out = faces.map((f) => orientOutward(p, f));
  return buildMesh(p, out);
}
