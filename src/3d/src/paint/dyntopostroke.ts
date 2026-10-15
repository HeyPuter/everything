// Dynamic topology in Sculpt Mode: stroke integration (refine around the brush while sculpting),
// enabling (triangulates the mesh), detail flood fill, sample detail and detail size editing.
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { own } from '../data/cow';
import type { MeshData, SculptSettings } from '../data/types';
import { h, type VNode } from '../ui/h';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeMeshData, beginGeometryStroke, dropSession, meshSession, type MeshSession } from './session';
import { invalidatePaintAttributes, maskChanged } from './display';
import { faceSetsOf, hiddenFacesOf, setHiddenFaces } from './fsdata';
import { compactVertices, fromTriMesh, remeshRegion, toTriMesh, type TriMesh, type VAttr } from './dyntopo';
import { dyntopoHooks, type StrokeState } from './sculpt';
import { sculptPoll } from './facesetops';

const settings = (): SculptSettings => app.doc.scene.tool_settings.sculpt;
export const dyntopoOn = () => app.doc.mode === 'SCULPT' && !!settings().use_dyntopo;

function allTriangles(me: MeshData) {
  for (let f = 0; f < me.offsets.length - 1; f++) if (me.offsets[f + 1] - me.offsets[f] !== 3) return false;
  return true;
}

interface DynState {
  tm: TriMesh;
  lastStep: number;
  hasMask: boolean;
  hasSets: boolean;
  weights: number;
  colors: number[];
}

/** Per-vertex attributes of the mesh as TriMesh attributes (mask, weights, point colors). */
function vattrsOf(me: MeshData): { attrs: VAttr[]; hasMask: boolean; weights: number; colors: number[] } {
  const nv = me.positions.length / 3;
  const attrs: VAttr[] = [];
  const hasMask = !!me.sculpt_mask && me.sculpt_mask.length === nv;
  if (hasMask) attrs.push({ data: Array.from(me.sculpt_mask!), comps: 1 });
  for (const w of me.weights) attrs.push({ data: Array.from(w && w.length === nv ? w : new Float32Array(nv)), comps: 1 });
  const colors: number[] = [];
  me.color_attributes.forEach((c, i) => {
    if (c.domain !== 'POINT') return;
    colors.push(i);
    attrs.push({ data: Array.from(c.data), comps: 4 });
  });
  return { attrs, hasMask, weights: me.weights.length, colors };
}

/** Flat per-corner normals for triangles. */
function triNormals(P: Float32Array, I: Uint32Array): Float32Array {
  const out = new Float32Array(I.length * 3);
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3] * 3,
      b = I[t * 3 + 1] * 3,
      c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a],
      uy = P[b + 1] - P[a + 1],
      uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a],
      vy = P[c + 1] - P[a + 1],
      vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let k = 0; k < 3; k++) out.set([nx, ny, nz], (t * 3 + k) * 3);
  }
  return out;
}

/** Write a TriMesh back into the mesh data (optionally dropping unused vertices). */
export function applyTriMesh(me: MeshData, tm: TriMesh, info: { hasMask: boolean; hasSets: boolean; weights: number; colors: number[] }, compact: boolean) {
  const r = fromTriMesh(tm);
  let positions = r.positions;
  const nvAll = positions.length / 3;
  let remap = (data: number[], comps: number) => Float32Array.from(data);
  if (compact) {
    const { map, count } = compactVertices(nvAll, r.indices);
    const P = new Float32Array(count * 3);
    for (let v = 0; v < nvAll; v++) if (map[v] >= 0) P.set(positions.subarray(v * 3, v * 3 + 3), map[v] * 3);
    positions = P;
    remap = (data, comps) => {
      const out = new Float32Array(count * comps);
      for (let v = 0; v < nvAll; v++) if (map[v] >= 0) for (let k = 0; k < comps; k++) out[map[v] * comps + k] = data[v * comps + k];
      return out;
    };
  }
  me.positions = own(positions);
  me.indices = r.indices;
  me.offsets = r.offsets;
  me.uvs = r.uvs;
  me.normals = triNormals(positions, r.indices);
  me.material_index = r.mat;
  me.smooth = r.smooth;
  me.seams = undefined;
  me.sharp = undefined;
  me.creases = undefined;
  me.loose_edges = undefined;
  me.select_vert = undefined;
  me.uv_select = undefined;
  me.shape_keys = [];
  me.active_shape_key_index = 0;
  me.sculpt_face_set = info.hasSets ? r.fset : undefined;
  setHiddenFaces(me, r.hide.some((x) => x) ? r.hide : null);
  let ai = 0;
  me.sculpt_mask = info.hasMask ? own(remap(tm.vattrs[ai++].data, 1)) : undefined;
  me.weights = Array.from({ length: info.weights }, () => own(remap(tm.vattrs[ai++].data, 1)));
  const cols = me.color_attributes;
  me.color_attributes = cols
    .map((c, i) => (info.colors.includes(i) ? { ...c, data: own(remap(tm.vattrs[ai++].data, 4)) } : null))
    .filter((c): c is NonNullable<typeof c> => !!c);
  me.active_color_index = Math.min(me.active_color_index, Math.max(0, me.color_attributes.length - 1));
}

