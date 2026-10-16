// Poly Build: the element under the mouse is highlighted while the tool is active (with a preview
// of the face Ctrl-click would make, red with Shift for deleting); operators that act on that
// element: make a face at the cursor, split an edge at the cursor, dissolve, or pick it to move.
import { Vector3 } from 'three';
import { app, registerOperators, operators, type OpContext } from '../app/app';
import { activeTools } from '../app/prefs';
import { h, type VNode } from '../ui/h';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { startTransform } from '../ops/transform';
import { editMeshObjects, inMeshEdit, worldMatrix } from '../modes/editmesh/context';
import { MeshEdit, edgeKey } from '../modes/editmesh/meshedit';
import { editPoll, deleteGeometry } from '../modes/editmesh/ops-basic';
import { pickContext, nearestVertex, nearestEdge, raycastFace, project, type PickContext } from '../modes/editmesh/pick';
import { dissolveVertex, dissolveEdgeSet, insertVertexOnEdge } from '../modes/editmesh/geom';
import type { MeshData, ObjectData } from '../data/types';

export interface PolyHover {
  ob: ObjectData;
  me: MeshData;
  c: PickContext;
  x: number;
  y: number;
  vert: number;
  edge: [number, number] | null;
  face: number;
}

/** The vertex, edge or face of the edited meshes under a viewport pixel (vertices win, then edges). */
export function polyHover(v: View3D, x: number, y: number): PolyHover | null {
  const objs = editMeshObjects();
  for (const { ob, me } of objs) {
    const c = pickContext(v, ob, me);
    const vt = nearestVertex(c, x, y, 12);
    if (vt) return { ob, me, c, x, y, vert: vt.index, edge: null, face: -1 };
    const ed = nearestEdge(c, x, y, 10);
    if (ed) return { ob, me, c, x, y, vert: -1, edge: [ed.a, ed.b], face: -1 };
  }
  for (const { ob, me } of objs) {
    const c = pickContext(v, ob, me);
    const f = raycastFace(c, x, y);
    if (f) return { ob, me, c, x, y, vert: -1, edge: null, face: f.face };
  }
  const first = objs[0];
  return first ? { ob: first.ob, me: first.me, c: pickContext(v, first.ob, first.me), x, y, vert: -1, edge: null, face: -1 } : null;
}

function hoverFromEvent(ctx: OpContext): { v: View3D; hv: PolyHover } | null {
  const v = activeView3D();
  const ev = ctx.event;
  if (!v || !ev) return null;
  const r = v.el.getBoundingClientRect();
  const hv = polyHover(v, ev.x - r.left, ev.y - r.top);
  return hv ? { v, hv } : null;
}

function selectOnly(m: MeshEdit, verts: number[]) {
  m.sel = m.sel.map(() => 0);
  for (const x of verts) m.sel[x] = 1;
}

/** Point under the mouse at the depth of `ref` (local), or on the surface under it (local). */
function pointAt(v: View3D, hv: PolyHover, ref: Vector3 | null) {
  const w = worldMatrix(hv.ob);
  const hit = raycastFace(hv.c, hv.x, hv.y);
  if (hit && !ref) return hit.point.clone();
  const depth = ref ? ref.clone().applyMatrix4(w) : new Vector3(...app.doc.scene.cursor.location);
  return v.unproject(hv.x, hv.y, depth).applyMatrix4(w.clone().invert());
}

/** The boundary edge a new face grows from: the hovered one, else a selected one. */
function buildEdge(m: MeshEdit, hv: PolyHover): [number, number] | null {
  const ef = m.edgeFaces();
  if (hv.edge && (ef.get(edgeKey(...hv.edge))?.length ?? 0) <= 1) return hv.edge;
  return m.selectedEdges().find(([a, b]) => (ef.get(edgeKey(a, b))?.length ?? 0) <= 1) ?? null;
}

