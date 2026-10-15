// Conversion between the depsgraph's evaluated meshes (EvalMesh) and geometry sets.
import type { EvalMesh, GeometryInstance } from '../eval/types';
import type { CurveData, DocumentData, MeshData, ObjectData } from '../data/types';
import { sampleSpline } from '../eval/curve';
import { CurvesComponent, GeometrySet, MeshComponent, PointsComponent, mulMat, isIdentity, type AttrMap, type InstancesComponent } from './geometry';
import { edgeAttrToCorners, faceNormals, smoothFlags } from './meshutil';
import { curveObjectToCurves, evaluatedCurves } from './curves/curvedata';

export interface GnEvalMesh extends EvalMesh {
  /** materials of the generated geometry by material index (when set by nodes) */
  gnMaterials?: (string | null)[];
}

export const UV_DEFAULT = 'UVMap';

const inputCache = new WeakMap<EvalMesh, GeometrySet>();

/** Geometry set of an evaluated mesh (attributes: UV map, sharp_face, material_index, edges flags, vertex groups, colors). */
export function evalMeshToGeometry(m: EvalMesh, source?: MeshData | null): GeometrySet {
  const hit = inputCache.get(m);
  if (hit) return hit;
  const nc = m.indices.length,
    nf = m.offsets.length - 1,
    nv = m.positions.length / 3;
  const attrs: AttrMap = new Map();
  const mesh = new MeshComponent(m.positions, m.offsets, m.indices, m.looseEdges ?? new Uint32Array(0), attrs, source?.materials ? [...source.materials] : []);
  if (m.uvs && m.uvs.length === nc * 2 && nc)
    attrs.set(source?.uv_map_name || UV_DEFAULT, {
      domain: 'CORNER',
      type: 'FLOAT2',
      data: m.uvs,
    });
  if (nf) {
    let anySharp = !m.smooth;
    if (m.smooth) for (let f = 0; f < nf && !anySharp; f++) if (!m.smooth[f]) anySharp = true;
    if (anySharp) {
      const sf = new Uint8Array(nf);
      for (let f = 0; f < nf; f++) sf[f] = m.smooth?.[f] ? 0 : 1;
      attrs.set('sharp_face', { domain: 'FACE', type: 'BOOLEAN', data: sf });
    }
  }
  if (m.material_index && m.material_index.some((x) => x))
    attrs.set('material_index', {
      domain: 'FACE',
      type: 'INT',
      data: Int32Array.from(m.material_index),
    });
  const edgeFlag = (corner: ArrayLike<number> | undefined, name: string, type: 'BOOLEAN' | 'FLOAT') => {
    if (!corner || corner.length !== nc) return;
    let any = false;
    for (let c = 0; c < nc && !any; c++) if (corner[c]) any = true;
    if (!any) return;
    const topo = mesh.topology();
    const data = type === 'BOOLEAN' ? new Uint8Array(topo.edgeCount) : new Float32Array(topo.edgeCount);
    for (let c = 0; c < nc; c++) if (corner[c]) data[topo.cornerEdge[c]] = type === 'BOOLEAN' ? 1 : Math.max(data[topo.cornerEdge[c]], corner[c]);
    attrs.set(name, { domain: 'EDGE', type, data });
  };
  edgeFlag(m.sharp, 'sharp_edge', 'BOOLEAN');
  edgeFlag(m.creases, 'crease_edge', 'FLOAT');
  edgeFlag(m.seams, '.uv_seam', 'BOOLEAN');
  if (m.vertex_groups && m.weights)
    m.vertex_groups.forEach((g, i) => {
      const w = m.weights![i];
      if (w && w.length === nv) attrs.set(g.name, { domain: 'POINT', type: 'FLOAT', data: w });
    });
  if (source) {
    const sameTopo = source.indices === m.indices && source.positions.length === m.positions.length;
    source.color_attributes.forEach((c, i) => {
      if (i === source.active_color_index && m.colors && m.colors.length === nc * 4)
        attrs.set(c.name, {
          domain: 'CORNER',
          type: 'FLOAT_COLOR',
          data: m.colors,
        });
      else if (sameTopo)
        attrs.set(c.name, {
          domain: c.domain === 'POINT' ? 'POINT' : 'CORNER',
          type: 'FLOAT_COLOR',
          data: c.data,
        });
    });
  } else if (m.colors && m.colors.length === nc * 4)
    attrs.set('Color', {
      domain: 'CORNER',
      type: 'FLOAT_COLOR',
      data: m.colors,
    });
  let g = new GeometrySet(mesh);
  if (!nf && !m.looseEdges?.length && m.pointRadius) {
    const pattrs: AttrMap = new Map([['radius', { domain: 'POINT', type: 'FLOAT', data: m.pointRadius }]]);
    g = new GeometrySet(undefined, new PointsComponent(m.positions, pattrs));
  }
  if (m.curves?.length && !nf) {
    const curves = curvesFromPolylines(m.curves);
    g = new GeometrySet(undefined, undefined, curves);
  }
  inputCache.set(m, g);
  return g;
}

