// Knife tool: draw a polyline over the mesh (snapping to vertices and edges); on confirm,
// every visible face crossed by a segment is split along the cut plane of that segment.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { editModeHooks } from '../../editors/view3d/hooks';
import { h } from '../../ui/h';
import { editMeshObjects } from './context';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { pickContext, nearestVertex, nearestEdge, raycastFace, type PickContext } from './pick';
import { editPoll } from './ops-basic';
import { addKeys } from '../../app/keymap';
import type { ObjectData, MeshData } from '../../data/types';
import { activeTools } from '../../app/prefs';
import { toolProps } from './tools';

interface KPoint {
  world: Vector3;
  screen: { x: number; y: number };
}

let state: { v: View3D; points: KPoint[]; cursor: KPoint | null; cuts: KPoint[][]; cutThrough: boolean; onlySelected: boolean; midpoints: boolean; noSnap: boolean; axis: number; angleSnap: boolean } | null = null;

editModeHooks.svg.push((v) => {
  if (!state || state.v !== v) return null;
  const all = [...state.cuts, state.points];
  const parts = all.map((pts, i) => {
    const line = [...pts, ...(i === all.length - 1 && state!.cursor ? [state!.cursor] : [])];
    return h(
      'g',
      { key: i },
      h('path', { d: line.map((p, k) => `${k ? 'L' : 'M'}${p.screen.x.toFixed(1)} ${p.screen.y.toFixed(1)}`).join(''), fill: 'none', stroke: '#18fb95', 'stroke-width': 1.6 }),
      pts.map((p, k) => h('circle', { key: k, cx: p.screen.x, cy: p.screen.y, r: 3.5, fill: '#18fb95' })),
    );
  });
  if (state.cursor) parts.push(h('circle', { cx: state.cursor.screen.x, cy: state.cursor.screen.y, r: 4, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.5 }));
  return h('g', { class: 'knife' }, parts);
});

function snap(v: View3D, x: number, y: number): KPoint | null {
  for (const { ob, me } of editMeshObjects()) {
    const c = pickContext(v, ob, me);
    const world = c.world;
    if (state?.noSnap) {
      // Ctrl: no vertex/edge snapping, cut anywhere on the surface
      const hit = raycastFace(c, x, y);
      if (hit) {
        const p = hit.point.clone().applyMatrix4(world);
        return { world: p, screen: v.project(p) };
      }
      continue;
    }
    const vt = nearestVertex(c, x, y, 10);
    if (vt) {
      const p = new Vector3(me.positions[vt.index * 3], me.positions[vt.index * 3 + 1], me.positions[vt.index * 3 + 2]).applyMatrix4(world);
      return { world: p, screen: v.project(p) };
    }
    const e = nearestEdge(c, x, y, 8);
    if (e) {
      const a = new Vector3(me.positions[e.a * 3], me.positions[e.a * 3 + 1], me.positions[e.a * 3 + 2]).applyMatrix4(world);
      const b = new Vector3(me.positions[e.b * 3], me.positions[e.b * 3 + 1], me.positions[e.b * 3 + 2]).applyMatrix4(world);
      const sa = v.project(a),
        sb = v.project(b);
      const dx = sb.x - sa.x,
        dy = sb.y - sa.y;
      // Shift: snap to the edge midpoint
      const t = state?.midpoints ? 0.5 : Math.max(0, Math.min(1, ((x - sa.x) * dx + (y - sa.y) * dy) / (dx * dx + dy * dy || 1)));
      const p = a.lerp(b, t);
      return { world: p, screen: v.project(p) };
    }
    const hit = raycastFace(c, x, y);
    if (hit) {
      const p = hit.point.clone().applyMatrix4(world);
      return { world: p, screen: v.project(p) };
    }
  }
  return null;
}