function triMeshOf(me: MeshData): { tm: TriMesh; info: { hasMask: boolean; hasSets: boolean; weights: number; colors: number[] } } {
  const va = vattrsOf(me);
  const fs = faceSetsOf(me);
  const tm = toTriMesh(me.positions, me.indices, me.uvs, { fset: fs, mat: me.material_index ?? null, smooth: me.smooth ?? null, hide: hiddenFacesOf(me) }, va.attrs);
  return { tm, info: { hasMask: va.hasMask, hasSets: !!fs, weights: va.weights, colors: va.colors } };
}

/** Detail edge length in object space around a world point. */
function detailLength(s: MeshSession, v: View3D, at: Vector3, brushRadiusLocal: number): number {
  const ts = settings();
  const method = ts.detail_type_method ?? 'RELATIVE';
  if (method === 'BRUSH') return Math.max(1e-6, brushRadiusLocal * ((ts.detail_percent ?? 25) / 100));
  if (method === 'CONSTANT' || method === 'MANUAL') return 1 / Math.max(0.01, ts.constant_detail_resolution ?? 6) / s.scale();
  return s.pixelsToLocal(v, at, ts.detail_size ?? 12);
}

function refineLimits(len: number, tool?: string): [number, number] {
  if (tool === 'SIMPLIFY') return [Infinity, len];
  const m = settings().detail_refine_method ?? 'SUBDIVIDE_COLLAPSE';
  return [m === 'COLLAPSE' ? Infinity : len, m === 'SUBDIVIDE' ? 0 : len * 0.4];
}

/** Rebuild the session / GPU geometry after the topology changed and point the stroke at it. */
function rebind(st: StrokeState) {
  dropSession();
  const s2 = meshSession()!;
  beginGeometryStroke(s2, st.me, () => {});
  st.s = s2;
  st.orig = st.me.positions.slice();
  st.origN = undefined;
  st.layer = undefined;
  st.touchedStamp = new Uint32Array(s2.nv);
  st.stamp = 1;
  st.strokeFaces = new Uint8Array(s2.nf).fill(1);
  st.mask = st.me.sculpt_mask && st.me.sculpt_mask.length === s2.nv ? st.me.sculpt_mask : undefined;
  if (st.mask) maskChanged(st.mask);
  // per-vertex stroke factors no longer match the vertices
  st.automask = null;
  invalidatePaintAttributes();
}

dyntopoHooks.begin = (st) => {
  if (!settings().use_dyntopo) return;
  if (!allTriangles(st.me)) {
    app.report('WARNING', 'Dyntopo needs a triangulated mesh: toggle Dyntopo off and on again');
    return;
  }
  const { tm, info } = triMeshOf(st.me);
  st.dyn = { tm, lastStep: 0, ...info } as DynState;
  st.dynRegion = new Set();
};

