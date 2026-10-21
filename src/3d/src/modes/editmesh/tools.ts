// Edit Mode (mesh) toolbar: tool list with alternates, per-tool settings in the tool header, the
// viewport behaviour of each tool, and the interactive Bisect and Poly Build tools.
import { Vector3 } from 'three';
import { h, type Child } from '../../ui/h';
import { app, registerOperators, registerOperator, operators, onAppReady } from '../../app/app';
import { activeTools } from '../../app/prefs';
import { toolsByMode, toolSettingsRenderers, COMMON_TOOLS, type ToolDef } from '../../editors/view3d/toolbar';
import { editModeHooks } from '../../editors/view3d/hooks';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { checkbox, numberField, enumMenu } from '../../ui/widgets';
import { startTransform } from '../../ops/transform';
import { inMeshEdit, editMeshObjects, withEdit, worldMatrix } from './context';
import { MeshEdit, edgeKey } from './meshedit';
import { editPoll, smoothVertices, deleteGeometry } from './ops-basic';
import { pickContext, nearestVertex, nearestEdge, raycastFace } from './pick';
import { startValueModal } from './modal';
import { dissolveVertex } from './geom';
import { randomizeVerts } from './ops-vertex';
import { bisectMesh } from './ops-uv';
import { fillHoles } from './ops-cleanup';

const T = (id: string, label: string, icon: string, o: Partial<ToolDef> = {}): ToolDef => ({ id, label, icon, ...o });

toolsByMode.EDIT = [
  ...COMMON_TOOLS,
  null,
  T('builtin.add_cube', 'Add Cube', 'add_cube'),
  null,
  T('builtin.extrude_region', 'Extrude Region', 'extrude', { shortcut: 'E', group: 'extrude', description: 'Extrude the selection together and move it' }),
  T('builtin.extrude_manifold', 'Extrude Manifold', 'extrude_manifold', { group: 'extrude', description: 'Extrude and merge the sides into neighbouring faces' }),
  T('builtin.extrude_along_normals', 'Extrude Along Normals', 'extrude_normals', { group: 'extrude', description: 'Extrude and offset along the vertex normals' }),
  T('builtin.extrude_individual', 'Extrude Individual', 'extrude_individual', { group: 'extrude', description: 'Extrude every face separately along its normal' }),
  T('builtin.extrude_to_cursor', 'Extrude to Cursor', 'extrude_cursor', { group: 'extrude', description: 'Click to extrude the selection to the mouse, or add a vertex' }),
  T('builtin.inset_faces', 'Inset Faces', 'inset', { shortcut: 'I', description: 'Inset new faces into the selected faces' }),
  T('builtin.bevel', 'Bevel', 'bevel', { shortcut: 'Ctrl B', description: 'Cut off the selected edges or vertices at an angle' }),
  T('builtin.loop_cut', 'Loop Cut', 'loopcut', { shortcut: 'Ctrl R', group: 'loopcut', description: 'Add a loop cut' }),
  T('builtin.offset_edge_loop_cut', 'Offset Edge Loop Cut', 'offset_edge_loop', { shortcut: 'Shift Ctrl R', group: 'loopcut', description: 'Add edge loops on both sides of the selected edges' }),
  T('builtin.knife', 'Knife', 'knife', { shortcut: 'K', group: 'knife', description: 'Cut new topology' }),
  T('builtin.bisect', 'Bisect', 'bisect', { group: 'knife', description: 'Drag a line to cut the selection in two' }),
  T('builtin.poly_build', 'Poly Build', 'poly_build', { description: 'Click a boundary edge to extend it, Ctrl-click to add faces, Shift-click to delete' }),
  T('builtin.spin', 'Spin', 'spin', { group: 'spin', description: 'Extrude the selection around the 3D cursor' }),
  T('builtin.spin_duplicates', 'Spin Duplicates', 'spin_dup', { group: 'spin', description: 'Duplicate the selection around the 3D cursor' }),
  T('builtin.smooth', 'Smooth', 'smooth', { group: 'smooth', description: 'Drag to smooth the selected vertices' }),
  T('builtin.randomize', 'Randomize', 'randomize', { group: 'smooth', description: 'Drag to move the selected vertices randomly' }),
  T('builtin.edge_slide', 'Edge Slide', 'edge_slide', { group: 'slide', description: 'Slide edges along the surface' }),
  T('builtin.vertex_slide', 'Vertex Slide', 'vertex_slide', { shortcut: 'Shift V', group: 'slide', description: 'Slide vertices along an edge' }),
  T('builtin.shrink_fatten', 'Shrink/Fatten', 'shrink_fatten', { shortcut: 'Alt S', group: 'shrink', description: 'Move the selection along its normals' }),
  T('builtin.push_pull', 'Push/Pull', 'push_pull', { group: 'shrink', description: 'Move the selection towards or away from its centre' }),
  T('builtin.to_sphere', 'To Sphere', 'to_sphere', { shortcut: 'Shift Alt S', description: 'Make the selection rounder' }),
  T('builtin.rip_region', 'Rip Region', 'rip', { shortcut: 'V', group: 'rip', description: 'Tear the selection away from the surrounding faces' }),
  T('builtin.rip_edge', 'Rip Edge', 'rip_edge', { shortcut: 'Alt D', group: 'rip', description: 'Extend boundary vertices into new faces' }),
];

