// Join, transform and realize geometry (attributes are merged by name).
import {
  CurvesComponent,
  EdgeHash,
  GeometrySet,
  InstancesComponent,
  MeshComponent,
  PointsComponent,
  adaptDomain,
  allocData,
  dataComps,
  mulMat,
  transformPositions,
  type AttrMap,
  type Component,
  type InstanceReference,
} from '../geometry';
import type { AttrArray, DataType, Domain } from '../types';
import { missingCurveAttr, transformCurveAttrs } from '../curves/curvedata';
import { joinGreasePencil, transformGreasePencil } from '../curves/gpdata';

const TYPE_RANK: Record<DataType, number> = {
  BOOLEAN: 0,
  INT8: 1,
  INT: 2,
  FLOAT: 3,
  FLOAT2: 4,
  FLOAT_VECTOR: 5,
  QUATERNION: 5,
  FLOAT_COLOR: 6,
};

function convertData(data: AttrArray, from: DataType, to: DataType, n: number): AttrArray {
  if (from === to) return data;
  const out = allocData(to, n);
  const fc = dataComps(from),
    tc = dataComps(to);
  for (let i = 0; i < n; i++) {
    if (fc === 1) {
      const v = data[i];
      if (tc === 1) out[i] = to === 'BOOLEAN' ? (v ? 1 : 0) : v;
      else {
        for (let k = 0; k < Math.min(3, tc); k++) out[i * tc + k] = v;
        if (tc === 4) out[i * 4 + 3] = 1;
      }
    } else if (tc === 1) {
      let s = 0;
      for (let k = 0; k < fc; k++) s += data[i * fc + k];
      out[i] = s / fc;
    } else {
      for (let k = 0; k < Math.min(fc, tc); k++) out[i * tc + k] = data[i * fc + k];
      if (tc === 4 && fc < 4) out[i * 4 + 3] = 1;
    }
  }
  return out;
}

/** Merge attributes of several components of the same kind (missing attributes are zero). */
function joinAttrs(comps: Component[], sizes: (c: Component, d: Domain) => number): AttrMap {
  const info = new Map<string, { domain: Domain; type: DataType }>();
  for (const c of comps)
    for (const [name, a] of c.attrs) {
      const cur = info.get(name);
      if (!cur) info.set(name, { domain: a.domain, type: a.type });
      else if (TYPE_RANK[a.type] > TYPE_RANK[cur.type]) cur.type = a.type;
    }
  const out: AttrMap = new Map();
  for (const [name, { domain, type }] of info) {
    const comp = dataComps(type);
    let total = 0;
    for (const c of comps) total += sizes(c, domain);
    const data = allocData(type, total);
    let o = 0;
    comps.forEach((c) => {
      const n = sizes(c, domain);
      const a = c.attrs.get(name);
      if (a) {
        let d = a.domain === domain ? a.data : adaptDomain(c, a.data, a.type, a.domain, domain);
        d = convertData(d, a.type, type, n);
        data.set(d.subarray(0, n * comp), o * comp);
      } else if (c.kind === 'CURVES' && missingCurveAttr(c, name, data, o, n)) {
        // built-in curve attributes get their defaults (spline type, resolution, handles)
      } else if (type === 'FLOAT_COLOR') for (let i = 0; i < n; i++) data[(o + i) * 4 + 3] = 1;
      o += n;
    });
    out.set(name, { domain, type, data });
  }
  return out;
}

function mergeMaterials(lists: (string | null)[][]): {
  materials: (string | null)[];
  remap: Int32Array[];
} {
  const materials: (string | null)[] = [];
  const remap = lists.map((l) => {
    const r = new Int32Array(Math.max(1, l.length));
    l.forEach((m, i) => {
      let k = materials.indexOf(m);
      if (k < 0) {
        k = materials.length;
        materials.push(m);
      }
      r[i] = k;
    });
    return r;
  });
  return { materials, remap };
}

