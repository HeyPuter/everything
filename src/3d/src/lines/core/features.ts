// View-dependent feature edges of a polygon mesh (world space): silhouettes, borders, creases,
// ridges & valleys, material boundaries, edge marks, loose edges, smooth silhouettes and
// suggestive contours (the last two cut through faces as iso-lines of per-vertex values).
// Pure: no DOM, no three.js scene; shared by the line renderer and the Line Art modifier.
import { edgeTopology } from '../../mesh/mesh';

export const F = {
  SILHOUETTE: 1,
  BORDER: 2,
  CREASE: 4,
  RIDGE_VALLEY: 8,
  SUGGESTIVE: 16,
  MATERIAL: 32,
  EDGE_MARK: 64,
  CONTOUR: 128,
  EXTERNAL_CONTOUR: 256,
  LOOSE: 512,
  INTERSECTION: 1024,
  LIGHT_CONTOUR: 2048,
} as const;

export interface FeatureMesh {
  /** world-space positions */
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  material_index?: Uint16Array;
  smooth?: Uint8Array;
  /** per corner: edge marked */
  edgeMarks?: Uint8Array;
  /** per face: face marked */
  faceMarks?: Uint8Array;
  /** per corner: the edge always counts as a crease (e.g. marked sharp) */
  creaseMarks?: Uint32Array | Uint8Array;
  looseEdges?: Uint32Array;
  /** index of the object in the scene list */
  object: number;
  /** override of the crease angle (dihedral angle between the faces, radians) */
  creaseAngle?: number;
}

export interface ViewInfo {
  ortho: boolean;
  /** camera position (perspective) */
  eye: [number, number, number];
  /** camera forward direction (orthographic) */
  dir: [number, number, number];
}

export interface FeatureOptions {
  /** an edge is a crease when its faces meet at less than this angle (π = flat) */
  creaseAngle: number;
  ridgesValleys?: boolean;
  suggestive?: boolean;
  materialBoundaries?: boolean;
  /** smooth faces get silhouettes interpolated through the faces */
  smoothness?: boolean;
  loose?: boolean;
  /** suggestive contours: minimum strength of the curvature derivative */
  krEpsilon?: number;
  /** suggestive contours: size of the neighbourhood curvature is measured over (world units) */
  sphereRadius?: number;
  /** suggestive contours: lines are kept where the surface faces the viewer at most this much (cos) */
  suggestiveLimit?: number;
}

export interface FeatureEdge {
  /** endpoint ids within the object (vertices, or nv + edge index for points inside edges) */
  ia: number;
  ib: number;
  pa: [number, number, number];
  pb: [number, number, number];
  flags: number;
  object: number;
  /** adjacent faces (-1 when none) */
  f0: number;
  f1: number;
  /** angle between the two faces (π = flat), for creases */
  angle: number;
  /** curvature estimate (normal turn per unit length) */
  curvature: number;
  /** material slots of the faces */
  m0: number;
  m1: number;
  /** a point on the inner side of the line (front face centre), for one-sided thickness */
  inner?: [number, number, number];
  /** vertex group weights at the two ends (Line Art weight transfer) */
  wa?: Record<string, number>;
  wb?: Record<string, number>;
}

const sub = (P: Float32Array, a: number, b: number, o: number[]) => {
  o[0] = P[a * 3] - P[b * 3];
  o[1] = P[a * 3 + 1] - P[b * 3 + 1];
  o[2] = P[a * 3 + 2] - P[b * 3 + 2];
};