/** The next cut point under axis or angle constraints (relative to the last point), or null. */
function constrained(v: View3D, p: { x: number; y: number }): KPoint | null {
  if (!state) return null;
  const last = state.points[state.points.length - 1];
  if (!last || (state.axis < 0 && !state.angleSnap)) return null;
  if (state.axis >= 0) {
    // closest point on the axis line through the last point to the mouse ray
    const dir = new Vector3().setComponent(state.axis, 1);
    const { origin, dir: rd } = v.ray(p.x, p.y);
    const w0 = last.world.clone().sub(origin);
    const b = dir.dot(rd),
      d = dir.dot(w0),
      e = rd.dot(w0);
    const denom = 1 - b * b;
    const t = Math.abs(denom) < 1e-9 ? 0 : (b * e - d) / denom;
    const world = last.world.clone().addScaledVector(dir, t);
    return { world, screen: v.project(world) };
  }
  // screen angle snapped to 30° steps
  const dx = p.x - last.screen.x,
    dy = p.y - last.screen.y;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 6;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  const q = { x: last.screen.x + Math.cos(ang) * len, y: last.screen.y + Math.sin(ang) * len };
  const saved = state.noSnap;
  state.noSnap = true;
  const hit = snap(v, q.x, q.y);
  state.noSnap = saved;
  return hit ?? { world: v.unproject(q.x, q.y, last.world), screen: q };
}

/** Cut faces of one mesh with a segment A→B (world space) seen from the view. */
export function knifeCut(m: MeshEdit, c: PickContext | null, A: Vector3, B: Vector3, view: Vector3, worldToLocal: Matrix4, project: (p: Vector3) => { x: number; y: number }, visible: (f: number, p: Vector3) => boolean) {
  const a = A.clone().applyMatrix4(worldToLocal),
    b = B.clone().applyMatrix4(worldToLocal);
  const vd = view.clone().transformDirection(worldToLocal);
  const n = b.clone().sub(a).cross(vd).normalize();
  if (n.lengthSq() < 1e-12) return;
  const sa = project(A),
    sb = project(B);
  const dir = { x: sb.x - sa.x, y: sb.y - sa.y };
  const len2 = dir.x * dir.x + dir.y * dir.y || 1;
  const param = (p: Vector3) => {
    const s = project(p.clone().applyMatrix4(worldToLocal.clone().invert()));
    return ((s.x - sa.x) * dir.x + (s.y - sa.y) * dir.y) / len2;
  };
  const side = (v: number) => new Vector3(...m.p(v)).sub(a).dot(n);
  const newV = new Map<string, number>();
  const cutVert = (u: number, w: number) => {
    const k = edgeKey(u, w);
    let id = newV.get(k);
    if (id === undefined) {
      const su = side(u),
        sw = side(w);
      const t = su / (su - sw);
      const p = new Vector3(...m.p(u)).lerp(new Vector3(...m.p(w)), t);
      id = m.addVert([p.x, p.y, p.z], [[u, 1 - t], [w, t]], 1);
      newV.set(k, id);
    }
    return id;
  };
  const eps = 1e-6;
  const splitFaces = new Map<number, [number, number]>(); // face -> corner indices of crossing edges
  m.faces.forEach((f, fi) => {
    const s = f.verts.map(side);
    const crossings: number[] = [];
    for (let i = 0; i < f.verts.length; i++) {
      const j = (i + 1) % f.verts.length;
      if ((s[i] > eps && s[j] < -eps) || (s[i] < -eps && s[j] > eps)) crossings.push(i);
    }
    if (crossings.length !== 2) return;
    // intersection points must lie within the drawn segment
    const pts = crossings.map((i) => {
      const u = f.verts[i],
        w = f.verts[(i + 1) % f.verts.length];
      const t = s[i] / (s[i] - s[(i + 1) % f.verts.length]);
      return new Vector3(...m.p(u)).lerp(new Vector3(...m.p(w)), t);
    });
    const t0 = param(pts[0]),
      t1 = param(pts[1]);
    if (Math.min(t0, t1) < -0.02 || Math.max(t0, t1) > 1.02) return;
    const mid = pts[0].clone().lerp(pts[1], 0.5);
    if (!visible(fi, mid)) return;
    splitFaces.set(fi, [crossings[0], crossings[1]]);
  });
  if (!splitFaces.size) return;
  const out: EFace[] = [];
  m.faces.forEach((f, fi) => {
    const sp = splitFaces.get(fi);
    const n0 = f.verts.length;
    // insert cut vertices on crossing edges (for split faces) or on edges that were cut by neighbours
    const verts: number[] = [],
      uvs: number[] = [],
      isCut: boolean[] = [];
    for (let i = 0; i < n0; i++) {
      const u = f.verts[i],
        w = f.verts[(i + 1) % n0];
      verts.push(u);
      uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
      isCut.push(false);
      const k = edgeKey(u, w);
      const crossingHere = sp && (sp[0] === i || sp[1] === i);
      if (crossingHere || (newV.has(k) && !sp)) {
        const id = crossingHere ? cutVert(u, w) : newV.get(k)!;
        const su = side(u),
          sw = side(w);
        const t = Math.max(0, Math.min(1, su / (su - sw || 1)));
        const j = (i + 1) % n0;
        verts.push(id);
        uvs.push(f.uvs[i * 2] + (f.uvs[j * 2] - f.uvs[i * 2]) * t, f.uvs[i * 2 + 1] + (f.uvs[j * 2 + 1] - f.uvs[i * 2 + 1]) * t);
        isCut.push(!!crossingHere);
      }
    }
    if (!sp) {
      out.push(verts.length === n0 ? f : m.makeFace(verts, f, uvs));
      return;
    }
    const idx = isCut.map((c2, i) => (c2 ? i : -1)).filter((i) => i >= 0);
    if (idx.length !== 2) return out.push(m.makeFace(verts, f, uvs));
    const [p, q] = idx;
    const part = (from: number, to: number) => {
      const vv: number[] = [],
        uu: number[] = [];
      for (let k = from; ; k = (k + 1) % verts.length) {
        vv.push(verts[k]);
        uu.push(uvs[k * 2], uvs[k * 2 + 1]);
        if (k === to) break;
      }
      return m.makeFace(vv, f, uu);
    };
    out.push(part(p, q), part(q, p));
  });
  // neighbour faces that share a cut edge but were processed before the vertex existed
  m.faces = out.map((f) => {
    const n0 = f.verts.length;
    for (let i = 0; i < n0; i++) {
      const k = edgeKey(f.verts[i], f.verts[(i + 1) % n0]);
      if (newV.has(k) && !f.verts.includes(newV.get(k)!)) {
        const id = newV.get(k)!;
        const verts = [...f.verts.slice(0, i + 1), id, ...f.verts.slice(i + 1)];
        const uv = [f.uvs[i * 2], f.uvs[i * 2 + 1]];
        const uvs = [...f.uvs.slice(0, (i + 1) * 2), ...uv, ...f.uvs.slice((i + 1) * 2)];
        return m.makeFace(verts, f, uvs);
      }
    }
    return f;
  });
  void c;
}

