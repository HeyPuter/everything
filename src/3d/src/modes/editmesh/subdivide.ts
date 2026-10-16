// Subdivide: split the selected edges into equal parts and re-fill each touched face with a
// pattern that depends on which of its edges were cut. Smoothing bends the new vertices onto
// circular arcs that follow the surface normals at the edge ends.
import { Vector3 } from 'three';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { V } from './geom';

export interface SubdivideOptions {
  /** how a quad with two adjacent cut edges is split */
  quadcorner?: 'INNERVERT' | 'PATH' | 'STRAIGHT_CUT' | 'FAN';
  /** allow faces with more than four corners in the result (otherwise patterns use triangles) */
  ngon?: boolean;
  fractal?: number;
  fractalAlongNormal?: number;
  seed?: number;
}

/** Vertex normals weighted by the corner angle of each face (stable on uneven tessellation). */
export function angleWeightedNormals(m: MeshEdit): Vector3[] {
  const out = Array.from({ length: m.vcount }, () => new Vector3());
  const e1 = new Vector3(),
    e2 = new Vector3();
  for (const f of m.faces) {
    const n = V(m.faceNormal(f));
    const k = f.verts.length;
    for (let i = 0; i < k; i++) {
      const p = V(m.p(f.verts[i]));
      e1.copy(V(m.p(f.verts[(i + k - 1) % k]))).sub(p);
      e2.copy(V(m.p(f.verts[(i + 1) % k]))).sub(p);
      const a = e1.lengthSq() && e2.lengthSq() ? e1.angleTo(e2) : 0;
      out[f.verts[i]].addScaledVector(n, a);
    }
  }
  for (const n of out) if (n.lengthSq() > 1e-20) n.normalize();
  return out;
}

/**
 * Point at parameter `t` on a circular arc from `a` to `b` whose normal at `a` is `na`, with the
 * normal at `b` mirrored from it across the plane halfway between the ends. Straight when the
 * normals are (nearly) perpendicular to the edge.
 */
function arcPoint(a: Vector3, na: Vector3, b: Vector3, nb: Vector3, t: number): Vector3 {
  const ab = a.clone().sub(b);
  const den = na.dot(ab);
  if (na.distanceToSquared(nb) < 1e-5 || Math.abs(den) < 1e-12) return a.clone().lerp(b, t);
  const s = -(ab.lengthSq() / 2) / den;
  const c = a.clone().addScaledVector(na, s);
  const u = a.clone().sub(c),
    v = b.clone().sub(c);
  const om = u.angleTo(v);
  if (om < 1e-6) return a.clone().lerp(b, t);
  const so = Math.sin(om);
  return c.addScaledVector(u, Math.sin((1 - t) * om) / so).addScaledVector(v, Math.sin(t * om) / so);
}

const reflect = (n: Vector3, d: Vector3) => n.clone().addScaledVector(d, -2 * n.dot(d));

/** Smoothed position between two vertices: blend of the arcs tangent at either end, mixed with the straight line by `smooth`. */
export function smoothEdgePoint(a: Vector3, na: Vector3, b: Vector3, nb: Vector3, t: number, smooth: number): Vector3 {
  const flat = a.clone().lerp(b, t);
  if (!smooth) return flat;
  const d = a.clone().sub(b).normalize();
  const pa = arcPoint(a, na, b, reflect(na, d), t);
  const pb = arcPoint(a, reflect(nb, d), b, nb, t);
  return flat.lerp(pa.lerp(pb, t), smooth);
}

/** A vertex of a face pattern: its index and its weights over the original face corners. */
interface PV {
  v: number;
  w: number[];
}