export function curvesFromPolylines(list: { points: Float32Array; cyclic: boolean }[]): CurvesComponent {
  let total = 0;
  for (const c of list) total += c.points.length / 3;
  const pos = new Float32Array(total * 3),
    offs = new Uint32Array(list.length + 1),
    cyc = new Uint8Array(list.length);
  let o = 0;
  list.forEach((c, i) => {
    offs[i] = o;
    pos.set(c.points, o * 3);
    o += c.points.length / 3;
    cyc[i] = c.cyclic ? 1 : 0;
  });
  offs[list.length] = o;
  return new CurvesComponent(pos, offs, cyc);
}

/** Curves of a curve data-block (object space) with their spline types and handles. */
export function curveDataToCurves(cu: CurveData): CurvesComponent {
  return curveObjectToCurves(cu);
}

/** Poly curves sampled from a curve data-block (object space). */
export function sampledCurveData(cu: CurveData): CurvesComponent {
  const sampled = cu.splines.map((s) => sampleSpline(s, cu.resolution_u));
  let total = 0;
  for (const s of sampled) total += s.points.length;
  const pos = new Float32Array(total * 3),
    radius = new Float32Array(total),
    tilt = new Float32Array(total),
    offs = new Uint32Array(sampled.length + 1),
    cyc = new Uint8Array(sampled.length);
  let o = 0;
  sampled.forEach((s, i) => {
    offs[i] = o;
    cyc[i] = s.cyclic ? 1 : 0;
    s.points.forEach((p, k) => {
      pos.set(p, (o + k) * 3);
      radius[o + k] = s.radius[k] ?? 1;
      tilt[o + k] = s.tilt[k] ?? 0;
    });
    o += s.points.length;
  });
  offs[sampled.length] = o;
  const attrs: AttrMap = new Map();
  attrs.set('radius', { domain: 'POINT', type: 'FLOAT', data: radius });
  if (tilt.some((x) => x)) attrs.set('tilt', { domain: 'POINT', type: 'FLOAT', data: tilt });
  return new CurvesComponent(pos, offs, cyc, attrs, [...cu.materials]);
}

// ---------------------------------------------------------------------------
// Output

export interface OutputOptions {
  /** UV map attribute used for the evaluated mesh's uvs */
  uvName?: string;
  /** name of the attribute shown as vertex colors */
  colorName?: string;
  /** vertex groups of the original mesh (weights are read back from attributes of these names) */
  vertexGroups?: { name: string }[];
  /** object material slots: generated materials are mapped onto matching slots */
  slots?: (string | null)[];
}

function cornerUVs(m: MeshComponent, name?: string): Float32Array {
  const nc = m.cornerCount;
  let a = name ? m.attrs.get(name) : undefined;
  if (!a || a.type !== 'FLOAT2' || a.domain !== 'CORNER') a = m.attrs.get(UV_DEFAULT);
  if (!a || a.type !== 'FLOAT2' || a.domain !== 'CORNER') for (const [n, x] of m.attrs) if (!n.startsWith('#') && x.type === 'FLOAT2' && x.domain === 'CORNER') a = x;
  if (a && a.type === 'FLOAT2' && a.domain === 'CORNER' && a.data.length === nc * 2) return a.data as Float32Array;
  if (a && a.type === 'FLOAT_VECTOR' && a.domain === 'CORNER') {
    const out = new Float32Array(nc * 2);
    for (let c = 0; c < nc; c++) {
      out[c * 2] = a.data[c * 3];
      out[c * 2 + 1] = a.data[c * 3 + 1];
    }
    return out;
  }
  return new Float32Array(nc * 2);
}