/** Face normals (Newell) and centres. */
export function faceGeometry(m: FeatureMesh): { normals: Float32Array; centers: Float32Array } {
  const nf = m.offsets.length - 1;
  const N = new Float32Array(nf * 3),
    C = new Float32Array(nf * 3);
  const P = m.positions;
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    let nx = 0,
      ny = 0,
      nz = 0,
      cx = 0,
      cy = 0,
      cz = 0;
    for (let c = s; c < e; c++) {
      const a = m.indices[c] * 3,
        b = m.indices[c + 1 < e ? c + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
      cx += P[a];
      cy += P[a + 1];
      cz += P[a + 2];
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    N[f * 3] = nx / l;
    N[f * 3 + 1] = ny / l;
    N[f * 3 + 2] = nz / l;
    const k = Math.max(1, e - s);
    C[f * 3] = cx / k;
    C[f * 3 + 1] = cy / k;
    C[f * 3 + 2] = cz / k;
  }
  return { normals: N, centers: C };
}

/** Unit vector from a point towards the viewer. */
function toViewer(v: ViewInfo, x: number, y: number, z: number, out: number[]) {
  if (v.ortho) {
    out[0] = -v.dir[0];
    out[1] = -v.dir[1];
    out[2] = -v.dir[2];
    return;
  }
  const dx = v.eye[0] - x,
    dy = v.eye[1] - y,
    dz = v.eye[2] - z;
  const l = Math.hypot(dx, dy, dz) || 1;
  out[0] = dx / l;
  out[1] = dy / l;
  out[2] = dz / l;
}

/** Angle-weighted vertex normals. */
function vertexNormals(m: FeatureMesh, faceN: Float32Array): Float32Array {
  const P = m.positions;
  const VN = new Float32Array(P.length);
  const e1 = [0, 0, 0],
    e2 = [0, 0, 0];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let c = s; c < e; c++) {
      const v = m.indices[c],
        prev = m.indices[c === s ? e - 1 : c - 1],
        next = m.indices[c + 1 < e ? c + 1 : s];
      sub(P, prev, v, e1);
      sub(P, next, v, e2);
      const l1 = Math.hypot(e1[0], e1[1], e1[2]),
        l2 = Math.hypot(e2[0], e2[1], e2[2]);
      const w = l1 > 0 && l2 > 0 ? Math.acos(Math.max(-1, Math.min(1, (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (l1 * l2)))) : 0;
      VN[v * 3] += faceN[f * 3] * w;
      VN[v * 3 + 1] += faceN[f * 3 + 1] * w;
      VN[v * 3 + 2] += faceN[f * 3 + 2] * w;
    }
  }
  for (let i = 0; i < VN.length; i += 3) {
    const l = Math.hypot(VN[i], VN[i + 1], VN[i + 2]) || 1;
    VN[i] /= l;
    VN[i + 1] /= l;
    VN[i + 2] /= l;
  }
  return VN;
}

/**
 * Iso-line of a per-vertex scalar through polygon faces: for each face (passing `keep`) the
 * zero crossings along its boundary are paired into segments. Endpoint ids are nv + edge index,
 * so segments of neighbouring faces join up.
 */
function isoSegments(m: FeatureMesh, value: Float32Array, keep: (f: number) => boolean, flags: number, out: FeatureEdge[], extra?: (f: number) => Partial<FeatureEdge>) {
  const et = edgeTopology(m);
  const nv = m.positions.length / 3;
  const P = m.positions;
  const cross: { id: number; p: [number, number, number] }[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    if (!keep(f)) continue;
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    cross.length = 0;
    for (let c = s; c < e; c++) {
      const a = m.indices[c],
        b = m.indices[c + 1 < e ? c + 1 : s];
      const va = value[a],
        vb = value[b];
      if (va < 0 === vb < 0) continue;
      const t = va / (va - vb);
      cross.push({ id: nv + et.cornerEdge[c], p: [P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t] });
    }
    for (let i = 0; i + 1 < cross.length; i += 2) {
      const A = cross[i],
        B = cross[i + 1];
      const mi = m.material_index?.[f] ?? 0;
      out.push({ ia: A.id, ib: B.id, pa: A.p, pb: B.p, flags, object: m.object, f0: f, f1: -1, angle: Math.PI, curvature: 0, m0: mi, m1: mi, ...extra?.(f) });
    }
  }
}