export function subdivide(m: MeshEdit, cuts: number, smoothness: number, opts: SubdivideOptions = {}): boolean {
  const firstNew = m.vcount;
  const selEdges = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  if (!selEdges.size || cuts < 1) return false;
  const ngon = opts.ngon !== false;
  const normals: Vector3[] = smoothness ? angleWeightedNormals(m) : [];
  const nrm = (v: number) => normals[v] ?? new Vector3();
  /** a new vertex between two existing ones (smoothed along their normals) */
  const between = (a: number, b: number, t: number, sel = 1) => {
    const pa = V(m.p(a)),
      pb = V(m.p(b));
    const p = smoothness ? smoothEdgePoint(pa, nrm(a), pb, nrm(b), t, smoothness) : pa.lerp(pb, t);
    const id = m.addVert([p.x, p.y, p.z], [[a, 1 - t], [b, t]], sel);
    if (smoothness) normals[id] = nrm(a).clone().lerp(nrm(b), t).normalize();
    return id;
  };
  // new vertices along each selected edge, ordered from the lower to the higher vertex index
  const edgeVerts = new Map<string, number[]>();
  for (const k of selEdges) {
    const [a, b] = k.split(':').map(Number);
    edgeVerts.set(k, Array.from({ length: cuts }, (_, c) => between(a, b, (c + 1) / (cuts + 1))));
  }
  const along = (a: number, b: number): number[] => {
    const l = edgeVerts.get(edgeKey(a, b));
    if (!l) return [];
    return a < b ? l : [...l].reverse();
  };

  const out: EFace[] = [];
  for (const f of m.faces) {
    const n = f.verts.length;
    const cut = f.verts.map((v, i) => selEdges.has(edgeKey(v, f.verts[(i + 1) % n])));
    const ncut = cut.filter(Boolean).length;
    if (!ncut) {
      out.push(f);
      continue;
    }
    const corner = (i: number): PV => ({ v: f.verts[i % n], w: f.verts.map((_, j) => (j === i % n ? 1 : 0)) });
    const mix = (p: PV, q: PV, t: number): number[] => p.w.map((x, j) => x * (1 - t) + q.w[j] * t);
    /** corners and cut points of edge i, from corner i to corner i+1 */
    const side = (i: number): PV[] => {
      const a = corner(i),
        b = corner(i + 1);
      const pts = along(a.v, b.v);
      return [a, ...pts.map((v, k) => ({ v, w: mix(a, b, (k + 1) / (pts.length + 1)) })), b];
    };
    /** a new vertex halfway along a pattern line */
    const mid = (p: PV, q: PV, t = 0.5): PV => ({ v: between(p.v, q.v, t), w: mix(p, q, t) });
    const faces: PV[][] = [];
    const add = (...vs: PV[]) => faces.push(vs);
    const reversed = (l: PV[]) => [...l].reverse();

    if (n === 4 && ncut === 4) {
      // grid: inner points lie on lines from the cut points of edge 0 to those of edge 2
      const N = cuts + 1;
      const s0 = side(0),
        s2r = reversed(side(2)),
        s3r = reversed(side(3)),
        s1 = side(1);
      const cols = s0.map((top, i) => (i === 0 ? s3r : i === N ? s1 : [top, ...Array.from({ length: N - 1 }, (_, j) => mid(top, s2r[i], (j + 1) / N)), s2r[i]]));
      const grid: PV[][] = Array.from({ length: N + 1 }, (_, j) => cols.map((c) => c[j]));
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) add(grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]);
    } else if (n === 3 && ncut === 3) {
      // triangular grid: row j runs from edge 2 (reversed) to edge 1
      const N = cuts + 1;
      const s0 = side(0),
        s1 = side(1),
        s2r = reversed(side(2));
      const rows: PV[][] = [s0];
      for (let j = 1; j < N; j++) {
        const l = s2r[j],
          r = s1[j];
        const k = N - j;
        const row = [l];
        for (let i = 1; i < k; i++) row.push(mid(l, r, i / k));
        row.push(r);
        rows.push(row);
      }
      rows.push([corner(2)]);
      for (let j = 0; j < N; j++) {
        const lo = rows[j],
          hi = rows[j + 1];
        for (let i = 0; i < lo.length - 1; i++) {
          add(lo[i], lo[i + 1], hi[i]);
          if (i < hi.length - 1) add(lo[i + 1], hi[i + 1], hi[i]);
        }
      }
    } else if (n === 4 && ncut === 2 && cut[0] === cut[2]) {
      // two opposite cut edges: a strip of quads across the face
      const k = cut[0] ? 0 : 1;
      const top = side(k),
        bottom = reversed(side(k + 2));
      for (let j = 0; j < cuts + 1; j++) add(top[j], top[j + 1], bottom[j + 1], bottom[j]);
    } else if (n === 4 && ncut === 2) {
      // two adjacent cut edges around corner c (cut edges b→c and c→a, o opposite)
      const ci = [0, 1, 2, 3].find((i) => cut[(i + 3) % 4] && cut[i])!;
      const c = corner(ci),
        a = corner(ci + 1),
        o = corner(ci + 2),
        b = corner(ci + 3);
      const ca = side(ci).slice(1, -1),
        cb = reversed(side(ci + 3)).slice(1, -1);
      let mode = opts.quadcorner ?? 'STRAIGHT_CUT';
      if (mode === 'STRAIGHT_CUT' && !ngon) mode = 'INNERVERT';
      if (mode === 'FAN') {
        add(c, ca[0], o, cb[0]);
        const sa = [...ca, a],
          sb = [...cb, b];
        for (let j = 0; j < cuts; j++) add(sa[j], sa[j + 1], o);
        for (let j = 0; j < cuts; j++) add(sb[j + 1], sb[j], o);
      } else if (mode === 'INNERVERT') {
        const inner = ca.map((p, j) => mid(p, cb[j]));
        add(ca[0], inner[0], cb[0], c);
        for (let j = 0; j < cuts - 1; j++) {
          add(ca[j + 1], inner[j + 1], inner[j], ca[j]);
          add(inner[j + 1], cb[j + 1], cb[j], inner[j]);
        }
        add(a, o, inner[cuts - 1], ca[cuts - 1]);
        add(o, b, cb[cuts - 1], inner[cuts - 1]);
      } else {
        add(ca[0], cb[0], c);
        for (let j = 0; j < cuts - 1; j++) add(ca[j + 1], cb[j + 1], cb[j], ca[j]);
        if (mode === 'PATH') {
          add(b, cb[cuts - 1], ca[cuts - 1], a);
          add(o, b, a);
        } else add(o, b, cb[cuts - 1], ca[cuts - 1], a);
      }
    } else if (!ngon && n === 4 && ncut === 1) {
      // one cut edge: the cut points fan out to the two far corners, meeting in the middle
      const i = cut.indexOf(true);
      const P = side(i);
      const far0 = corner(i + 3),
        far1 = corner(i + 2);
      const segs = cuts + 1;
      if (segs % 2) {
        const mj = (segs - 1) / 2;
        for (let j = 0; j < segs; j++) {
          if (j < mj) add(P[j], P[j + 1], far0);
          else if (j > mj) add(P[j], P[j + 1], far1);
          else add(P[j], P[j + 1], far1, far0);
        }
      } else {
        const mi = segs / 2;
        for (let j = 0; j < segs; j++) add(P[j], P[j + 1], j < mi ? far0 : far1);
        add(far0, P[mi], far1);
      }
    } else if (!ngon && n === 3 && ncut === 1) {
      const i = cut.indexOf(true);
      const P = side(i);
      const far = corner(i + 2);
      for (let j = 0; j < cuts + 1; j++) add(P[j], P[j + 1], far);
    } else {
      // insert the cut points into the face outline
      const ring: PV[] = [];
      for (let i = 0; i < n; i++) ring.push(...side(i).slice(0, -1));
      add(...ring);
    }
    for (const vs of faces) out.push(patternFace(m, f, vs));
  }
  m.faces = out;
  if (opts.fractal) applyFractal(m, selEdges, firstNew, opts);
  return true;
}