// ---------------------------------------------------------------------------
// tool settings (shown in the tool header and used when the tool runs)

export const toolProps: Record<string, Record<string, unknown>> = {
  'builtin.extrude_region': { use_dissolve_ortho_edges: false },
  'builtin.inset_faces': { use_individual: false, use_outset: false },
  'builtin.bevel': { offset_type: 'OFFSET', affect: 'EDGES', segments: 1, profile: 0.5 },
  'builtin.knife': { use_occlude_geometry: true, only_selected: false },
  'builtin.bisect': { use_fill: false, clear_inner: false, clear_outer: false },
  'builtin.poly_build': { create_quads: true },
  'builtin.spin': { steps: 12 },
  'builtin.spin_duplicates': { steps: 12 },
  'builtin.smooth': { repeat: 1 },
  'builtin.randomize': { uniform: 0, normal: 0, seed: 0 },
};

const field = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);
const refresh = () => app.changed('ui');
const tp = (tool: string) => toolProps[tool];
const check = (tool: string, key: string, label: string, tip: string) => checkbox(`${tool}-${key}`, label, !!tp(tool)[key], (v) => ((tp(tool)[key] = v), refresh()), { tip });
const num = (tool: string, key: string, label: string, o: { min?: number; max?: number; int?: boolean; unit?: 'factor' }) =>
  field(110, numberField({ id: `${tool}-${key}`, label, value: tp(tool)[key] as number, set: (v) => ((tp(tool)[key] = v), refresh()), ...o }));

toolSettingsRenderers['builtin.extrude_region'] = () => check('builtin.extrude_region', 'use_dissolve_ortho_edges', 'Dissolve Orthogonal Edges', 'Merge the new side faces into coplanar neighbours');
toolSettingsRenderers['builtin.inset_faces'] = () => [check('builtin.inset_faces', 'use_individual', 'Individual', 'Inset each face separately'), check('builtin.inset_faces', 'use_outset', 'Outset', 'Grow outwards instead of inwards')];
toolSettingsRenderers['builtin.bevel'] = () => [
  field(
    110,
    enumMenu(
      'bevel-type',
      ['OFFSET', 'WIDTH', 'DEPTH', 'PERCENT', 'ABSOLUTE'].map((v) => ({ value: v, label: v[0] + v.slice(1).toLowerCase() })),
      tp('builtin.bevel').offset_type as string,
      (v) => ((tp('builtin.bevel').offset_type = v), refresh()),
      { tip: 'What the dragged amount measures' },
    ),
  ),
  field(
    110,
    enumMenu(
      'bevel-affect',
      [
        { value: 'VERTICES', label: 'Vertices' },
        { value: 'EDGES', label: 'Edges' },
      ],
      tp('builtin.bevel').affect as string,
      (v) => ((tp('builtin.bevel').affect = v), refresh()),
      { tip: 'Bevel vertices or edges' },
    ),
  ),
  num('builtin.bevel', 'segments', 'Segments', { min: 1, max: 100, int: true }),
  num('builtin.bevel', 'profile', 'Shape', { min: 0, max: 1, unit: 'factor' }),
];
toolSettingsRenderers['builtin.knife'] = () => [check('builtin.knife', 'use_occlude_geometry', 'Occlude Geometry', 'Only cut the faces you can see'), check('builtin.knife', 'only_selected', 'Only Selected', 'Only cut selected faces')];
toolSettingsRenderers['builtin.bisect'] = () => [check('builtin.bisect', 'use_fill', 'Fill', 'Fill the cut with a face'), check('builtin.bisect', 'clear_inner', 'Clear Inner', 'Remove the part behind the line'), check('builtin.bisect', 'clear_outer', 'Clear Outer', 'Remove the part in front of the line')];
toolSettingsRenderers['builtin.poly_build'] = () => check('builtin.poly_build', 'create_quads', 'Create Quads', 'Turn the new triangles into quads when possible');
toolSettingsRenderers['builtin.spin'] = () => num('builtin.spin', 'steps', 'Steps', { min: 1, max: 256, int: true });
toolSettingsRenderers['builtin.spin_duplicates'] = () => num('builtin.spin_duplicates', 'steps', 'Steps', { min: 1, max: 256, int: true });
toolSettingsRenderers['builtin.smooth'] = () => num('builtin.smooth', 'repeat', 'Repeat', { min: 1, max: 100, int: true });
toolSettingsRenderers['builtin.randomize'] = () => [num('builtin.randomize', 'uniform', 'Uniform', { min: 0, max: 1, unit: 'factor' }), num('builtin.randomize', 'normal', 'Normal', { min: 0, max: 1, unit: 'factor' }), num('builtin.randomize', 'seed', 'Seed', { min: 0, max: 10000, int: true })];