/** Feature edges of one mesh as seen from a viewpoint. */
export function extractFeatures(m: FeatureMesh, view: ViewInfo, o: FeatureOptions): FeatureEdge[] {
  const out: FeatureEdge[] = [];
  const P = m.positions;
  const nf = m.offsets.length - 1;
  const { normals: N, centers: C } = faceGeometry(m);
  // front-facing flag per face
  const front = new Uint8Array(nf);
  const tv = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    toViewer(view, C[f * 3], C[f * 3 + 1], C[f * 3 + 2], tv);
    front[f] = N[f * 3] * tv[0] + N[f * 3 + 1] * tv[1] + N[f * 3 + 2] * tv[2] > 0 ? 1 : 0;
  }
  const smoothSil = !!o.smoothness && !!m.smooth;
  const isSmooth = (f: number) => smoothSil && !!m.smooth![f];
  const et = edgeTopology(m);
  const ne = et.count;
  const angleOf = new Float32Array(ne).fill(Math.PI);
  const turn = new Float32Array(ne);
  const creaseLimit = m.creaseAngle ?? o.creaseAngle;
  // per vertex: mean normal turn of incident edges (ridges & valleys stand out from it)
  const vTurn = o.ridgesValleys ? new Float32Array(P.length / 3) : null;
  const vCount = o.ridgesValleys ? new Uint16Array(P.length / 3) : null;
  for (let e = 0; e < ne; e++) {
    const k0 = et.faceOffsets[e],
      k1 = et.faceOffsets[e + 1];
    if (k1 - k0 !== 2) continue;
    const a = et.faces[k0],
      b = et.faces[k0 + 1];
    const d = Math.max(-1, Math.min(1, N[a * 3] * N[b * 3] + N[a * 3 + 1] * N[b * 3 + 1] + N[a * 3 + 2] * N[b * 3 + 2]));
    const t = Math.acos(d);
    turn[e] = t;
    angleOf[e] = Math.PI - t;
    if (vTurn && vCount) {
      const va = et.verts[e * 2],
        vb = et.verts[e * 2 + 1];
      vTurn[va] += t;
      vTurn[vb] += t;
      vCount[va]++;
      vCount[vb]++;
    }
  }
  // corners per edge (for the edge marks, any corner counts)
  const marked = m.edgeMarks ? new Uint8Array(ne) : null;
  if (marked) for (let c = 0; c < m.indices.length; c++) if (m.edgeMarks![c]) marked[et.cornerEdge[c]] = 1;
  const forced = m.creaseMarks ? new Uint8Array(ne) : null;
  if (forced) for (let c = 0; c < m.indices.length; c++) if (m.creaseMarks![c]) forced[et.cornerEdge[c]] = 1;
  for (let e = 0; e < ne; e++) {
    const k0 = et.faceOffsets[e],
      k1 = et.faceOffsets[e + 1];
    const nfaces = k1 - k0;
    const f0 = nfaces > 0 ? et.faces[k0] : -1,
      f1 = nfaces > 1 ? et.faces[k0 + 1] : -1;
    let flags = 0;
    let inner: [number, number, number] | undefined;
    if (nfaces === 1) {
      flags |= F.BORDER;
      inner = [C[f0 * 3], C[f0 * 3 + 1], C[f0 * 3 + 2]];
    } else if (nfaces >= 2) {
      let nFront = 0,
        frontFace = -1;
      for (let k = k0; k < k1; k++)
        if (front[et.faces[k]]) {
          nFront++;
          frontFace = et.faces[k];
        }
      // smooth faces on both sides: the silhouette runs through the faces instead
      if (nFront > 0 && nFront < nfaces && !(isSmooth(f0) && isSmooth(f1))) {
        flags |= F.SILHOUETTE;
        inner = [C[frontFace * 3], C[frontFace * 3 + 1], C[frontFace * 3 + 2]];
      }
      if (nfaces === 2) {
        if (angleOf[e] < creaseLimit || forced?.[e]) flags |= F.CREASE;
        if (o.materialBoundaries !== false && (m.material_index?.[f0] ?? 0) !== (m.material_index?.[f1] ?? 0)) flags |= F.MATERIAL;
        if (vTurn && vCount && turn[e] > (3 * Math.PI) / 180 && !(flags & F.CREASE)) {
          const va = et.verts[e * 2],
            vb = et.verts[e * 2 + 1];
          const mean = Math.max(vTurn[va] / Math.max(1, vCount[va]), vTurn[vb] / Math.max(1, vCount[vb]));
          if (turn[e] >= mean * 1.25) flags |= F.RIDGE_VALLEY;
        }
      }
    }
    if (marked?.[e]) flags |= F.EDGE_MARK;
    if (!flags) continue;
    const va = et.verts[e * 2],
      vb = et.verts[e * 2 + 1];
    const len = Math.hypot(P[va * 3] - P[vb * 3], P[va * 3 + 1] - P[vb * 3 + 1], P[va * 3 + 2] - P[vb * 3 + 2]) || 1;
    out.push({
      ia: va,
      ib: vb,
      pa: [P[va * 3], P[va * 3 + 1], P[va * 3 + 2]],
      pb: [P[vb * 3], P[vb * 3 + 1], P[vb * 3 + 2]],
      flags,
      object: m.object,
      f0,
      f1,
      angle: angleOf[e],
      curvature: turn[e] / len,
      m0: f0 >= 0 ? m.material_index?.[f0] ?? 0 : 0,
      m1: f1 >= 0 ? m.material_index?.[f1] ?? 0 : f0 >= 0 ? m.material_index?.[f0] ?? 0 : 0,
      inner,
    });
  }
  if (o.loose && m.looseEdges)
    for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
      const a = m.looseEdges[i],
        b = m.looseEdges[i + 1];
      out.push({ ia: a, ib: b, pa: [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], pb: [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], flags: F.LOOSE, object: m.object, f0: -1, f1: -1, angle: Math.PI, curvature: 0, m0: 0, m1: 0 });
    }
  const needVN = smoothSil || o.suggestive;
  if (needVN) {
    const VN = vertexNormals(m, N);
    const nv = P.length / 3;
    // n·v per vertex
    const ndv = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      toViewer(view, P[v * 3], P[v * 3 + 1], P[v * 3 + 2], tv);
      ndv[v] = VN[v * 3] * tv[0] + VN[v * 3 + 1] * tv[1] + VN[v * 3 + 2] * tv[2];
    }
    if (smoothSil)
      isoSegments(m, ndv, (f) => isSmooth(f), F.SILHOUETTE, out, (f) => ({ inner: undefined, f1: f }));
    if (o.suggestive) suggestiveContours(m, VN, ndv, view, o, N, out);
  }
  return out;
}