dyntopoHooks.step = (st, force) => {
  const d = st.dyn as DynState | undefined;
  const region = st.dynRegion;
  if (!d || !region || !region.size) return;
  const now = performance.now();
  if (!force && now - d.lastStep < 50) return;
  d.lastStep = now;
  const s = st.s;
  // the brush moved vertices since the last refinement
  const P = s.positions;
  for (let i = 0; i < P.length; i++) d.tm.pos[i] = P[i];
  if (d.hasMask && st.mask) for (let v = 0; v < s.nv; v++) d.tm.vattrs[0].data[v] = st.mask[v];
  const at = st.lastHit ? st.lastHit.clone().applyMatrix4(s.world()) : new Vector3().setFromMatrixPosition(s.world());
  const [maxLen, minLen] = refineLimits(detailLength(s, st.v, at, st.radiusLocal), st.tool);
  // grow the region by one ring so freshly split edges at its border settle too
  const stats = remeshRegion(d.tm, region, maxLen, minLen, 3000);
  region.clear();
  if (!stats.splits && !stats.collapses) return;
  applyTriMesh(st.me, d.tm, d, false);
  rebind(st);
};

dyntopoHooks.end = (st) => {
  const d = st.dyn as DynState | undefined;
  if (!d) return;
  dyntopoHooks.step!(st, true);
  // the remaining vertex arrays still hold collapsed vertices: drop them once per stroke
  const s = st.s;
  for (let i = 0; i < s.positions.length; i++) d.tm.pos[i] = s.positions[i];
  applyTriMesh(st.me, d.tm, d, true);
  rebind(st);
  st.dyn = undefined;
  st.dynRegion = undefined;
};

// ---------------------------------------------------------------------------
// operators

function triangulate(me: MeshData) {
  dropSession();
  const s = meshSession();
  if (!s) return;
  const tris = s.tris,
    corners = s.triCorners,
    tf = s.triFace;
  const nt = tris.length / 3;
  const uvs = new Float32Array(nt * 6);
  for (let c = 0; c < nt * 3; c++) {
    uvs[c * 2] = me.uvs[corners[c] * 2] ?? 0;
    uvs[c * 2 + 1] = me.uvs[corners[c] * 2 + 1] ?? 0;
  }
  const per = <T extends Uint8Array | Uint16Array | Int32Array>(a: T | undefined | null, ctor: new (n: number) => T): T | undefined => {
    if (!a) return undefined;
    const out = new ctor(nt);
    for (let t = 0; t < nt; t++) out[t] = a[tf[t]];
    return out;
  };
  const fs = faceSetsOf(me),
    hide = hiddenFacesOf(me);
  me.sculpt_face_set = per(fs, Int32Array);
  const hp = per(hide, Uint8Array);
  me.material_index = per(me.material_index, Uint16Array);
  me.smooth = per(me.smooth, Uint8Array);
  me.indices = Uint32Array.from(tris);
  me.offsets = Uint32Array.from({ length: nt + 1 }, (_, i) => i * 3);
  me.uvs = uvs;
  me.normals = triNormals(me.positions, me.indices);
  me.seams = undefined;
  me.sharp = undefined;
  me.creases = undefined;
  me.uv_select = undefined;
  me.loose_edges = undefined;
  me.color_attributes = me.color_attributes.filter((c) => c.domain === 'POINT');
  me.active_color_index = Math.min(me.active_color_index, Math.max(0, me.color_attributes.length - 1));
  setHiddenFaces(me, hp ?? null);
  dropSession();
  invalidatePaintAttributes();
  app.changed('geometry');
}

function floodFill(me: MeshData, len: number): number {
  const { tm, info } = triMeshOf(me);
  let total = 0;
  const [maxLen, minLen] = refineLimits(len);
  for (let pass = 0; pass < 12; pass++) {
    const region = new Set<number>();
    for (let v = 0; v < tm.pos.length / 3; v++) region.add(v);
    const st = remeshRegion(tm, region, maxLen, minLen, 200000);
    total += st.splits + st.collapses;
    if (!st.splits && !st.collapses) break;
  }
  applyTriMesh(me, tm, info, true);
  dropSession();
  invalidatePaintAttributes();
  app.changed('geometry');
  return total;
}

