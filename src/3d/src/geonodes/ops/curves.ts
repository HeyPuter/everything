// Curve operations: Curve to Mesh, Resample, Fill, Curve to Points.
import { CurvesComponent, MeshComponent, PointsComponent, allocData, dataComps, type AttrMap } from '../geometry';
import { curveLengths, curveNormals, curveTangents, eulerFromAxes } from '../curveutil';
import { triangulatePoly } from '../../mesh/mesh';
import { MeshBuild } from './primitives';

/** Sweep each profile curve along each curve (no profile → edges along the curves). */
export function curveToMesh(curve: CurvesComponent, profile: CurvesComponent | undefined, scale: Float32Array, fillCaps: boolean): MeshComponent {
  const P = curve.positions;
  const T = curveTangents(curve),
    N = curveNormals(curve, T);
  const radius = curve.attrs.get('radius');
  const pointAttrs: [string, { type: import('../types').DataType; data: import('../types').AttrArray }][] = [];
  for (const [name, a] of curve.attrs) if (a.domain === 'POINT' && name !== 'radius' && name !== 'tilt') pointAttrs.push([name, a]);
  const b = new MeshBuild();
  const vsrc: number[] = []; // curve point per new vertex
  if (!profile || !profile.pointCount) {
    for (let k = 0; k < curve.curveCount; k++) {
      const s = curve.curveOffsets[k],
        e = curve.curveOffsets[k + 1];
      const base = b.pos.length / 3;
      for (let i = s; i < e; i++) {
        b.vert(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        vsrc.push(i);
      }
      for (let i = 0; i + 1 < e - s; i++) b.edge(base + i, base + i + 1);
      if (curve.cyclic[k] && e - s > 2) b.edge(base + e - s - 1, base);
    }
  } else {
    const PP = profile.positions;
    for (let k = 0; k < curve.curveCount; k++) {
      const s = curve.curveOffsets[k],
        e = curve.curveOffsets[k + 1],
        nc = e - s;
      const cyc = !!curve.cyclic[k];
      for (let q = 0; q < profile.curveCount; q++) {
        const ps = profile.curveOffsets[q],
          pe = profile.curveOffsets[q + 1],
          np = pe - ps;
        const pcyc = !!profile.cyclic[q];
        const base = b.pos.length / 3;
        for (let i = s; i < e; i++) {
          const t = [T[i * 3], T[i * 3 + 1], T[i * 3 + 2]],
            n = [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
          const bn = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
          const sc = scale[i] * (radius ? radius.data[i] : 1);
          for (let j = ps; j < pe; j++) {
            const x = PP[j * 3] * sc,
              y = PP[j * 3 + 1] * sc,
              z = PP[j * 3 + 2] * sc;
            b.vert(P[i * 3] + n[0] * x + bn[0] * y + t[0] * z, P[i * 3 + 1] + n[1] * x + bn[1] * y + t[1] * z, P[i * 3 + 2] + n[2] * x + bn[2] * y + t[2] * z);
            vsrc.push(i);
          }
        }
        const id = (i: number, j: number) => base + i * np + j;
        const segs = cyc ? nc : nc - 1,
          psegs = pcyc ? np : np - 1;
        if (np === 1) {
          for (let i = 0; i < segs; i++) b.edge(id(i, 0), id((i + 1) % nc, 0));
          continue;
        }
        for (let i = 0; i < segs; i++)
          for (let j = 0; j < psegs; j++) {
            const i1 = (i + 1) % nc,
              j1 = (j + 1) % np;
            b.face([id(i, j), id(i, j1), id(i1, j1), id(i1, j)]);
          }
        if (nc === 1) for (let j = 0; j < psegs; j++) b.edge(id(0, j), id(0, (j + 1) % np));
        if (fillCaps && pcyc && !cyc && np > 2 && nc > 1) {
          b.face(Array.from({ length: np }, (_, j) => id(0, np - 1 - j)));
          b.face(Array.from({ length: np }, (_, j) => id(nc - 1, j)));
        }
      }
    }
  }
  const mesh = b.build();
  for (const [name, a] of pointAttrs) {
    const comps = dataComps(a.type);
    const d = allocData(a.type, vsrc.length);
    vsrc.forEach((sIdx, i) => {
      for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[sIdx * comps + k];
    });
    mesh.attrs.set(name, { domain: 'POINT', type: a.type, data: d });
  }
  mesh.materials = [...curve.materials];
  return mesh;
}

/** Sample positions (and point attributes) along each curve. `counts` per curve (≥ 1). */
function sampleCurves(c: CurvesComponent, counts: Int32Array | null, sel: Uint8Array | null): CurvesComponent {
  const { segment, total } = curveLengths(c);
  const P = c.positions;
  const outPos: number[] = [];
  const offs: number[] = [0];
  const srcA: number[] = [],
    srcB: number[] = [],
    srcT: number[] = [];
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1],
      n = e - s;
    const cyc = !!c.cyclic[k];
    if ((sel && !sel[k]) || !counts || n < 2) {
      for (let i = s; i < e; i++) {
        outPos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        srcA.push(i);
        srcB.push(i);
        srcT.push(0);
      }
      offs.push(outPos.length / 3);
      continue;
    }
    const count = Math.max(1, counts[k]);
    const L = total[k];
    for (let q = 0; q < count; q++) {
      const d = cyc ? (L * q) / count : count > 1 ? (L * q) / (count - 1) : 0;
      // find segment containing distance d
      let i = s;
      while (i + 1 < e && segment[i + 1] < d) i++;
      let a = i,
        bIdx = i + 1 < e ? i + 1 : cyc ? s : i;
      let segLen = (i + 1 < e ? segment[i + 1] : L) - segment[i];
      if (!cyc && i + 1 >= e) {
        a = e - 1;
        bIdx = e - 1;
        segLen = 0;
      }
      const t = segLen > 0 ? Math.max(0, Math.min(1, (d - segment[a]) / segLen)) : 0;
      outPos.push(P[a * 3] + (P[bIdx * 3] - P[a * 3]) * t, P[a * 3 + 1] + (P[bIdx * 3 + 1] - P[a * 3 + 1]) * t, P[a * 3 + 2] + (P[bIdx * 3 + 2] - P[a * 3 + 2]) * t);
      srcA.push(a);
      srcB.push(bIdx);
      srcT.push(t);
    }
    offs.push(outPos.length / 3);
  }
  const attrs: AttrMap = new Map();
  for (const [name, a] of c.attrs) {
    if (a.domain === 'CURVE') {
      attrs.set(name, a);
      continue;
    }
    const comps = dataComps(a.type);
    const d = allocData(a.type, srcA.length);
    const isBool = a.type === 'BOOLEAN',
      isInt = a.type === 'INT';
    for (let i = 0; i < srcA.length; i++)
      for (let k = 0; k < comps; k++) {
        const v = a.data[srcA[i] * comps + k] * (1 - srcT[i]) + a.data[srcB[i] * comps + k] * srcT[i];
        d[i * comps + k] = isBool ? (v >= 0.5 ? 1 : 0) : isInt ? Math.round(v) : v;
      }
    attrs.set(name, { domain: 'POINT', type: a.type, data: d });
  }
  return new CurvesComponent(new Float32Array(outPos), Uint32Array.from(offs), new Uint8Array(c.cyclic), attrs, c.materials);
}