/**
 * Suggestive contours: where the derivative of n·v along the projected view direction crosses
 * zero on surfaces that face the viewer (the lines continue silhouettes into concave areas).
 */
function suggestiveContours(m: FeatureMesh, VN: Float32Array, ndv: Float32Array, view: ViewInfo, o: FeatureOptions, faceN: Float32Array, out: FeatureEdge[]) {
  const P = m.positions;
  const nv = P.length / 3;
  // gradient of n·v per face (least squares on the polygon, through its fan triangles), averaged to vertices
  const G = new Float32Array(nv * 3),
    W = new Float32Array(nv);
  const e1 = [0, 0, 0],
    e2 = [0, 0, 0];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const a = m.indices[s];
    for (let c = s + 1; c + 1 < e; c++) {
      const b = m.indices[c],
        d = m.indices[c + 1];
      sub(P, b, a, e1);
      sub(P, d, a, e2);
      // triangle normal (unnormalised, |n| = 2 area)
      const nx = e1[1] * e2[2] - e1[2] * e2[1],
        ny = e1[2] * e2[0] - e1[0] * e2[2],
        nz = e1[0] * e2[1] - e1[1] * e2[0];
      const area2 = nx * nx + ny * ny + nz * nz;
      if (area2 < 1e-20) continue;
      // grad f = ((fb - fa) (n × e2) + (fd - fa) (e1 × n)) / |n|²
      const fa = ndv[a],
        fb = ndv[b] - fa,
        fd = ndv[d] - fa;
      const c1x = ny * e2[2] - nz * e2[1],
        c1y = nz * e2[0] - nx * e2[2],
        c1z = nx * e2[1] - ny * e2[0];
      const c2x = e1[1] * nz - e1[2] * ny,
        c2y = e1[2] * nx - e1[0] * nz,
        c2z = e1[0] * ny - e1[1] * nx;
      const gx = (fb * c1x + fd * c2x) / area2,
        gy = (fb * c1y + fd * c2y) / area2,
        gz = (fb * c1z + fd * c2z) / area2;
      const w = Math.sqrt(area2);
      for (const v of [a, b, d]) {
        G[v * 3] += gx * w;
        G[v * 3 + 1] += gy * w;
        G[v * 3 + 2] += gz * w;
        W[v] += w;
      }
    }
  }
  void faceN;
  const Dw = new Float32Array(nv);
  const tv = [0, 0, 0];
  for (let v = 0; v < nv; v++) {
    if (!W[v]) continue;
    toViewer(view, P[v * 3], P[v * 3 + 1], P[v * 3 + 2], tv);
    const n0 = VN[v * 3],
      n1 = VN[v * 3 + 1],
      n2 = VN[v * 3 + 2];
    const d = tv[0] * n0 + tv[1] * n1 + tv[2] * n2;
    // view direction projected into the tangent plane
    const wx = tv[0] - d * n0,
      wy = tv[1] - d * n1,
      wz = tv[2] - d * n2;
    Dw[v] = (G[v * 3] * wx + G[v * 3 + 1] * wy + G[v * 3 + 2] * wz) / W[v];
  }
  // curvature is measured over a neighbourhood of about the sphere radius: smooth the derivative
  // over as many rings of neighbours as fit in it
  if (o.sphereRadius && o.sphereRadius > 0) {
    const et = edgeTopology(m);
    let total = 0;
    for (let e = 0; e < et.count; e++) {
      const a = et.verts[e * 2],
        b = et.verts[e * 2 + 1];
      total += Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    }
    const mean = total / Math.max(1, et.count);
    const rings = Math.min(6, Math.floor(o.sphereRadius / Math.max(1e-9, mean)));
    for (let it = 0; it < rings; it++) {
      const sum = new Float32Array(nv),
        cnt = new Float32Array(nv);
      for (let e = 0; e < et.count; e++) {
        const a = et.verts[e * 2],
          b = et.verts[e * 2 + 1];
        sum[a] += Dw[b];
        sum[b] += Dw[a];
        cnt[a]++;
        cnt[b]++;
      }
      for (let v = 0; v < nv; v++) if (cnt[v]) Dw[v] = (Dw[v] + sum[v]) / (cnt[v] + 1);
    }
  }
  const limit = o.suggestiveLimit ?? 0.6;
  const eps = Math.max(0, o.krEpsilon ?? 0);
  isoSegments(m, Dw, (f) => {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    // only where the surface faces the viewer, not too frontally, and the derivative changes clearly
    let lo = Infinity,
      hi = -Infinity,
      minD = Infinity,
      maxD = -Infinity;
    for (let c = s; c < e; c++) {
      const v = m.indices[c];
      lo = Math.min(lo, ndv[v]);
      hi = Math.max(hi, ndv[v]);
      minD = Math.min(minD, Dw[v]);
      maxD = Math.max(maxD, Dw[v]);
    }
    return lo > 0 && hi < limit && maxD - minD > eps;
  }, F.SUGGESTIVE, out);
}