function confirm() {
  if (!state) return;
  const v = state.v;
  const cuts = [...state.cuts, state.points].filter((c) => c.length >= 2);
  for (const { ob, me } of editMeshObjects()) cutObject(v, ob, me, cuts, { cutThrough: state.cutThrough, onlySelected: state.onlySelected });
  app.changed('geometry');
}

export function cutObject(v: View3D, ob: ObjectData, me: MeshData, cuts: KPoint[][], o: { cutThrough?: boolean; onlySelected?: boolean } = {}) {
  const m = MeshEdit.from(me);
  // only selected: faces whose original vertices were all selected (cut vertices are new)
  const wasSel = m.sel.slice();
  const nv0 = m.vcount;
  const allowed = (fi: number) => !o.onlySelected || m.faces[fi].verts.every((x) => x >= nv0 || wasSel[x]);
  const world = app.graph.get(ob.id)?.world ?? new Matrix4();
  const inv = world.clone().invert();
  const before = m.faces.length;
  m.sel = m.sel.map(() => 0);
  for (const pts of cuts)
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i].world,
        B = pts[i + 1].world;
      const mid = A.clone().lerp(B, 0.5);
      const viewDir = v.nav.ortho && !v.sceneCamera ? new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion) : mid.clone().sub(v.camera.position).normalize();
      // visibility is tested against the mesh as it was before cutting
      const c = pickContext(v, ob, me);
      knifeCut(
        m,
        c,
        A,
        B,
        viewDir,
        inv,
        (p) => v.project(p.clone().applyMatrix4(world)),
        (fi, pLocal) => {
          if (!allowed(fi)) return false;
          if (c.xray || o.cutThrough) return true;
          const s = v.project(pLocal.clone().applyMatrix4(world));
          const hit = raycastFace(c, s.x, s.y);
          if (!hit) return false;
          return hit.point.distanceTo(pLocal) < Math.max(1e-3, pLocal.length() * 1e-3) * 50;
        },
      );
    }
  if (m.faces.length !== before) m.write(me);
}

