// Spreadsheet data: which geometry to show (evaluated / original / viewer, nested instance
// geometry, Grease Pencil layers) and its columns per component and domain.
import { app } from '../app/app';
import { baseEvalMesh } from '../eval/depsgraph';
import type { MeshData, ObjectData } from '../data/types';
import type { EvalMesh } from '../eval/types';
import { GeometrySet, isInternal, readAttribute, type Component, decomposeMat } from '../geonodes/geometry';
import { evalMeshToGeometry, curveDataToCurves } from '../geonodes/convert';
import { gnResults, viewerState } from '../geonodes/results';
import { faceNormals, vertexNormals, cornerNormals } from '../geonodes/meshutil';
import type { AttrArray, DataType, Domain } from '../geonodes/types';
import { dataComps } from '../geonodes/types';
import type { GreasePencilComponent } from '../geonodes/curves/gpdata';

export type EvalState = 'EVALUATED' | 'ORIGINAL' | 'VIEWER_NODE';
export type ComponentKey = 'MESH' | 'CURVES' | 'POINTS' | 'INSTANCES' | 'GREASE_PENCIL';
export type TableDomain = Domain | 'LAYER';
export type ColumnType = DataType | 'INT2' | 'STRING' | 'FLOAT4X4';

export interface Column {
  name: string;
  type: ColumnType;
  data: AttrArray | string[];
  comps: number;
  /** computed values (not stored attributes) */
  virtual?: boolean;
}

/** Which table is shown: component + domain inside nested instance geometry and Grease Pencil layers. */
export interface TableId {
  /** reference indices walking down nested instances */
  path: number[];
  key: ComponentKey;
  domain: TableDomain;
  /** Grease Pencil layer whose strokes are shown (key CURVES) */
  layer?: number;
}

export interface Source {
  ob: ObjectData;
  geo: GeometrySet;
  /** original mesh data used for edit mode selection */
  mesh: MeshData | null;
  state: EvalState;
  viewerActive: boolean;
  crumbs: [string, string][];
}

export function viewerActiveFor(ob: ObjectData | null): boolean {
  if (!ob || viewerState.objectId !== ob.id) return false;
  const r = gnResults.get(ob.id);
  return !!r?.viewer && r.modifierId === viewerState.modifierId;
}

const curveCache = new WeakMap<object, GeometrySet>();
const meshGeoCache = new WeakMap<EvalMesh, { me: MeshData | null; geo: GeometrySet }>();

function meshGeometry(m: EvalMesh, me: MeshData | null): GeometrySet {
  const hit = meshGeoCache.get(m);
  if (hit && hit.me === me) return hit.geo;
  const geo = evalMeshToGeometry(m, me);
  meshGeoCache.set(m, { me, geo });
  return geo;
}

const baseCache = new WeakMap<object, { me: MeshData; indices: unknown; geo: GeometrySet }>();

/** Geometry of an object in the requested evaluation state (`pinned` overrides the active object). */
export function resolveSource(state: EvalState, pinned?: string | null): Source | null {
  const ob = (pinned ? app.doc.objects[pinned] : null) ?? app.activeObject;
  if (!ob) return null;
  const doc = app.doc;
  const me = ob.type === 'MESH' && ob.data ? (doc.meshes[ob.data] ?? null) : null;
  const ev = app.graph.get(ob.id);
  const r = gnResults.get(ob.id);
  const viewerActive = viewerActiveFor(ob);
  const crumbs: [string, string][] = [['object', ob.name]];
  let geo: GeometrySet | null = null;
  if (state === 'VIEWER_NODE' && viewerActive && r?.viewer) {
    geo = r.viewer;
    const m = ob.modifiers.find((x) => x.id === r.modifierId);
    if (m) crumbs.push(['modifier', m.name]);
    crumbs.push(['hide_off', 'Viewer']);
  } else if (state === 'ORIGINAL') {
    if (me) {
      // edits replace the mesh arrays (copy-on-write), so their identity tells when to rebuild
      const hit = baseCache.get(me.positions);
      if (hit && hit.indices === me.indices && hit.me === me) geo = hit.geo;
      else {
        geo = evalMeshToGeometry(baseEvalMesh(me), me);
        baseCache.set(me.positions, { me, indices: me.indices, geo });
      }
    } else if ((ob.type === 'CURVE' || ob.type === 'FONT') && ob.data && doc.curves[ob.data]) {
      const cu = doc.curves[ob.data];
      let g = curveCache.get(cu);
      if (!g) curveCache.set(cu, (g = new GeometrySet(undefined, undefined, curveDataToCurves(cu))));
      geo = g;
    }
  } else if (ev?.mesh) geo = r && r.evalMesh === ev.mesh ? r.geometry : meshGeometry(ev.mesh, me);
  if (!geo) geo = GeometrySet.empty();
  return { ob, geo, mesh: me, state, viewerActive, crumbs };
}

