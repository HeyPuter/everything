// Spreadsheet data: which geometry to show and its columns per component/domain.
import { app } from '../app/app';
import { baseEvalMesh } from '../eval/depsgraph';
import type { MeshData, ObjectData } from '../data/types';
import { GeometrySet, isInternal, readAttribute, type Component, decomposeMat } from '../geonodes/geometry';
import { evalMeshToGeometry, curveDataToCurves } from '../geonodes/convert';
import { gnResults, viewerState } from '../geonodes/results';
import { faceNormals, vertexNormals, cornerNormals } from '../geonodes/meshutil';
import type { AttrArray, DataType, Domain } from '../geonodes/types';
import { dataComps } from '../geonodes/types';

export type EvalState = 'EVALUATED' | 'ORIGINAL' | 'VIEWER_NODE';
export type ComponentKey = 'MESH' | 'CURVES' | 'POINTS' | 'INSTANCES';

export interface Column {
  name: string;
  type: DataType | 'INT2' | 'STRING';
  data: AttrArray | string[];
  comps: number;
  /** virtual columns (computed, not stored attributes) */
  virtual?: boolean;
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

export function resolveSource(state: EvalState): Source | null {
  const ob = app.activeObject;
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
    if (me) geo = evalMeshToGeometry(baseEvalMesh(me), me);
    else if ((ob.type === 'CURVE' || ob.type === 'FONT') && ob.data && doc.curves[ob.data]) {
      const cu = doc.curves[ob.data];
      let g = curveCache.get(cu);
      if (!g) curveCache.set(cu, (g = new GeometrySet(undefined, undefined, curveDataToCurves(cu))));
      geo = g;
    }
  } else {
    if (ev?.mesh) geo = r && r.evalMesh === ev.mesh ? r.geometry : evalMeshToGeometry(ev.mesh, me);
  }
  if (!geo) geo = GeometrySet.empty();
  return { ob, geo, mesh: me, state, viewerActive, crumbs };
}

export function componentOf(g: GeometrySet, k: ComponentKey): Component | undefined {
  return k === 'MESH' ? g.mesh : k === 'CURVES' ? g.curves : k === 'POINTS' ? g.points : g.instances;
}

const fmtName = (n: string) => (n === '.viewer' ? 'Viewer' : n);

/** Columns of a component domain (position first, then attributes). */
export function columnsOf(c: Component, domain: Domain): Column[] {
  const cols: Column[] = [];
  const n = c.domainSize(domain);
  const viewer = c.attrs.get('.viewer');
  if (viewer) {
    const a = viewer.domain === domain ? viewer : readAttribute(c, '.viewer', domain);
    if (a)
      cols.push({
        name: 'Viewer',
        type: a.type,
        data: a.data,
        comps: dataComps(a.type),
      });
  }
  if (c.kind === 'INSTANCES') {
    const names: string[] = [];
    const pos = new Float32Array(n * 3),
      rot = new Float32Array(n * 3),
      scl = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ref = c.references[c.refIndex[i]];
      const doc = app.doc;
      names.push(
        !ref ? '' : ref.type === 'OBJECT' ? (doc.objects[ref.objectId]?.name ?? 'Object') : ref.type === 'COLLECTION' ? (doc.collections[ref.collectionId]?.name ?? 'Collection') : 'Geometry',
      );
      const d = decomposeMat(c.transforms.subarray(i * 16, i * 16 + 16));
      pos.set(d.t, i * 3);
      rot.set(d.r, i * 3);
      scl.set(d.s, i * 3);
    }
    cols.push({ name: 'Name', type: 'STRING', data: names, comps: 1 });
    cols.push({ name: 'Position', type: 'FLOAT_VECTOR', data: pos, comps: 3 });
    cols.push({ name: 'Rotation', type: 'QUATERNION', data: rot, comps: 3 });
    cols.push({ name: 'Scale', type: 'FLOAT_VECTOR', data: scl, comps: 3 });
  } else if (domain === 'POINT')
    cols.push({
      name: 'position',
      type: 'FLOAT_VECTOR',
      data: c.positions,
      comps: 3,
    });
  if (c.kind === 'MESH' && domain === 'EDGE') {
    const topo = c.topology();
    cols.push({
      name: 'Vertices',
      type: 'INT2',
      data: Int32Array.from(topo.edges),
      comps: 2,
    });
  }
  if (c.kind === 'MESH' && domain === 'CORNER')
    cols.push({
      name: 'Vertex',
      type: 'INT',
      data: Int32Array.from(c.corners),
      comps: 1,
    });
  if (c.kind === 'MESH' && (domain === 'POINT' || domain === 'FACE' || domain === 'CORNER') && c.faceCount) {
    const nrm = domain === 'POINT' ? vertexNormals(c) : domain === 'FACE' ? faceNormals(c) : cornerNormals(c);
    cols.push({
      name: 'Normal',
      type: 'FLOAT_VECTOR',
      data: nrm,
      comps: 3,
      virtual: true,
    });
  }
  if (c.kind === 'CURVES' && domain === 'CURVE') cols.push({ name: 'cyclic', type: 'BOOLEAN', data: c.cyclic, comps: 1 });
  const names = [...c.attrs.keys()].filter((k) => !isInternal(k)).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const a = c.attrs.get(name)!;
    if (a.domain !== domain) continue;
    cols.push({
      name: fmtName(name),
      type: a.type,
      data: a.data,
      comps: dataComps(a.type),
    });
  }
  return cols;
}

/** Rows selected in edit mode (by the original mesh vertex selection), or null for all rows. */
export function selectedRows(src: Source, key: ComponentKey, domain: Domain): Int32Array | null {
  const me = src.mesh;
  if (app.doc.mode !== 'EDIT' || key !== 'MESH' || !me?.select_vert) return null;
  const c = src.geo.mesh;
  if (!c) return null;
  const sel = me.select_vert;
  const nv = c.vertCount;
  // the evaluated mesh maps to the original only when vertex counts agree
  if (nv !== me.positions.length / 3) return null;
  const rows: number[] = [];
  if (domain === 'POINT') {
    for (let v = 0; v < nv; v++) if (sel[v]) rows.push(v);
  } else if (domain === 'EDGE') {
    const t = c.topology();
    for (let e = 0; e < t.edgeCount; e++) if (sel[t.edges[e * 2]] && sel[t.edges[e * 2 + 1]]) rows.push(e);
  } else if (domain === 'FACE') {
    for (let f = 0; f < c.faceCount; f++) {
      let all = true;
      for (let k = c.faceOffsets[f]; k < c.faceOffsets[f + 1]; k++) if (!sel[c.corners[k]]) all = false;
      if (all) rows.push(f);
    }
  } else if (domain === 'CORNER') for (let k = 0; k < c.cornerCount; k++) if (sel[c.corners[k]]) rows.push(k);
  return Int32Array.from(rows);
}