/** Evaluated mesh for a mesh component (no instances). */
export function meshToEvalMesh(m: MeshComponent, opts: OutputOptions = {}): GnEvalMesh {
  const nc = m.cornerCount,
    nf = m.faceCount;
  const fn = faceNormals(m);
  const normals = new Float32Array(nc * 3);
  for (let f = 0; f < nf; f++) for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) normals.set(fn.subarray(f * 3, f * 3 + 3), c * 3);
  const topo = nf ? m.topology() : undefined;
  const sharp = topo ? edgeAttrToCorners(m, 'sharp_edge', topo) : null;
  const creases = topo ? edgeAttrToCorners(m, 'crease_edge', topo) : null;
  const seams = topo ? edgeAttrToCorners(m, '.uv_seam', topo) : null;
  const mi = m.attrs.get('material_index');
  let material_index: Uint16Array | undefined;
  if (mi && mi.domain === 'FACE') material_index = Uint16Array.from(mi.data as Int32Array, (x) => Math.max(0, x));
  let gnMaterials: (string | null)[] | undefined;
  if (m.materials.length && opts.slots) {
    // map generated material indices to object slots when possible
    const slots = opts.slots;
    const same = m.materials.every((id, i) => slots[i] === id);
    if (!same) {
      gnMaterials = [...m.materials];
    }
  }
  let colors: Float32Array | undefined;
  const ca = opts.colorName ? m.attrs.get(opts.colorName) : undefined;
  if (ca && ca.type === 'FLOAT_COLOR') {
    if (ca.domain === 'CORNER') colors = ca.data as Float32Array;
    else if (ca.domain === 'POINT') {
      colors = new Float32Array(nc * 4);
      for (let c = 0; c < nc; c++) colors.set((ca.data as Float32Array).subarray(m.corners[c] * 4, m.corners[c] * 4 + 4), c * 4);
    }
  }
  let weights: Float32Array[] | undefined;
  if (opts.vertexGroups?.length) {
    const nv = m.vertCount;
    weights = opts.vertexGroups.map((g) => {
      const a = m.attrs.get(g.name);
      if (a && a.domain === 'POINT' && a.type === 'FLOAT') return a.data as Float32Array;
      return new Float32Array(nv);
    });
  }
  const out: GnEvalMesh = {
    positions: m.positions,
    offsets: m.faceOffsets,
    indices: m.corners,
    uvs: cornerUVs(m, opts.uvName),
    normals,
    smooth: smoothFlags(m),
    material_index,
    sharp: sharp ? Uint32Array.from(sharp) : undefined,
    creases: creases ?? undefined,
    seams: seams ? Uint32Array.from(seams) : undefined,
    colors,
    weights,
    vertex_groups: opts.vertexGroups,
    looseEdges: m.looseEdges.length ? m.looseEdges : undefined,
  };
  if (gnMaterials) out.gnMaterials = gnMaterials;
  return out;
}

const refMeshCache = new WeakMap<GeometrySet, GnEvalMesh>();

function flattenInstances(inst: InstancesComponent, parent: ArrayLike<number> | null, out: GeometryInstance[], opts: OutputOptions, depth: number) {
  if (depth > 16) return;
  const T = inst.transforms;
  for (let i = 0; i < inst.count; i++) {
    const ref = inst.references[inst.refIndex[i]];
    if (!ref) continue;
    const local = T.subarray(i * 16, i * 16 + 16);
    const m = parent ? mulMat(parent, local) : Float64Array.from(local);
    if (ref.type === 'OBJECT' && !ref.geometry.instances) {
      out.push({ objectId: ref.objectId, matrix: Array.from(m) });
      continue;
    }
    const g = ref.geometry;
    if (g.mesh && g.mesh.faceCount) {
      let em = refMeshCache.get(g);
      if (!em) {
        em = meshToEvalMesh(g.mesh, opts);
        refMeshCache.set(g, em);
      }
      out.push({ mesh: em, matrix: Array.from(m) });
    }
    if (g.instances) flattenInstances(g.instances, m, out, opts, depth + 1);
  }
}

/** Evaluated mesh for the depsgraph: the mesh component plus instances, points or curves. */
export function geometryToEvalMesh(g: GeometrySet, opts: OutputOptions = {}): GnEvalMesh {
  let out: GnEvalMesh;
  if (g.mesh) out = meshToEvalMesh(g.mesh, opts);
  else if (g.points) {
    const r = g.points.attrs.get('radius');
    out = {
      positions: g.points.positions,
      offsets: new Uint32Array([0]),
      indices: new Uint32Array(0),
      uvs: new Float32Array(0),
      normals: new Float32Array(0),
      pointRadius: r ? (r.data as Float32Array) : undefined,
    };
  } else if (g.curves) {
    const c = evaluatedCurves(g.curves);
    const curves: { points: Float32Array; cyclic: boolean }[] = [];
    for (let k = 0; k < c.curveCount; k++)
      curves.push({
        points: c.positions.subarray(c.curveOffsets[k] * 3, c.curveOffsets[k + 1] * 3),
        cyclic: !!c.cyclic[k],
      });
    out = {
      positions: c.positions,
      offsets: new Uint32Array([0]),
      indices: new Uint32Array(0),
      uvs: new Float32Array(0),
      normals: new Float32Array(0),
      curves,
    };
  } else
    out = {
      positions: new Float32Array(0),
      offsets: new Uint32Array([0]),
      indices: new Uint32Array(0),
      uvs: new Float32Array(0),
      normals: new Float32Array(0),
    };
  if (g.instances?.count) {
    const list: GeometryInstance[] = [];
    flattenInstances(g.instances, null, list, opts, 0);
    out.instances = list;
  }
  return out;
}

export { isIdentity };

/** Material slots of an object (object-linked slots override data slots). */
export function materialSlots(doc: DocumentData, ob: ObjectData): (string | null)[] {
  const data = ob.data ? ((doc.meshes[ob.data] ?? doc.curves[ob.data] ?? doc.metaballs?.[ob.data]) as { materials?: (string | null)[] } | undefined) : undefined;
  const base = data?.materials ?? [];
  if (!ob.object_materials) return [...base];
  return base.map((m, i) => (ob.material_slots_link?.[i] === 'OBJECT' ? (ob.object_materials![i] ?? null) : m));
}