// ---------------------------------------------------------------------------
// viewport behaviour: click selects, drag runs the tool (or press runs it)

type Run = (v: View3D, e: { x: number; y: number }) => void;
const op = (id: string, props: () => Record<string, unknown> = () => ({})): Run => (_v, e) => void app.run(id, props(), { event: e });

const dragTools: Record<string, Run> = {
  'builtin.extrude_region': op('mesh.extrude_context_move', () => tp('builtin.extrude_region')),
  'builtin.extrude_manifold': op('mesh.extrude_manifold'),
  'builtin.extrude_along_normals': op('mesh.extrude_region_shrink_fatten'),
  'builtin.extrude_individual': op('mesh.extrude_faces_move'),
  'builtin.inset_faces': op('mesh.inset', () => tp('builtin.inset_faces')),
  'builtin.bevel': op('mesh.bevel', () => tp('builtin.bevel')),
  'builtin.bisect': (v, e) => void startBisect(v, e),
  'builtin.spin': op('mesh.spin', () => ({ steps: tp('builtin.spin').steps })),
  'builtin.spin_duplicates': op('mesh.spin', () => ({ steps: tp('builtin.spin_duplicates').steps, dupli: true })),
  'builtin.smooth': (_v, e) =>
    void startValueModal({ label: 'Smooth Vertices', idname: 'mesh.vertices_smooth', prop: 'factor', props: { repeat: tp('builtin.smooth').repeat }, initial: 0, min: 0, max: 1, perPixel: 0.004, name: 'Smoothing', apply: (m, f) => smoothVertices(m, f, tp('builtin.smooth').repeat as number) }, e),
  'builtin.randomize': (_v, e) => {
    const o = tp('builtin.randomize');
    void startValueModal({ label: 'Randomize', idname: 'transform.vertex_random', prop: 'offset', props: { ...o }, initial: 0, perPixel: 0.002, name: 'Amount', apply: (m, x) => randomizeVerts(m, x, o.uniform as number, o.normal as number, o.seed as number) }, e);
  },
  'builtin.edge_slide': op('transform.edge_slide'),
  'builtin.vertex_slide': op('transform.vert_slide'),
  'builtin.shrink_fatten': op('transform.shrink_fatten'),
  'builtin.push_pull': op('transform.push_pull'),
  'builtin.to_sphere': op('transform.tosphere'),
  'builtin.rip_region': op('mesh.rip_move'),
  'builtin.rip_edge': op('mesh.rip_edge_move'),
};
const pressTools: Record<string, (v: View3D, e: PointerEvent) => boolean> = {
  'builtin.loop_cut': (_v, e) => (app.run('mesh.loopcut_slide', {}, { event: { x: e.clientX, y: e.clientY } }), true),
  'builtin.offset_edge_loop_cut': (_v, e) => app.run('mesh.offset_edge_loops_slide', {}, { event: { x: e.clientX, y: e.clientY } }) === 'RUNNING_MODAL',
  'builtin.extrude_to_cursor': (_v, e) => (app.run('mesh.dupli_extrude_cursor', {}, { event: { x: e.clientX, y: e.clientY } }), true),
  'builtin.poly_build': (v, e) => polyBuild(v, e),
};