/** Display name of an instance reference. */
export function referenceName(ref: import('../geonodes/geometry').InstanceReference | undefined, i: number): string {
  const doc = app.doc;
  if (!ref) return `Reference ${i}`;
  if (ref.type === 'OBJECT') return doc.objects[ref.objectId]?.name ?? 'Object';
  if (ref.type === 'COLLECTION') return doc.collections[ref.collectionId]?.name ?? 'Collection';
  return `Geometry ${i}`;
}

/** Geometry nested in instance references along `path` (null when the path no longer exists). */
export function geometryAt(root: GeometrySet, path: number[]): GeometrySet | null {
  let g: GeometrySet | undefined = root;
  for (const i of path) {
    g = g?.instances?.references[i]?.geometry;
    if (!g) return null;
  }
  return g;
}

export function componentOf(g: GeometrySet, k: ComponentKey, layer?: number): Component | GreasePencilComponent | undefined {
  if (k === 'GREASE_PENCIL') return g.greasePencil;
  if (k === 'CURVES' && layer !== undefined) return g.greasePencil?.layers[layer]?.curves;
  return k === 'MESH' ? g.mesh : k === 'CURVES' ? g.curves : k === 'POINTS' ? g.points : g.instances;
}

/** Number of rows of a table. */
export function tableSize(g: GeometrySet, t: TableId): number {
  const c = componentOf(g, t.key, t.layer);
  if (!c) return 0;
  if (c.kind === 'GREASE_PENCIL') return t.domain === 'LAYER' ? c.layerCount : 0;
  return t.domain === 'LAYER' ? 0 : c.domainSize(t.domain);
}

const fmtName = (n: string) => (n === '.viewer' ? 'Viewer' : n);

const columnCache = new WeakMap<object, Map<string, Column[]>>();

/** Columns of a table (position first, then attributes); cached per component. */
export function tableColumns(g: GeometrySet, t: TableId, internal = false): Column[] {
  const c = componentOf(g, t.key, t.layer);
  if (!c) return [];
  let byDomain = columnCache.get(c);
  if (!byDomain) columnCache.set(c, (byDomain = new Map()));
  const key = `${t.domain}|${internal ? 1 : 0}`;
  let cols = byDomain.get(key);
  if (!cols) {
    cols = c.kind === 'GREASE_PENCIL' ? layerColumns(c) : t.domain === 'LAYER' ? [] : columnsOf(c, t.domain, internal);
    byDomain.set(key, cols);
  }
  return cols;
}

function layerColumns(gp: GreasePencilComponent): Column[] {
  const n = gp.layerCount;
  const opacity = new Float32Array(n),
    strokes = new Int32Array(n),
    points = new Int32Array(n);
  const tr = new Float32Array(n * 16);
  gp.layers.forEach((l, i) => {
    opacity[i] = l.opacity;
    strokes[i] = l.curves.curveCount;
    points[i] = l.curves.pointCount;
    tr.set(l.transform.slice(0, 16), i * 16);
  });
  return [
    { name: 'Name', type: 'STRING', data: gp.layers.map((l) => l.name), comps: 1 },
    { name: 'Opacity', type: 'FLOAT', data: opacity, comps: 1 },
    { name: 'Strokes', type: 'INT', data: strokes, comps: 1, virtual: true },
    { name: 'Points', type: 'INT', data: points, comps: 1, virtual: true },
    { name: 'Transform', type: 'FLOAT4X4', data: tr, comps: 16 },
  ];
}