/** Map edge marks of the original mesh onto an evaluated mesh (by original vertex indices). */
export function mapEdgeMarks(orig: { offsets: Uint32Array; indices: Uint32Array; freestyle_edge?: Uint8Array }, evalMesh: { offsets: Uint32Array; indices: Uint32Array; origIndex?: Int32Array }, sameTopology: boolean): Uint8Array | undefined {
  const marks = orig.freestyle_edge;
  if (!marks || !marks.some(Boolean)) return undefined;
  if (sameTopology && marks.length === evalMesh.indices.length) return marks;
  const keys = new Set<string>();
  for (let f = 0; f < orig.offsets.length - 1; f++) {
    const s = orig.offsets[f],
      e = orig.offsets[f + 1];
    for (let c = s; c < e; c++)
      if (marks[c]) {
        const a = orig.indices[c],
          b = orig.indices[c + 1 < e ? c + 1 : s];
        keys.add(a < b ? `${a}:${b}` : `${b}:${a}`);
      }
  }
  const oi = evalMesh.origIndex;
  const out = new Uint8Array(evalMesh.indices.length);
  let any = false;
  for (let f = 0; f < evalMesh.offsets.length - 1; f++) {
    const s = evalMesh.offsets[f],
      e = evalMesh.offsets[f + 1];
    for (let c = s; c < e; c++) {
      let a = evalMesh.indices[c],
        b = evalMesh.indices[c + 1 < e ? c + 1 : s];
      if (oi) {
        a = oi[a];
        b = oi[b];
        if (a < 0 || b < 0) continue;
      }
      if (keys.has(a < b ? `${a}:${b}` : `${b}:${a}`)) {
        out[c] = 1;
        any = true;
      }
    }
  }
  return any ? out : undefined;
}