/**
 * Tools started by a drag finish when the mouse button is released (like a click would confirm them),
 * so one drag is one complete operation.
 */
export function confirmOnRelease() {
  const started = app.modal;
  if (!started) return;
  const up = (ev: PointerEvent) => {
    removeEventListener('pointerup', up, true);
    if (ev.button !== 0) return;
    // let the modal see the release first (some confirm on it themselves)
    setTimeout(() => {
      if (app.modal !== started) return;
      const r = started.onPointerDown?.(ev);
      if (r === 'FINISHED' || r === 'CANCELLED') app.endModal(r);
    }, 0);
  };
  addEventListener('pointerup', up, true);
}

editModeHooks.pointer.push((v, e) => {
  if (!inMeshEdit() || e.button !== 0) return false;
  const tool = activeTools.EDIT;
  if (pressTools[tool]) return pressTools[tool](v, e);
  const run = dragTools[tool];
  if (!run) return false;
  const sx = e.clientX,
    sy = e.clientY;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    cleanup();
    run(v, { x: sx, y: sy });
    confirmOnRelease();
  };
  const up = () => {
    cleanup();
    const r = v.el.getBoundingClientRect();
    for (const hk of editModeHooks.pick) if (hk(v, sx - r.left, sy - r.top, { extend: e.shiftKey, toggle: e.shiftKey, deselectAll: !e.shiftKey })) break;
  };
  const cleanup = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
});

// ---------------------------------------------------------------------------
// bisect: drag a line in the view

let bisectLine: { v: View3D; a: { x: number; y: number }; b: { x: number; y: number } } | null = null;

editModeHooks.svg.push((v) => {
  if (!bisectLine || bisectLine.v !== v) return null;
  const { a, b } = bisectLine;
  return h('g', { class: 'bisect-line' }, h('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#fcd845', 'stroke-width': 1.6, 'stroke-dasharray': '6 4' }));
});

/** Plane (world) through the screen line a→b, containing the view direction. */
export function planeFromLine(v: View3D, a: { x: number; y: number }, b: { x: number; y: number }) {
  const depth = new Vector3(...app.doc.scene.cursor.location);
  const A = v.unproject(a.x, a.y, depth),
    B = v.unproject(b.x, b.y, depth);
  const mid = A.clone().lerp(B, 0.5);
  const viewDir = v.nav.ortho ? new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion) : mid.clone().sub(v.camera.position).normalize();
  const no = B.clone().sub(A).cross(viewDir).normalize();
  return { co: A, no };
}

function startBisect(v: View3D, start: { x: number; y: number } | null, props: Record<string, unknown> = tp('builtin.bisect')): 'RUNNING_MODAL' {
  const r = v.el.getBoundingClientRect();
  const local = (p: { x: number; y: number }) => ({ x: p.x - r.left, y: p.y - r.top });
  bisectLine = start ? { v, a: local(start), b: local(start) } : null;
  let result: Record<string, unknown> | null = null;
  app.startModal({
    label: 'Bisect',
    header: () => (bisectLine ? 'Bisect: release to cut along the line' : 'Bisect: drag a line across the selection'),
    status: () => [['LMB Drag', 'Draw Cut Line'], ['Esc', 'Cancel']],
    onPointerDown(e) {
      if (e.button === 2) return 'CANCELLED';
      if (e.button === 0) bisectLine = { v, a: local({ x: e.clientX, y: e.clientY }), b: local({ x: e.clientX, y: e.clientY }) };
      return undefined;
    },
    onPointerMove(e) {
      if (!bisectLine) return;
      bisectLine.b = local({ x: e.clientX, y: e.clientY });
      v.drawSvg();
    },
    onPointerUp() {
      if (!bisectLine) return undefined;
      const line = bisectLine;
      if (Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) < 4) return 'CANCELLED';
      const { co, no } = planeFromLine(v, line.a, line.b);
      result = { ...props, plane_co: [co.x, co.y, co.z], plane_no: [no.x, no.y, no.z] };
      bisectExec(result);
      return 'FINISHED';
    },
    onKey(e) {
      if (e.type === 'keydown' && e.key === 'Escape') return 'CANCELLED';
      return true;
    },
    cancel() {
      bisectLine = null;
      v.drawSvg();
    },
    finish() {
      bisectLine = null;
      v.drawSvg();
      if (result) this.redoOp = { idname: 'mesh.bisect', props: result };
    },
  });
  return 'RUNNING_MODAL';
}