registerOperators([
  {
    idname: 'sculpt.dynamic_topology_toggle',
    label: 'Dynamic Topology Toggle',
    description: 'Add and remove triangles under the brush while sculpting (triangulates the mesh)',
    poll: sculptPoll,
    exec: () => {
      const ts = settings();
      const { me } = activeMeshData()!;
      ts.use_dyntopo = !ts.use_dyntopo;
      if (ts.use_dyntopo && !allTriangles(me)) {
        triangulate(me);
        app.report('INFO', 'Dyntopo: the mesh was triangulated');
      }
      app.changed('ui');
    },
  },
  {
    idname: 'sculpt.detail_flood_fill',
    label: 'Detail Flood Fill',
    description: 'Refine the whole mesh to the dyntopo detail size',
    poll: () => dyntopoOn() && !!activeMeshData(),
    exec: () => {
      const { me } = activeMeshData()!;
      if (!allTriangles(me)) triangulate(me);
      const s = meshSession();
      const v = activeView3D();
      if (!s) return 'CANCELLED';
      const center = new Vector3().setFromMatrixPosition(s.world());
      let len: number;
      const ts = settings();
      if ((ts.detail_type_method ?? 'RELATIVE') === 'RELATIVE' && v) len = s.pixelsToLocal(v, center, ts.detail_size ?? 12);
      else if (ts.detail_type_method === 'BRUSH') len = 1 / Math.max(0.01, ts.constant_detail_resolution ?? 6) / s.scale();
      else len = 1 / Math.max(0.01, ts.constant_detail_resolution ?? 6) / s.scale();
      const n = floodFill(me, len);
      app.report('INFO', `Detail Flood Fill: ${n.toLocaleString()} edges changed, ${(me.offsets.length - 1).toLocaleString()} triangles`);
    },
  },
  {
    idname: 'sculpt.sample_detail_size',
    label: 'Sample Detail Size',
    description: 'Take the detail size from the mesh under the cursor',
    props: [
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true },
      {
        id: 'mode',
        label: 'Detail Mode',
        type: 'enum',
        default: 'DYNTOPO',
        items: [
          ['DYNTOPO', 'Dyntopo', 'Sample the dyntopo detail'],
          ['VOXEL', 'Voxel', 'Sample the voxel remesh size'],
        ],
      },
    ],
    poll: () => sculptPoll() && !!activeView3D(),
    invoke: (ctx, p) => {
      const v = activeView3D()!;
      const r = v.el.getBoundingClientRect();
      const x = (ctx.event?.x ?? app.pointer.x) - r.left,
        y = (ctx.event?.y ?? app.pointer.y) - r.top;
      p.location = [x, y];
      if (meshSession()?.raycast(v, x, y)) return sampleDetail(v, p);
      // started from a button: pick the spot with the next click in the viewport
      let ok = false;
      app.startModal({
        label: 'Sample Detail Size',
        cursor: 'crosshair',
        onPointerDown: (e) => {
          if (e.button !== 0) return 'CANCELLED';
          const q = v.local(e);
          p.location = [q.x, q.y];
          ok = sampleDetail(v, p) !== 'CANCELLED';
          return ok ? 'FINISHED' : 'CANCELLED';
        },
        onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {},
        header: () => 'Sample Detail Size: click on the mesh, Esc cancels',
        redoOp: { idname: 'sculpt.sample_detail_size', props: p },
      });
      return 'RUNNING_MODAL';
    },
    exec: (_c, p) => {
      const v = activeView3D();
      return v ? sampleDetail(v, p) : 'CANCELLED';
    },
  },
]);

function sampleDetail(v: View3D, p: Record<string, unknown>): 'CANCELLED' | void {
  const s = meshSession();
  const am = activeMeshData();
  if (!s || !am) return 'CANCELLED';
  const [x, y] = p.location as number[];
  const hit = s.raycast(v, x, y);
  if (!hit) return 'CANCELLED';
  // average edge length of the face under the cursor (world units)
  let sum = 0,
    n = 0;
  for (let c = s.offsets[hit.face]; c < s.offsets[hit.face + 1]; c++) {
    const a = s.indices[c],
      b = s.indices[c + 1 < s.offsets[hit.face + 1] ? c + 1 : s.offsets[hit.face]];
    sum += Math.hypot(s.positions[a * 3] - s.positions[b * 3], s.positions[a * 3 + 1] - s.positions[b * 3 + 1], s.positions[a * 3 + 2] - s.positions[b * 3 + 2]);
    n++;
  }
  const len = (sum / Math.max(1, n)) * s.scale();
  if (p.mode === 'VOXEL') {
    am.me.remesh_voxel_size = Math.round(len * 1e5) / 1e5;
    app.report('INFO', `Voxel Size: ${am.me.remesh_voxel_size}`);
    return;
  }
  const ts = settings();
  const method = ts.detail_type_method ?? 'RELATIVE';
  if (method === 'CONSTANT' || method === 'MANUAL') ts.constant_detail_resolution = Math.round((1 / len) * 100) / 100;
  else ts.detail_size = Math.max(0.5, Math.round((len / (s.pixelsToLocal(v, hit.world, 1) * s.scale())) * 10) / 10);
  app.changed('ui');
}