/** Build a face of a pattern, interpolating corner data from the original face and keeping flags on its outline. */
function patternFace(m: MeshEdit, f: EFace, vs: PV[]): EFace {
  const n = f.verts.length;
  const uvs: number[] = [];
  for (const p of vs) for (const k of [0, 1]) uvs.push(p.w.reduce((s, w, j) => s + w * f.uvs[j * 2 + k], 0));
  const nf = m.makeFace(
    vs.map((p) => p.v),
    f,
    uvs,
  );
  if (f.colors) nf.colors = vs.flatMap((p) => [0, 1, 2, 3].map((k) => p.w.reduce((s, w, j) => s + w * f.colors![j * 4 + k], 0)));
  // an edge of the pattern on original edge i (both ends have weight only on corners i, i+1) keeps its flags
  const onEdge = (p: PV) => {
    const nz = p.w.flatMap((w, j) => (w > 1e-9 ? [j] : []));
    return nz;
  };
  vs.forEach((p, k) => {
    const q = vs[(k + 1) % vs.length];
    const a = onEdge(p),
      b = onEdge(q);
    const set = new Set([...a, ...b]);
    if (set.size > 2) return;
    const [i, j] = [...set].sort((x, y) => x - y);
    const e = set.size === 1 ? -1 : j === i + 1 ? i : i === 0 && j === n - 1 ? n - 1 : -1;
    if (e < 0) return;
    nf.seams[k] = f.seams[e];
    nf.sharp[k] = f.sharp[e];
    nf.creases[k] = f.creases[e];
  });
  return nf;
}

function applyFractal(m: MeshEdit, selEdges: Set<string>, firstNew: number, opts: SubdivideOptions) {
  // random displacement of the new vertices, scaled by the average selected edge length
  let len = 0;
  for (const k of selEdges) {
    const [a, b] = k.split(':').map(Number);
    len += V(m.p(a)).distanceTo(V(m.p(b)));
  }
  len /= selEdges.size;
  let s = ((opts.seed ?? 0) * 2654435761 + 1) >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
  const normals = new Map<number, Vector3>();
  for (const f of m.faces) {
    const nrm = V(m.faceNormal(f));
    for (const v of f.verts) if (v >= firstNew) (normals.get(v) ?? normals.set(v, new Vector3()).get(v)!).add(nrm);
  }
  const along = opts.fractalAlongNormal ?? 0;
  for (let v = firstNew; v < m.vcount; v++) {
    const d = new Vector3(rnd(), rnd(), rnd());
    const nrm = (normals.get(v) ?? new Vector3()).normalize();
    if (along) d.lerp(nrm.multiplyScalar(rnd()), along);
    const p = V(m.p(v)).addScaledVector(d, ((opts.fractal ?? 0) * len) / 10);
    m.setP(v, [p.x, p.y, p.z]);
  }
}