/** Cut with the bisect plane (world props), optionally filling the open cut and clearing a side. */
function bisectExec(p: Record<string, unknown>) {
  const co = new Vector3(...(p.plane_co as [number, number, number])),
    no = new Vector3(...(p.plane_no as [number, number, number]));
  return withEdit((m, ob) => {
    const inv = worldMatrix(ob).clone().invert();
    bisectMesh(m, co.clone().applyMatrix4(inv), no.clone().transformDirection(inv), !!p.clear_inner, !!p.clear_outer);
    if (p.use_fill) fillHoles(m, 0);
  });
}

onAppReady(() => {
  const base = operators.get('mesh.bisect');
  if (!base) return;
  registerOperator({
    ...base,
    description: 'Cut the selection along a line drawn across the view',
    props: [...(base.props ?? []).filter((d) => d.id !== 'use_fill'), { id: 'use_fill', label: 'Fill', type: 'bool', default: false }],
    invoke: (ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      return startBisect(v, null, { use_fill: p.use_fill, clear_inner: p.clear_inner, clear_outer: p.clear_outer });
    },
    exec: (ctx, p) => {
      if (!p.use_fill) return base.exec?.(ctx, p);
      const r = base.exec?.(ctx, { ...p });
      withEdit((m) => fillHoles(m, 0) > 0);
      return r;
    },
  });
});

// ---------------------------------------------------------------------------
// poly build

function hovered(v: View3D, e: { clientX: number; clientY: number }) {
  const r = v.el.getBoundingClientRect();
  const x = e.clientX - r.left,
    y = e.clientY - r.top;
  for (const { ob, me } of editMeshObjects()) {
    const c = pickContext(v, ob, me);
    const vt = nearestVertex(c, x, y, 12);
    if (vt) return { ob, me, c, x, y, vert: vt.index, edge: null as [number, number] | null };
    const ed = nearestEdge(c, x, y, 10);
    if (ed) return { ob, me, c, x, y, vert: -1, edge: [ed.a, ed.b] as [number, number] };
  }
  const first = editMeshObjects()[0];
  return first ? { ob: first.ob, me: first.me, c: pickContext(v, first.ob, first.me), x, y, vert: -1, edge: null } : null;
}

/** World point under the mouse at the depth of `ref` (local), or on the surface. */
function pointAt(v: View3D, hv: NonNullable<ReturnType<typeof hovered>>, ref: Vector3 | null) {
  const w = worldMatrix(hv.ob);
  const hit = raycastFace(hv.c, hv.x, hv.y);
  if (hit && !ref) return hit.point.clone();
  const depth = ref ? ref.clone().applyMatrix4(w) : new Vector3(...app.doc.scene.cursor.location);
  return v.unproject(hv.x, hv.y, depth).applyMatrix4(w.clone().invert());
}

function selectOnly(m: MeshEdit, verts: number[]) {
  m.sel = m.sel.map(() => 0);
  for (const x of verts) m.sel[x] = 1;
}

function polyBuild(v: View3D, e: PointerEvent): boolean {
  const ev = { x: e.clientX, y: e.clientY };
  if (e.shiftKey) return app.run('mesh.polybuild_delete_at_cursor', {}, { event: ev }) === 'FINISHED' || true;
  if (e.ctrlKey || e.metaKey) return app.run('mesh.polybuild_face_at_cursor_move', { create_quads: tp('builtin.poly_build').create_quads }, { event: ev }) !== 'CANCELLED' || true;
  app.run('mesh.polybuild_extrude_at_cursor_move', {}, { event: ev });
  void v;
  return true;
}