// ---------------------------------------------------------------------------
// detail size edit (R with dyntopo)

const preview = { view: null as View3D | null, x: 0, y: 0, px: 0 };
editModeHooks.svg.push((v) => {
  if (preview.view !== v || preview.px <= 0) return null;
  const n = 6;
  const c = Math.max(2, preview.px);
  const half = (n * c) / 2;
  let d = '';
  // a triangle grid of the detail size
  for (let i = 0; i <= n; i++) {
    d += `M${preview.x - half} ${preview.y - half + i * c}h${n * c}`;
    d += `M${preview.x - half + i * c} ${preview.y - half}l${-Math.min(i, n) * c} ${Math.min(i, n) * c}`;
  }
  return h('g', { key: 'detail-grid', 'pointer-events': 'none' }, h('path', { d, stroke: '#000', 'stroke-width': 2, opacity: 0.35, fill: 'none' }), h('path', { d, stroke: '#fff', 'stroke-width': 1, opacity: 0.8, fill: 'none' })) as VNode;
});

registerOperators([
  {
    idname: 'sculpt.dyntopo_detail_size_edit',
    label: 'Edit Dyntopo Detail Size',
    description: 'Drag to change the dyntopo detail size',
    poll: () => dyntopoOn() && !!activeView3D(),
    invoke: (ctx) => {
      const v = activeView3D()!;
      const s = meshSession();
      if (!s) return 'CANCELLED';
      const ts = settings();
      const r = v.el.getBoundingClientRect();
      const x0 = (ctx.event?.x ?? app.pointer.x) - r.left,
        y0 = (ctx.event?.y ?? app.pointer.y) - r.top;
      const hit = s.raycast(v, x0, y0);
      const at = hit ? hit.world : new Vector3().setFromMatrixPosition(s.world());
      const pxPerWorld = 1 / (s.pixelsToLocal(v, at, 1) * s.scale());
      const constant = ts.detail_type_method === 'CONSTANT' || ts.detail_type_method === 'MANUAL';
      const brush = ts.detail_type_method === 'BRUSH';
      const before = { size: ts.detail_size, res: ts.constant_detail_resolution, pct: ts.detail_percent };
      const startPx = constant ? (1 / (ts.constant_detail_resolution ?? 6)) * pxPerWorld : brush ? ts.detail_percent ?? 25 : ts.detail_size ?? 12;
      let value = startPx;
      const show = () => {
        preview.px = constant || !brush ? (constant ? value : value) : 0;
        v.drawSvg();
      };
      Object.assign(preview, { view: v, x: x0, y: y0 });
      show();
      const label = () => (constant ? `Resolution: ${(pxPerWorld / value).toFixed(2)}` : brush ? `Detail: ${value.toFixed(1)}%` : `Detail Size: ${value.toFixed(1)} px`);
      app.startModal({
        label: 'Edit Dyntopo Detail Size',
        cursor: 'ew-resize',
        onPointerMove: (e) => {
          value = Math.max(0.5, startPx * Math.exp((e.clientX - r.left - x0) / 200));
          if (brush) value = Math.min(100, value);
          show();
        },
        onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
        onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
        cancel: () => {
          Object.assign(ts, { detail_size: before.size, constant_detail_resolution: before.res, detail_percent: before.pct });
          preview.px = 0;
          v.drawSvg();
        },
        finish: () => {
          if (constant) ts.constant_detail_resolution = Math.round((pxPerWorld / value) * 100) / 100;
          else if (brush) ts.detail_percent = Math.round(value);
          else ts.detail_size = Math.round(value * 10) / 10;
          preview.px = 0;
          v.drawSvg();
        },
        header: () => `${label()} · move left / right, click to apply, Esc cancels`,
      });
      return 'RUNNING_MODAL';
    },
  },
]);