function start(opts: { occlude?: boolean; onlySelected?: boolean } = {}): 'RUNNING_MODAL' | 'CANCELLED' {
  const v = activeView3D();
  if (!v) return 'CANCELLED';
  state = { v, points: [], cursor: null, cuts: [], cutThrough: opts.occlude === false, onlySelected: !!opts.onlySelected, midpoints: false, noSnap: false, axis: -1, angleSnap: false };
  const on = (b: boolean) => (b ? 'On' : 'Off');
  const local = (e: { clientX: number; clientY: number }) => {
    const r = v.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  app.startModal({
    label: 'Knife',
    header: () => `Knife: [C] Cut Through: ${on(!!state?.cutThrough)}   [Shift] Midpoint Snap: ${on(!!state?.midpoints)}   [Ctrl] Ignore Snap: ${on(!!state?.noSnap)}   [A] Angle Snap: ${on(!!state?.angleSnap)}   [X/Y/Z] Axis: ${state && state.axis >= 0 ? 'XYZ'[state.axis] : 'None'}`,
    status: () => [['LMB', 'Cut Point'], ['Double-click', 'Close Cut'], ['RMB', 'New Cut'], ['Ctrl Z', 'Undo Point'], ['C', 'Cut Through'], ['A', 'Angle Snap'], ['X Y Z', 'Axis'], ['Enter', 'Confirm'], ['Esc', 'Cancel']],
    onPointerMove(e) {
      if (!state) return;
      const p = local(e);
      state.cursor = constrained(v, p) ?? snap(v, p.x, p.y) ?? { world: v.unproject(p.x, p.y, state.points[state.points.length - 1]?.world ?? new Vector3(...app.doc.scene.cursor.location)), screen: p };
      v.drawSvg();
    },
    onPointerDown(e) {
      if (!state) return 'CANCELLED';
      if (e.button === 2) {
        if (state.points.length >= 2) state.cuts.push(state.points);
        state.points = [];
        v.drawSvg();
        return;
      }
      if (e.button !== 0) return;
      const p = local(e);
      const k = constrained(v, p) ?? snap(v, p.x, p.y);
      if (e.detail >= 2) {
        // double-click closes the current cut back to its first point
        if (state.points.length >= 3) state.points.push(state.points[0]);
        if (state.points.length >= 2) state.cuts.push(state.points);
        state.points = [];
        v.drawSvg();
        return undefined;
      }
      if (k) state.points.push(k);
      v.drawSvg();
      return undefined;
    },
    onKey(e) {
      if (e.key === 'Shift' && state) {
        state.midpoints = e.type === 'keydown';
        return true;
      }
      if (e.key === 'Control' && state) {
        state.noSnap = e.type === 'keydown';
        return true;
      }
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && state) {
        if (state.points.length) state.points.pop();
        else if (state.cuts.length) state.points = state.cuts.pop()!;
        v.drawSvg();
        return true;
      }
      if ((e.key === 'c' || e.key === 'C' || e.key === 'v' || e.key === 'V') && state) {
        state.cutThrough = !state.cutThrough;
        return true;
      }
      const ax = 'xyz'.indexOf(e.key.toLowerCase());
      if (ax >= 0 && state && !e.ctrlKey && !e.metaKey) {
        state.axis = state.axis === ax ? -1 : ax;
        return true;
      }
      if ((e.key === 'a' || e.key === 'A') && state) {
        state.angleSnap = !state.angleSnap;
        return true;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        confirm();
        return 'FINISHED';
      }
      if ((e.key === 'e' || e.key === 'E') && state) {
        if (state.points.length >= 2) state.cuts.push(state.points);
        state.points = [];
        v.drawSvg();
      }
      return true;
    },
    cancel() {
      state = null;
      v.drawSvg();
    },
    finish() {
      state = null;
      v.drawSvg();
    },
  });
  return 'RUNNING_MODAL';
}