/** Add a vertex at the mouse joined to the build edge as a triangle (or grown triangle → quad), or to a lone selected vertex. */
export function faceAtCursor(v: View3D, hv: PolyHover, createQuads: boolean): boolean {
  const m = MeshEdit.from(hv.me);
  const ef = m.edgeFaces();
  const edge = buildEdge(m, hv);
  const sel = m.selectedVerts();
  const ref = edge ? new Vector3(...m.p(edge[0])).lerp(new Vector3(...m.p(edge[1])), 0.5) : sel.length ? new Vector3(...m.p(sel[0])) : null;
  const pt = pointAt(v, hv, ref);
  const nv = m.addVert([pt.x, pt.y, pt.z], [], 1);
  if (edge) {
    const l = ef.get(edgeKey(...edge))?.[0];
    if (l) {
      const f = m.faces[l[0]];
      const x = f.verts[l[1]],
        y = f.verts[(l[1] + 1) % f.verts.length];
      if (createQuads && f.verts.length === 3) {
        // grow the triangle into a quad instead of adding another triangle
        const i = f.verts.indexOf(x);
        f.verts.splice(i + 1, 0, nv);
        f.uvs.splice((i + 1) * 2, 0, 0, 0);
        f.seams.splice(i + 1, 0, 0);
        f.sharp.splice(i + 1, 0, 0);
        f.creases.splice(i + 1, 0, 0);
        if (f.colors) f.colors.splice((i + 1) * 4, 0, 1, 1, 1, 1);
      } else m.faces.push(m.makeFace([y, x, nv], f));
    } else {
      // a wire edge: start a triangle
      m.faces.push(m.makeFace([edge[0], edge[1], nv]));
      m.looseEdges = m.looseEdges.filter(([a, b]) => edgeKey(a, b) !== edgeKey(...edge));
    }
  } else if (sel.length === 1) m.looseEdges.push([sel[0], nv]);
  selectOnly(m, [nv]);
  m.write(hv.me);
  app.changed('geometry', 'select');
  return true;
}