export function resampleCurves(c: CurvesComponent, mode: 'Count' | 'Length' | 'Evaluated', count: Int32Array, length: Float32Array, sel: Uint8Array | null, keepLast = true): CurvesComponent {
  if (mode === 'Evaluated') return c;
  if (mode === 'Count') return sampleCurves(c, count, sel);
  const { total } = curveLengths(c);
  const counts = new Int32Array(c.curveCount);
  for (let k = 0; k < c.curveCount; k++) {
    const l = Math.max(1e-6, length[k]);
    const cyc = !!c.cyclic[k];
    const segs = keepLast ? Math.ceil(total[k] / l - 1e-6) : Math.floor(total[k] / l + 1e-6);
    counts[k] = Math.max(cyc ? 1 : 2, cyc ? segs : segs + 1);
  }
  return sampleCurves(c, counts, sel);
}

export function curveToPoints(
  c: CurvesComponent,
  mode: 'EVALUATED' | 'COUNT' | 'LENGTH',
  count: Int32Array,
  length: Float32Array,
): {
  points: PointsComponent;
  tangent: Float32Array;
  normal: Float32Array;
  rotation: Float32Array;
} {
  const res = mode === 'EVALUATED' ? c : resampleCurves(c, mode === 'COUNT' ? 'Count' : 'Length', count, length, null);
  // non-cyclic resampled curves keep their end point; cyclic ones do not repeat the start
  const T = curveTangents(res),
    N = curveNormals(res, T);
  const n = res.pointCount;
  const rot = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = [T[i * 3], T[i * 3 + 1], T[i * 3 + 2]],
      nn = [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
    // X follows the tangent, Z the normal
    rot.set(eulerFromAxes(t, nn), i * 3);
  }
  const attrs: AttrMap = new Map();
  for (const [name, a] of res.attrs) {
    if (a.domain === 'POINT') attrs.set(name, a);
    else {
      const pc = res.pointCurve();
      const comps = dataComps(a.type);
      const d = allocData(a.type, n);
      for (let i = 0; i < n; i++) for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[pc[i] * comps + k];
      attrs.set(name, { domain: 'POINT', type: a.type, data: d });
    }
  }
  if (!attrs.has('radius'))
    attrs.set('radius', {
      domain: 'POINT',
      type: 'FLOAT',
      data: new Float32Array(n).fill(1),
    });
  return {
    points: new PointsComponent(res.positions, attrs, res.materials),
    tangent: T,
    normal: N,
    rotation: rot,
  };
}

/** Fill cyclic curves (projected onto the XY plane) with triangles or one n-gon each. */
export function fillCurves(c: CurvesComponent, ngons: boolean): MeshComponent {
  const b = new MeshBuild();
  const tmp: number[] = [];
  for (let k = 0; k < c.curveCount; k++) {
    const s = c.curveOffsets[k],
      e = c.curveOffsets[k + 1],
      n = e - s;
    if (n < 3) continue;
    const base = b.pos.length / 3;
    for (let i = s; i < e; i++) b.vert(c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]);
    // orient counter-clockwise when seen from +Z
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = s + i,
        bb = s + ((i + 1) % n);
      area += c.positions[a * 3] * c.positions[bb * 3 + 1] - c.positions[bb * 3] * c.positions[a * 3 + 1];
    }
    const order = Array.from({ length: n }, (_, i) => (area >= 0 ? i : n - 1 - i));
    if (ngons) {
      b.face(order.map((i) => base + i));
      continue;
    }
    const flat = new Float32Array(n * 3);
    order.forEach((i, j) => {
      flat[j * 3] = c.positions[(s + i) * 3];
      flat[j * 3 + 1] = c.positions[(s + i) * 3 + 1];
    });
    tmp.length = 0;
    triangulatePoly(
      flat,
      Uint32Array.from({ length: n }, (_, i) => i),
      tmp,
      0,
    );
    for (let i = 0; i < tmp.length; i += 3) b.face([base + order[tmp[i]], base + order[tmp[i + 1]], base + order[tmp[i + 2]]]);
  }
  const m = b.build();
  m.materials = [...c.materials];
  return m;
}