export function joinMeshes(list: MeshComponent[]): MeshComponent {
  if (list.length === 1) return list[0];
  let nv = 0,
    nc = 0,
    nf = 0,
    nl = 0;
  for (const m of list) {
    nv += m.vertCount;
    nc += m.cornerCount;
    nf += m.faceCount;
    nl += m.looseEdges.length;
  }
  const positions = new Float32Array(nv * 3),
    faceOffsets = new Uint32Array(nf + 1),
    corners = new Uint32Array(nc),
    loose = new Uint32Array(nl);
  let vo = 0,
    co = 0,
    fo = 0,
    lo = 0;
  const vertBase: number[] = [];
  for (const m of list) {
    vertBase.push(vo);
    positions.set(m.positions, vo * 3);
    for (let f = 0; f < m.faceCount; f++) faceOffsets[fo + f] = m.faceOffsets[f] + co;
    for (let c = 0; c < m.cornerCount; c++) corners[co + c] = m.corners[c] + vo;
    for (let i = 0; i < m.looseEdges.length; i++) loose[lo + i] = m.looseEdges[i] + vo;
    vo += m.vertCount;
    co += m.cornerCount;
    fo += m.faceCount;
    lo += m.looseEdges.length;
  }
  faceOffsets[nf] = nc;
  const out = new MeshComponent(positions, faceOffsets, corners, loose);
  // edge attributes are concatenated per component, then mapped into the joined topology by vertex pair
  const hasEdgeAttrs = list.some((m) => [...m.attrs.values()].some((a) => a.domain === 'EDGE'));
  out.attrs = joinAttrs(list, (c, d) => c.domainSize(d));
  if (hasEdgeAttrs) {
    // reorder edge attributes: joined topology lists all face edges first, then loose edges
    const topo = out.topology();
    const hash = new EdgeHash(topo.edgeCount);
    for (let e = 0; e < topo.edgeCount; e++) hash.getOrAdd(topo.edges[e * 2], topo.edges[e * 2 + 1], e);
    for (const [name, a] of out.attrs) {
      if (a.domain !== 'EDGE') continue;
      const comps = dataComps(a.type);
      const reordered = allocData(a.type, topo.edgeCount);
      let base = 0;
      list.forEach((m, ci) => {
        const t = m.topology();
        for (let e = 0; e < t.edgeCount; e++) {
          const j = hash.get(t.edges[e * 2] + vertBase[ci], t.edges[e * 2 + 1] + vertBase[ci]);
          if (j < 0) continue;
          for (let k = 0; k < comps; k++) reordered[j * comps + k] = a.data[(base + e) * comps + k];
        }
        base += t.edgeCount;
      });
      out.attrs.set(name, { domain: 'EDGE', type: a.type, data: reordered });
    }
  }
  const mats = mergeMaterials(list.map((m) => m.materials));
  if (mats.materials.length) {
    out.materials = mats.materials;
    const mi = out.attrs.get('material_index');
    if (mi && mi.domain === 'FACE') {
      const data = new Int32Array(nf);
      let f0 = 0;
      list.forEach((m, ci) => {
        for (let f = 0; f < m.faceCount; f++) {
          const v = mi.data[f0 + f];
          data[f0 + f] = mats.remap[ci][Math.min(v, mats.remap[ci].length - 1)] ?? v;
        }
        f0 += m.faceCount;
      });
      out.attrs.set('material_index', { domain: 'FACE', type: 'INT', data });
    } else if (list.some((m) => m.materials.length)) {
      const data = new Int32Array(nf);
      let f0 = 0;
      list.forEach((m, ci) => {
        data.fill(mats.remap[ci][0] ?? 0, f0, f0 + m.faceCount);
        f0 += m.faceCount;
      });
      out.attrs.set('material_index', { domain: 'FACE', type: 'INT', data });
    }
  }
  return out;
}

export function joinPoints(list: PointsComponent[]): PointsComponent {
  if (list.length === 1) return list[0];
  let n = 0;
  for (const p of list) n += p.count;
  const pos = new Float32Array(n * 3);
  let o = 0;
  for (const p of list) {
    pos.set(p.positions, o * 3);
    o += p.count;
  }
  return new PointsComponent(
    pos,
    joinAttrs(list, (c, d) => c.domainSize(d)),
    mergeMaterials(list.map((p) => p.materials)).materials,
  );
}

export function joinCurves(list: CurvesComponent[]): CurvesComponent {
  if (list.length === 1) return list[0];
  let np = 0,
    nc = 0;
  for (const c of list) {
    np += c.pointCount;
    nc += c.curveCount;
  }
  const pos = new Float32Array(np * 3),
    offs = new Uint32Array(nc + 1),
    cyc = new Uint8Array(nc);
  let po = 0,
    co = 0;
  for (const c of list) {
    pos.set(c.positions, po * 3);
    for (let k = 0; k < c.curveCount; k++) offs[co + k] = c.curveOffsets[k] + po;
    cyc.set(c.cyclic, co);
    po += c.pointCount;
    co += c.curveCount;
  }
  offs[nc] = np;
  return new CurvesComponent(
    pos,
    offs,
    cyc,
    joinAttrs(list, (c, d) => c.domainSize(d)),
    mergeMaterials(list.map((c) => c.materials)).materials,
  );
}

export function joinInstances(list: InstancesComponent[]): InstancesComponent {
  if (list.length === 1) return list[0];
  let n = 0;
  for (const c of list) n += c.count;
  const T = new Float32Array(n * 16),
    ref = new Int32Array(n);
  const refs: InstanceReference[] = [];
  let o = 0;
  for (const c of list) {
    T.set(c.transforms, o * 16);
    const base = refs.length;
    refs.push(...c.references);
    for (let i = 0; i < c.count; i++) ref[o + i] = c.refIndex[i] + base;
    o += c.count;
  }
  return new InstancesComponent(
    T,
    ref,
    refs,
    joinAttrs(list, (c, d) => c.domainSize(d)),
  );
}