/** Split the hovered edge at the point nearest the mouse; the new vertex is selected. */
export function splitAtCursor(hv: PolyHover): boolean {
  if (!hv.edge) return false;
  const m = MeshEdit.from(hv.me);
  const [a, b] = hv.edge;
  const pa = project(hv.c, ...(m.p(a) as [number, number, number])),
    pb = project(hv.c, ...(m.p(b) as [number, number, number]));
  const dx = pb.x - pa.x,
    dy = pb.y - pa.y;
  const t = Math.min(0.98, Math.max(0.02, ((hv.x - pa.x) * dx + (hv.y - pa.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
  const p = new Vector3(...m.p(a)).lerp(new Vector3(...m.p(b)), t);
  const nv = m.addVert([p.x, p.y, p.z], [[a, 1 - t], [b, t]], 1);
  insertVertexOnEdge(m, a, b, nv, t);
  selectOnly(m, [nv]);
  m.write(hv.me);
  app.changed('geometry', 'select');
  return true;
}

/** Dissolve the hovered vertex (deleting it when it can't be dissolved) or edge. */
export function dissolveAtCursor(hv: PolyHover): boolean {
  if (hv.vert < 0 && !hv.edge) return false;
  const m = MeshEdit.from(hv.me);
  if (hv.vert >= 0) {
    if (dissolveVertex(m, hv.vert)) m.compact();
    else {
      selectOnly(m, [hv.vert]);
      deleteGeometry(m, 'VERT');
    }
  } else {
    const k = edgeKey(...hv.edge!);
    if (!dissolveEdgeSet(m, [k])) {
      selectOnly(m, hv.edge!);
      deleteGeometry(m, 'EDGE');
    } else m.compact();
  }
  m.sel = m.sel.map(() => 0);
  m.write(hv.me);
  app.changed('geometry', 'select');
  return true;
}

/** Select just the hovered element (to move it). */
export function transformAtCursor(hv: PolyHover): boolean {
  const m = MeshEdit.from(hv.me);
  if (hv.vert >= 0) selectOnly(m, [hv.vert]);
  else if (hv.edge) selectOnly(m, hv.edge);
  else if (hv.face >= 0) selectOnly(m, m.faces[hv.face].verts);
  else return false;
  m.write(hv.me);
  app.changed('select');
  return true;
}

const move = (ctx: OpContext, label: string) => {
  app.flush();
  return startTransform('TRANSLATION', { event: ctx.event, label }) ? ('RUNNING_MODAL' as const) : ('FINISHED' as const);
};
const atCursor = (fn: (v: View3D, hv: PolyHover, p: Record<string, unknown>) => boolean) => (ctx: OpContext, p: Record<string, unknown>) => {
  const at = hoverFromEvent(ctx);
  return at && fn(at.v, at.hv, p) ? ('FINISHED' as const) : ('CANCELLED' as const);
};
const thenMove = (id: string, label: string) => (ctx: OpContext, p: Record<string, unknown>) => {
  const r = operators.get(id)!.invoke!(ctx, p);
  return r === 'FINISHED' ? move(ctx, label) : r;
};
const createQuads = { id: 'create_quads', label: 'Create Quads', type: 'bool' as const, default: true };

registerOperators([
  { idname: 'mesh.polybuild_face_at_cursor', label: 'Poly Build Face at Cursor', description: 'Add a vertex at the mouse and make a face with the hovered or selected border edge', props: [createQuads], poll: editPoll, invoke: atCursor((v, hv, p) => faceAtCursor(v, hv, p.create_quads !== false)) },
  { idname: 'mesh.polybuild_split_at_cursor', label: 'Poly Build Split at Cursor', description: 'Add a vertex on the hovered edge where the mouse is', poll: editPoll, invoke: atCursor((_v, hv) => splitAtCursor(hv)) },
  { idname: 'mesh.polybuild_dissolve_at_cursor', label: 'Poly Build Dissolve at Cursor', description: 'Dissolve the hovered vertex or edge', poll: editPoll, invoke: atCursor((_v, hv) => dissolveAtCursor(hv)) },
  { idname: 'mesh.polybuild_transform_at_cursor', label: 'Poly Build Transform at Cursor', description: 'Select the hovered element to move it', poll: editPoll, invoke: atCursor((_v, hv) => transformAtCursor(hv)) },
  { idname: 'mesh.polybuild_split_at_cursor_move', label: 'Split at Cursor Move', description: 'Add a vertex on the hovered edge and move it', poll: editPoll, invoke: thenMove('mesh.polybuild_split_at_cursor', 'Poly Build Split') },
  { idname: 'mesh.polybuild_transform_at_cursor_move', label: 'Transform at Cursor Move', description: 'Move the hovered element', poll: editPoll, invoke: thenMove('mesh.polybuild_transform_at_cursor', 'Poly Build Move') },
]);

// ---------------------------------------------------------------------------
// hover preview

let pre: { v: View3D; hv: PolyHover; ctrl: boolean; shift: boolean } | null = null;
const toolOn = () => inMeshEdit() && activeTools.EDIT === 'builtin.poly_build';

function refresh(v: View3D, x: number, y: number, ctrl: boolean, shift: boolean) {
  const hv = polyHover(v, x, y);
  pre = hv ? { v, hv, ctrl, shift } : null;
  v.drawSvg();
}

let lastMouse: { v: View3D; x: number; y: number } | null = null;
editModeHooks.hover.push((v, e) => {
  if (!toolOn()) {
    if (pre) ((pre = null), v.drawSvg());
    return;
  }
  const p = v.local(e);
  lastMouse = { v, x: p.x, y: p.y };
  refresh(v, p.x, p.y, e.ctrlKey || e.metaKey, e.shiftKey);
});
for (const type of ['keydown', 'keyup'] as const)
  addEventListener(type, (e) => {
    if (!lastMouse || !toolOn() || app.modal || !['Control', 'Meta', 'Shift'].includes(e.key)) return;
    refresh(lastMouse.v, lastMouse.x, lastMouse.y, e.ctrlKey || e.metaKey, e.shiftKey);
  });

editModeHooks.svg.push((v) => {
  if (!pre || pre.v !== v || !toolOn() || app.modal) return null;
  const { hv, ctrl, shift } = pre;
  const col = shift ? '#ff5b5b' : '#ffffff';
  const P = hv.me.positions;
  const s = (i: number) => project(hv.c, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  const parts: VNode[] = [];
  if (hv.vert >= 0) {
    const q = s(hv.vert);
    parts.push(h('circle', { cx: q.x, cy: q.y, r: 5, fill: 'none', stroke: col, 'stroke-width': 2 }));
  } else if (hv.edge) {
    const a = s(hv.edge[0]),
      b = s(hv.edge[1]);
    parts.push(h('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: col, 'stroke-width': 3, 'stroke-linecap': 'round' }));
  } else if (hv.face >= 0 && !ctrl) {
    const me = hv.me;
    const pts: string[] = [];
    for (let k = me.offsets[hv.face]; k < me.offsets[hv.face + 1]; k++) {
      const q = s(me.indices[k]);
      pts.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
    }
    parts.push(h('polygon', { points: pts.join(' '), fill: col, 'fill-opacity': 0.12, stroke: col, 'stroke-width': 1.5 }));
  }
  if (ctrl && !shift) {
    // the face a Ctrl-click would make
    const m = MeshEdit.from(hv.me);
    const edge = buildEdge(m, hv);
    if (edge) {
      const a = s(edge[0]),
        b = s(edge[1]);
      parts.push(h('path', { d: `M${a.x} ${a.y}L${hv.x} ${hv.y}L${b.x} ${b.y}`, fill: 'rgba(255,255,255,0.08)', stroke: '#ffffff', 'stroke-width': 1.2, 'stroke-dasharray': '5 3' }));
    }
    parts.push(h('circle', { cx: hv.x, cy: hv.y, r: 3, fill: '#ffffff' }));
  }
  return parts.length ? h('g', { class: 'polybuild-preview' }, parts) : null;
});