registerOperators([
  {
    idname: 'mesh.knife_tool',
    label: 'Knife Topology Tool',
    description: 'Cut new topology',
    props: [
      { id: 'use_occlude_geometry', label: 'Occlude Geometry', type: 'bool', default: true },
      { id: 'only_selected', label: 'Only Selected', type: 'bool', default: false },
    ],
    poll: editPoll,
    invoke: (_ctx, p) => start({ occlude: p.use_occlude_geometry !== false, onlySelected: !!p.only_selected }),
  },
]);
addKeys('Mesh', [
  { key: 'K', op: 'mesh.knife_tool', props: { use_occlude_geometry: true, only_selected: false }, when: () => app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH' },
  { key: 'K', shift: true, op: 'mesh.knife_tool', props: { use_occlude_geometry: false, only_selected: true }, when: () => app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH' },
]);

// Toolbar tool: LMB in the viewport starts the knife with the clicked point
editModeHooks.pointer.unshift((v, e) => {
  if (app.doc.mode !== 'EDIT' || activeTools.EDIT !== 'builtin.knife') return false;
  if (app.run('mesh.knife_tool', { ...toolProps['builtin.knife'] }) !== 'RUNNING_MODAL' || !state) return false;
  const r = v.el.getBoundingClientRect();
  const k = snap(v, e.clientX - r.left, e.clientY - r.top);
  if (k) state.points.push(k);
  v.drawSvg();
  return true;
});

// ---------------------------------------------------------------------------
// knife project: cut along the outlines of the other selected objects, as seen from the view

/** World-space outline segments of an object: open (boundary) and loose edges of its evaluated mesh. */
function outlineSegments(obId: string): [Vector3, Vector3][] {
  const ev = app.graph.get(obId);
  const me = ev?.mesh;
  if (!ev || !me) return [];
  const out: [Vector3, Vector3][] = [];
  const P = me.positions;
  const pt = (i: number) => new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(ev.world);
  const count = new Map<string, [number, number, number]>();
  for (let f = 0; f < me.offsets.length - 1; f++)
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      const a = me.indices[c],
        b = me.indices[c + 1 < me.offsets[f + 1] ? c + 1 : me.offsets[f]];
      const k = edgeKey(a, b);
      const e = count.get(k);
      if (e) e[2]++;
      else count.set(k, [a, b, 1]);
    }
  for (const [a, b, n] of count.values()) if (n === 1) out.push([pt(a), pt(b)]);
  const loose = me.looseEdges;
  if (loose) for (let i = 0; i < loose.length; i += 2) out.push([pt(loose[i]), pt(loose[i + 1])]);
  for (const c of me.curves ?? []) {
    const n = c.points.length / 3;
    const q = (i: number) => new Vector3(c.points[i * 3], c.points[i * 3 + 1], c.points[i * 3 + 2]).applyMatrix4(ev.world);
    for (let i = 0; i < n - 1; i++) out.push([q(i), q(i + 1)]);
    if (c.cyclic && n > 2) out.push([q(n - 1), q(0)]);
  }
  return out;
}

registerOperators([
  {
    idname: 'mesh.knife_project',
    label: 'Knife Project',
    description: 'Cut the mesh along the outlines of the other selected objects, projected from the view',
    props: [{ id: 'cut_through', label: 'Cut Through', type: 'bool', default: false }],
    poll: (ctx) => editPoll(ctx) && app.selectedObjects().some((o) => o.id !== app.activeObject?.id),
    exec: (_ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      // the other selected objects cut the active one
      const cutters = app.selectedObjects().filter((o) => o.id !== app.activeObject?.id);
      const segs = cutters.flatMap((o) => outlineSegments(o.id));
      if (!segs.length) {
        app.report('ERROR', 'No other selected objects have wire or boundary edges to use for projection');
        return 'CANCELLED';
      }
      const screenSegs = segs.map(([a, b]) => [v.project(a), v.project(b)] as const);
      // anchor each outline point on the edited surface depth so the cut planes pass through it
      const cuts: KPoint[][] = segs.map(([a, b]) => [
        { world: a, screen: v.project(a) },
        { world: b, screen: v.project(b) },
      ]);
      const toViewer = new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion);
      for (const { ob, me } of editMeshObjects()) {
        if (cutters.some((c) => c.id === ob.id)) continue;
        cutObject(v, ob, me, cuts, { cutThrough: !!p.cut_through });
        // select the faces inside the projected outline
        const m = MeshEdit.from(me);
        const world = app.graph.get(ob.id)?.world ?? new Matrix4();
        m.sel = m.sel.map(() => 0);
        m.faces.forEach((f) => {
          const c = new Vector3(...m.faceCenter(f)).applyMatrix4(world);
          if (!p.cut_through && new Vector3(...m.faceNormal(f)).transformDirection(world).dot(toViewer) <= 0) return;
          const s = v.project(c);
          let inside = false;
          for (const [a, b] of screenSegs) if (a.y > s.y !== b.y > s.y && s.x < ((b.x - a.x) * (s.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
          if (inside) for (const x of f.verts) m.sel[x] = 1;
        });
        m.write(me);
      }
      app.doc.scene.tool_settings.mesh_select_mode = [false, false, true];
      app.changed('geometry', 'select');
    },
  },
]);