export function joinGeometries(list: GeometrySet[]): GeometrySet {
  const nonEmpty = list.filter((g) => !g.isEmpty());
  if (nonEmpty.length <= 1) return nonEmpty[0] ?? GeometrySet.empty();
  const meshes = nonEmpty.map((g) => g.mesh).filter((x): x is MeshComponent => !!x);
  const points = nonEmpty.map((g) => g.points).filter((x): x is PointsComponent => !!x);
  const curves = nonEmpty.map((g) => g.curves).filter((x): x is CurvesComponent => !!x);
  const inst = nonEmpty.map((g) => g.instances).filter((x): x is InstancesComponent => !!x);
  const out = new GeometrySet(
    meshes.length ? joinMeshes(meshes) : undefined,
    points.length ? joinPoints(points) : undefined,
    curves.length ? joinCurves(curves) : undefined,
    inst.length ? joinInstances(inst) : undefined,
  );
  out.greasePencil = joinGreasePencil(nonEmpty.map((g) => g.greasePencil));
  return out;
}

// ---------------------------------------------------------------------------
// Transform

export function transformComponent(c: Component, m: ArrayLike<number>): Component {
  if (c.kind === 'INSTANCES') {
    const T = new Float32Array(c.transforms.length);
    for (let i = 0; i < c.count; i++) T.set(mulMat(m, c.transforms.subarray(i * 16, i * 16 + 16)), i * 16);
    const out = c.copy();
    out.transforms = T;
    return out;
  }
  const out = c.copy();
  out.positions = transformPositions(m, c.positions);
  if (out.kind === 'CURVES') transformCurveAttrs(out, m);
  return out;
}

export function transformGeometry(g: GeometrySet, m: ArrayLike<number>): GeometrySet {
  const out = g.map((c) => transformComponent(c, m));
  if (g.greasePencil) out.greasePencil = transformGreasePencil(g.greasePencil, m);
  return out;
}

// ---------------------------------------------------------------------------
// Realize instances

/** Propagate instance-domain attributes onto the point domain of realized geometry. */
function withInstanceAttrs(g: GeometrySet, inst: InstancesComponent, i: number): GeometrySet {
  if (!inst.attrs.size) return g;
  return g.map((c) => {
    if (c.kind === 'INSTANCES') return c;
    const out = c.copy();
    const n = c.kind === 'MESH' ? c.vertCount : c.kind === 'POINTS' ? c.count : c.pointCount;
    for (const [name, a] of inst.attrs) {
      if (name === 'position' || out.attrs.has(name)) continue;
      const comps = dataComps(a.type);
      const data = allocData(a.type, n);
      for (let v = 0; v < n; v++) for (let k = 0; k < comps; k++) data[v * comps + k] = a.data[i * comps + k];
      out.attrs.set(name, { domain: 'POINT', type: a.type, data });
    }
    return out;
  });
}

/**
 * Turn instances into real geometry. `depthOf(i)` limits how many nested levels below instance i
 * are realized (Infinity = all).
 */
export function realizeInstances(g: GeometrySet, selection: Uint8Array | null = null, depthOf: (i: number) => number = () => Infinity, guard = 0): GeometrySet {
  const inst = g.instances;
  if (!inst || guard > 64) return g;
  const parts: GeometrySet[] = [new GeometrySet(g.mesh, g.points, g.curves)];
  const keepIdx: number[] = [];
  for (let i = 0; i < inst.count; i++) {
    if (selection && !selection[i]) {
      keepIdx.push(i);
      continue;
    }
    const ref = inst.references[inst.refIndex[i]];
    if (!ref) continue;
    let sub = ref.geometry;
    const d = depthOf(i);
    if (sub.instances && d > 0) sub = realizeInstances(sub, null, () => d - 1, guard + 1);
    sub = transformGeometry(sub, inst.transforms.subarray(i * 16, i * 16 + 16));
    parts.push(withInstanceAttrs(sub, inst, i));
  }
  const joined = joinGeometries(parts);
  if (keepIdx.length) {
    const kept = new InstancesComponent(new Float32Array(keepIdx.length * 16), new Int32Array(keepIdx.length), inst.references);
    keepIdx.forEach((s, k) => {
      kept.transforms.set(inst.transforms.subarray(s * 16, s * 16 + 16), k * 16);
      kept.refIndex[k] = inst.refIndex[s];
    });
    for (const [name, a] of inst.attrs) {
      const comps = dataComps(a.type);
      const d = allocData(a.type, keepIdx.length);
      keepIdx.forEach((s, k) => {
        for (let q = 0; q < comps; q++) d[k * comps + q] = a.data[s * comps + q];
      });
      kept.attrs.set(name, { domain: 'INSTANCE', type: a.type, data: d });
    }
    return joined.with(kept);
  }
  return new GeometrySet(joined.mesh, joined.points, joined.curves);
}