registerOperators([
  {
    idname: 'mesh.polybuild_extrude_at_cursor_move',
    label: 'Poly Build Extrude at Cursor',
    description: 'Drag a hovered boundary edge out into a new face, or move a hovered vertex',
    poll: editPoll,
    invoke: (ctx) => {
      const v = activeView3D();
      const ev = ctx.event;
      if (!v || !ev) return 'CANCELLED';
      const hv = hovered(v, { clientX: ev.x, clientY: ev.y });
      if (!hv || (hv.vert < 0 && !hv.edge)) return 'CANCELLED';
      const m = MeshEdit.from(hv.me);
      if (hv.vert >= 0) selectOnly(m, [hv.vert]);
      else {
        const [a, b] = hv.edge!;
        const ef = m.edgeFaces().get(edgeKey(a, b)) ?? [];
        if (ef.length === 1) {
          // new quad on the open side of the boundary edge
          const f = m.faces[ef[0][0]];
          const x = f.verts[ef[0][1]],
            y = f.verts[(ef[0][1] + 1) % f.verts.length];
          const nx = m.addVert(m.p(x), [[x, 1]], 1),
            ny = m.addVert(m.p(y), [[y, 1]], 1);
          m.faces.push(m.makeFace([y, x, nx, ny], f));
          selectOnly(m, [nx, ny]);
        } else selectOnly(m, [a, b]);
      }
      m.write(hv.me);
      app.changed('geometry', 'select');
      app.flush();
      return startTransform('TRANSLATION', { event: ev, label: 'Poly Build' }) ? 'RUNNING_MODAL' : 'CANCELLED';
    },
  },
  {
    idname: 'mesh.polybuild_face_at_cursor_move',
    label: 'Poly Build Face at Cursor',
    description: 'Add a vertex at the mouse and connect it to the hovered or selected boundary edge',
    props: [{ id: 'create_quads', label: 'Create Quads', type: 'bool', default: true }],
    poll: editPoll,
    invoke: (ctx, p) => {
      const v = activeView3D();
      const ev = ctx.event;
      if (!v || !ev) return 'CANCELLED';
      const hv = hovered(v, { clientX: ev.x, clientY: ev.y });
      if (!hv) return 'CANCELLED';
      const m = MeshEdit.from(hv.me);
      const ef = m.edgeFaces();
      // the edge to build from: hovered boundary edge, else a selected boundary edge
      let edge = hv.edge && ef.get(edgeKey(...hv.edge))?.length === 1 ? hv.edge : null;
      if (!edge) edge = m.selectedEdges().find(([a, b]) => ef.get(edgeKey(a, b))?.length === 1) ?? null;
      const sel = m.selectedVerts();
      const ref = edge ? new Vector3(...m.p(edge[0])).lerp(new Vector3(...m.p(edge[1])), 0.5) : sel.length ? new Vector3(...m.p(sel[0])) : null;
      const pt = pointAt(v, hv, ref);
      const nv = m.addVert([pt.x, pt.y, pt.z], [], 1);
      if (edge) {
        const l = ef.get(edgeKey(...edge))![0];
        const f = m.faces[l[0]];
        const x = f.verts[l[1]],
          y = f.verts[(l[1] + 1) % f.verts.length];
        if (p.create_quads && f.verts.length === 3) {
          // grow the triangle into a quad instead of adding another triangle
          const i = f.verts.indexOf(x);
          f.verts.splice(i + 1, 0, nv);
          f.uvs.splice((i + 1) * 2, 0, 0, 0);
          f.seams.splice(i + 1, 0, 0);
          f.sharp.splice(i + 1, 0, 0);
          f.creases.splice(i + 1, 0, 0);
          if (f.colors) f.colors.splice((i + 1) * 4, 0, 1, 1, 1, 1);
        } else m.faces.push(m.makeFace([y, x, nv], f));
      } else if (sel.length === 1) m.looseEdges.push([sel[0], nv]);
      selectOnly(m, [nv]);
      m.write(hv.me);
      app.changed('geometry', 'select');
      app.flush();
      return startTransform('TRANSLATION', { event: ev, label: 'Poly Build Face' }) ? 'RUNNING_MODAL' : 'FINISHED';
    },
  },
  {
    idname: 'mesh.polybuild_delete_at_cursor',
    label: 'Poly Build Delete at Cursor',
    description: 'Remove the hovered vertex (dissolving it when possible) or the hovered edge',
    poll: editPoll,
    invoke: (ctx) => {
      const v = activeView3D();
      const ev = ctx.event;
      if (!v || !ev) return 'CANCELLED';
      const hv = hovered(v, { clientX: ev.x, clientY: ev.y });
      if (!hv || (hv.vert < 0 && !hv.edge)) return 'CANCELLED';
      const m = MeshEdit.from(hv.me);
      if (hv.vert >= 0) {
        if (!dissolveVertex(m, hv.vert)) {
          selectOnly(m, [hv.vert]);
          deleteGeometry(m, 'VERT');
        } else m.compact();
      } else {
        selectOnly(m, hv.edge!);
        deleteGeometry(m, 'EDGE');
      }
      m.sel = m.sel.map(() => 0);
      m.write(hv.me);
      app.changed('geometry', 'select');
      return 'FINISHED';
    },
  },
]);