/** Columns of a component domain (position first, then attributes). */
export function columnsOf(c: Component, domain: Domain, internal = false): Column[] {
  const cols: Column[] = [];
  const n = c.domainSize(domain);
  const viewer = c.attrs.get('.viewer');
  if (viewer) {
    const a = viewer.domain === domain ? viewer : readAttribute(c, '.viewer', domain);
    if (a) cols.push({ name: 'Viewer', type: a.type, data: a.data, comps: dataComps(a.type) });
  }
  for (const k of c.attrs.keys()) {
    if (!k.startsWith('.viewer:')) continue;
    const src = c.attrs.get(k)!;
    const a = src.domain === domain ? src : readAttribute(c, k, domain);
    if (a) cols.push({ name: k.slice(8), type: a.type, data: a.data, comps: dataComps(a.type) });
  }
  if (c.kind === 'INSTANCES') {
    const names: string[] = [];
    const pos = new Float32Array(n * 3),
      rot = new Float32Array(n * 3),
      scl = new Float32Array(n * 3);
    const mat = new Float32Array(n * 16);
    for (let i = 0; i < n; i++) {
      names.push(referenceName(c.references[c.refIndex[i]], c.refIndex[i]));
      const m = c.transforms.subarray(i * 16, i * 16 + 16);
      const d = decomposeMat(m);
      pos.set(d.t, i * 3);
      rot.set(d.r, i * 3);
      scl.set(d.s, i * 3);
      mat.set(m, i * 16);
    }
    cols.push({ name: 'Name', type: 'STRING', data: names, comps: 1 });
    cols.push({ name: 'Position', type: 'FLOAT_VECTOR', data: pos, comps: 3, virtual: true });
    cols.push({ name: 'Rotation', type: 'QUATERNION', data: rot, comps: 3, virtual: true });
    cols.push({ name: 'Scale', type: 'FLOAT_VECTOR', data: scl, comps: 3, virtual: true });
    cols.push({ name: 'Transform', type: 'FLOAT4X4', data: mat, comps: 16 });
  } else if (domain === 'POINT') cols.push({ name: 'position', type: 'FLOAT_VECTOR', data: c.positions, comps: 3 });
  if (c.kind === 'MESH' && domain === 'EDGE') cols.push({ name: 'Vertices', type: 'INT2', data: Int32Array.from(c.topology().edges), comps: 2 });
  if (c.kind === 'MESH' && domain === 'CORNER') cols.push({ name: 'Vertex', type: 'INT', data: Int32Array.from(c.corners), comps: 1 });
  if (c.kind === 'MESH' && (domain === 'POINT' || domain === 'FACE' || domain === 'CORNER') && c.faceCount) {
    const nrm = domain === 'POINT' ? vertexNormals(c) : domain === 'FACE' ? faceNormals(c) : cornerNormals(c);
    cols.push({ name: 'Normal', type: 'FLOAT_VECTOR', data: nrm, comps: 3, virtual: true });
  }
  if (c.kind === 'CURVES' && domain === 'CURVE') {
    cols.push({ name: 'cyclic', type: 'BOOLEAN', data: c.cyclic, comps: 1 });
    const counts = new Int32Array(c.curveCount);
    for (let i = 0; i < counts.length; i++) counts[i] = c.curveOffsets[i + 1] - c.curveOffsets[i];
    cols.push({ name: 'Points', type: 'INT', data: counts, comps: 1, virtual: true });
  }
  const names = [...c.attrs.keys()].filter((k) => k !== '.viewer' && !k.startsWith('.viewer:') && (internal || !isInternal(k))).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const a = c.attrs.get(name)!;
    if (a.domain !== domain) continue;
    cols.push({ name: fmtName(name), type: a.type, data: a.data, comps: dataComps(a.type) });
  }
  return cols;
}

/** Rows selected in edit mode (by the original mesh vertex selection), or null for all rows. */
export function selectedRows(src: Source, t: TableId): Int32Array | null {
  const me = src.mesh;
  if (app.doc.mode !== 'EDIT' || t.key !== 'MESH' || t.path.length || !me?.select_vert) return null;
  const c = src.geo.mesh;
  if (!c) return null;
  const sel = me.select_vert;
  const nv = c.vertCount;
  // the evaluated mesh maps to the original only when vertex counts agree
  if (nv !== me.positions.length / 3) return null;
  const rows: number[] = [];
  const domain = t.domain;
  if (domain === 'POINT') {
    for (let v = 0; v < nv; v++) if (sel[v]) rows.push(v);
  } else if (domain === 'EDGE') {
    const tp = c.topology();
    for (let e = 0; e < tp.edgeCount; e++) if (sel[tp.edges[e * 2]] && sel[tp.edges[e * 2 + 1]]) rows.push(e);
  } else if (domain === 'FACE') {
    for (let f = 0; f < c.faceCount; f++) {
      let all = true;
      for (let k = c.faceOffsets[f]; k < c.faceOffsets[f + 1]; k++) if (!sel[c.corners[k]]) all = false;
      if (all) rows.push(f);
    }
  } else if (domain === 'CORNER') for (let k = 0; k < c.cornerCount; k++) if (sel[c.corners[k]]) rows.push(k);
  return Int32Array.from(rows);
}
