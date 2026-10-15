// Custom split normals in Edit Mode: set from faces, point at a target, merge/split, average,
// copy/paste/reset, smooth, rotate, and clearing / adding the custom normal data.
import { Quaternion, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit } from './meshedit';
import { withEdit, worldMatrix, selectMode, editMeshObjects } from './context';
import { editPoll } from './ops-basic';
import { V } from './geom';
import { startValueModal } from './modal';

/** Make sure every face carries custom normals (filled with the automatic ones). */
export function ensureCustomNormals(m: MeshEdit) {
  const auto = m.customNormalsAuto();
  let k = 0;
  for (const f of m.faces) {
    const n = f.verts.length * 3;
    if (!(f.cnormals && f.cnormals.length === n)) f.cnormals = Array.from(auto.slice(k, k + n));
    k += n;
  }
}

/** Selected corners as [face, corner] pairs (face mode: corners of selected faces only). */
export function selectedCorners(m: MeshEdit): [number, number][] {
  const out: [number, number][] = [];
  let faceMode = false;
  try {
    faceMode = selectMode() === 'FACE';
  } catch {
    // no app (tests): vertex selection
  }
  m.faces.forEach((f, fi) => {
    const faceSel = f.verts.every((v) => m.sel[v]);
    if (faceMode && !faceSel) return;
    f.verts.forEach((v, c) => {
      if (m.sel[v] && !m.hide[v]) out.push([fi, c]);
    });
  });
  return out;
}

const getN = (m: MeshEdit, fi: number, c: number) => V(m.faces[fi].cnormals!.slice(c * 3, c * 3 + 3));
const setN = (m: MeshEdit, fi: number, c: number, n: Vector3) => {
  const l = n.length() || 1;
  m.faces[fi].cnormals!.splice(c * 3, 3, n.x / l, n.y / l, n.z / l);
};

/** Group selected corners by vertex. */
function byVertex(m: MeshEdit, corners: [number, number][]) {
  const g = new Map<number, [number, number][]>();
  for (const [fi, c] of corners) {
    const v = m.faces[fi].verts[c];
    (g.get(v) ?? g.set(v, []).get(v)!).push([fi, c]);
  }
  return g;
}

export function setNormalsFromFaces(m: MeshEdit, keepSharp: boolean) {
  ensureCustomNormals(m);
  const corners = selectedCorners(m);
  const fsel = new Set(m.selectedFaces());
  for (const [v, cs] of byVertex(m, corners)) {
    // average of the selected faces around the vertex (all faces when keeping sharp edges is off)
    const sum = new Vector3();
    m.faces.forEach((f, fi) => {
      if (f.verts.includes(v) && fsel.has(fi)) sum.add(V(m.faceNormal(f)));
    });
    for (const [fi, c] of cs) {
      const n = keepSharp && m.faces[fi].sharp.some(Boolean) ? V(m.faceNormal(m.faces[fi])) : sum.lengthSq() ? sum.clone() : V(m.faceNormal(m.faces[fi]));
      setN(m, fi, c, n);
    }
    void v;
  }
  return corners.length > 0;
}

export function pointNormals(m: MeshEdit, target: Vector3, o: { invert?: boolean; align?: boolean; spherize?: number }) {
  ensureCustomNormals(m);
  const corners = selectedCorners(m);
  if (!corners.length) return false;
  // aligned: every normal points along the direction from the selection centre
  const center = new Vector3();
  const verts = new Set(corners.map(([fi, c]) => m.faces[fi].verts[c]));
  for (const v of verts) center.add(V(m.p(v)));
  center.multiplyScalar(1 / verts.size);
  for (const [fi, c] of corners) {
    const v = m.faces[fi].verts[c];
    const from = o.align ? center : V(m.p(v));
    let n = target.clone().sub(from);
    if (n.lengthSq() < 1e-20) continue;
    n.normalize();
    if (o.invert) n.negate();
    if (o.spherize) n = getN(m, fi, c).lerp(n, o.spherize);
    setN(m, fi, c, n);
  }
  return true;
}

/** Every selected vertex gets one normal shared by all its corners (or each corner its face's normal). */
export function mergeNormals(m: MeshEdit, split: boolean) {
  ensureCustomNormals(m);
  const corners = selectedCorners(m);
  if (split) {
    for (const [fi, c] of corners) setN(m, fi, c, V(m.faceNormal(m.faces[fi])));
    return corners.length > 0;
  }
  for (const cs of byVertex(m, corners).values()) {
    const sum = new Vector3();
    for (const [fi, c] of cs) sum.add(getN(m, fi, c));
    if (sum.lengthSq() < 1e-20) continue;
    for (const [fi, c] of cs) setN(m, fi, c, sum);
  }
  return corners.length > 0;
}

function cornerAngle(m: MeshEdit, fi: number, c: number) {
  const f = m.faces[fi];
  const n = f.verts.length;
  const p = V(m.p(f.verts[c]));
  return V(m.p(f.verts[(c + n - 1) % n])).sub(p).angleTo(V(m.p(f.verts[(c + 1) % n])).sub(p));
}

function faceArea(m: MeshEdit, fi: number) {
  const f = m.faces[fi];
  const n = new Vector3();
  const p0 = V(m.p(f.verts[0]));
  for (let i = 1; i < f.verts.length - 1; i++) n.add(V(m.p(f.verts[i])).sub(p0).cross(V(m.p(f.verts[i + 1])).sub(p0)));
  return n.length() / 2;
}

export function averageNormals(m: MeshEdit, type: string, weight: number, threshold: number) {
  ensureCustomNormals(m);
  const corners = selectedCorners(m);
  for (const cs of byVertex(m, corners).values()) {
    const vals = cs.map(([fi, c]) => (type === 'CORNER_ANGLE' ? cornerAngle(m, fi, c) : type === 'FACE_AREA' ? faceArea(m, fi) : 1));
    const max = Math.max(...vals) || 1;
    const sum = new Vector3();
    cs.forEach(([fi, c], i) => {
      const n = type === 'CUSTOM_NORMAL' ? getN(m, fi, c) : V(m.faceNormal(m.faces[fi]));
      // a higher weight favours the dominant faces (weight 50 = proportional)
      const rel = vals[i] / max;
      const tier = Math.round((1 - rel) / Math.max(1e-6, threshold)) * threshold;
      sum.addScaledVector(n, type === 'CUSTOM_NORMAL' ? 1 : vals[i] * Math.pow(weight / 50, -tier * 10));
    });
    if (sum.lengthSq() < 1e-20) continue;
    for (const [fi, c] of cs) setN(m, fi, c, sum);
  }
  return corners.length > 0;
}

export function smoothNormals(m: MeshEdit, factor: number) {
  ensureCustomNormals(m);
  const corners = selectedCorners(m);
  const nb = m.neighbors();
  // average custom normal per vertex, blended with the neighbours' averages
  const vavg = new Map<number, Vector3>();
  m.faces.forEach((f) => {
    f.verts.forEach((v, c) => {
      const n = V(f.cnormals!.slice(c * 3, c * 3 + 3));
      (vavg.get(v) ?? vavg.set(v, new Vector3()).get(v)!).add(n);
    });
  });
  for (const n of vavg.values()) n.normalize();
  const updates: [number, number, Vector3][] = [];
  for (const [fi, c] of corners) {
    const v = m.faces[fi].verts[c];
    const around = new Vector3();
    for (const w of nb[v]) around.add(vavg.get(w) ?? new Vector3());
    if (around.lengthSq() < 1e-20) continue;
    updates.push([fi, c, getN(m, fi, c).lerp(around.normalize(), factor)]);
  }
  for (const [fi, c, n] of updates) setN(m, fi, c, n);
  return corners.length > 0;
}

let clipboard: Vector3 | null = null;

export function normalsTools(m: MeshEdit, mode: string, absolute: boolean, activeVertex: number) {
  if (mode === 'RESET') {
    if (!m.faces.some((f) => f.cnormals)) return false;
    ensureCustomNormals(m);
    const auto = m.customNormalsAuto();
    const start: number[] = [];
    let k = 0;
    for (const f of m.faces) {
      start.push(k);
      k += f.verts.length * 3;
    }
    for (const [fi, c] of selectedCorners(m)) setN(m, fi, c, V(auto.slice(start[fi] + c * 3, start[fi] + c * 3 + 3)));
    return true;
  }
  ensureCustomNormals(m);
  const corners = selectedCorners(m);
  if (mode === 'COPY') {
    const src = corners.filter(([fi, c]) => activeVertex < 0 || m.faces[fi].verts[c] === activeVertex);
    if (!src.length) return false;
    const sum = new Vector3();
    for (const [fi, c] of src) sum.add(getN(m, fi, c));
    clipboard = sum.normalize();
    return false;
  }
  if (!clipboard) return false;
  for (const [fi, c] of corners) {
    const n = getN(m, fi, c);
    if (mode === 'PASTE') setN(m, fi, c, absolute ? clipboard.clone() : clipboard.clone());
    else if (mode === 'ADD') setN(m, fi, c, n.add(clipboard));
    else if (mode === 'MULTIPLY') setN(m, fi, c, n.multiply(clipboard));
  }
  return corners.length > 0;
}

export function rotateNormals(m: MeshEdit, axis: Vector3, angle: number) {
  ensureCustomNormals(m);
  const q = new Quaternion().setFromAxisAngle(axis.clone().normalize(), angle);
  const corners = selectedCorners(m);
  for (const [fi, c] of corners) setN(m, fi, c, getN(m, fi, c).applyQuaternion(q));
  return corners.length > 0;
}

// ---------------------------------------------------------------------------

/** World-space view axis (towards the viewer) in an object's local space. */
function viewAxisLocal(ob: { id: string }) {
  const v = activeView3D();
  const axis = v ? new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion) : new Vector3(0, 0, 1);
  return axis.transformDirection(worldMatrix(ob as never).clone().invert());
}

registerOperators([
  {
    idname: 'mesh.set_normals_from_faces',
    label: 'Set Normals from Faces',
    description: 'Set the custom normals of the selection from the faces around each vertex',
    props: [{ id: 'keep_sharp', label: 'Keep Sharp Edges', type: 'bool', default: true }],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => setNormalsFromFaces(m, !!p.keep_sharp)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.point_normals',
    label: 'Point Normals to Target',
    description: 'Point the selected custom normals at a target (the 3D cursor, or the mouse when run interactively)',
    props: [
      { id: 'invert', label: 'Invert', type: 'bool', default: false },
      { id: 'align', label: 'Align', type: 'bool', default: false },
      { id: 'target_location', label: 'Target', type: 'vec3', default: null, subtype: 'distance' },
      { id: 'spherize', label: 'Spherize', type: 'bool', default: false },
      { id: 'spherize_strength', label: 'Spherize Strength', type: 'float', default: 0.1, min: 0, max: 1, subtype: 'factor', showIf: (p) => !!p.spherize },
    ],
    poll: editPoll,
    invoke: (ctx, p) => startPointModal(ctx.event, p),
    exec: (_ctx, p) => {
      const t = p.target_location ? V(p.target_location as number[]) : V(app.doc.scene.cursor.location);
      p.target_location = [t.x, t.y, t.z];
      const o = { invert: !!p.invert, align: !!p.align, spherize: p.spherize ? (p.spherize_strength as number) : 0 };
      return withEdit((m, ob) => pointNormals(m, t.clone().applyMatrix4(worldMatrix(ob).clone().invert()), o)) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'mesh.merge_normals',
    label: 'Merge Normals',
    description: 'Give each selected vertex a single shared custom normal',
    poll: editPoll,
    exec: () => (withEdit((m) => mergeNormals(m, false)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.split_normals',
    label: 'Split Normals',
    description: 'Give each selected corner the normal of its own face',
    poll: editPoll,
    exec: () => (withEdit((m) => mergeNormals(m, true)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.average_normals',
    label: 'Average Normals',
    description: 'Average the custom normals around each selected vertex',
    props: [
      { id: 'average_type', label: 'Type', type: 'enum', default: 'CUSTOM_NORMAL', items: [['CUSTOM_NORMAL', 'Custom Normal', 'Average of the current custom normals'], ['FACE_AREA', 'Face Area', 'Weighted by the area of the faces'], ['CORNER_ANGLE', 'Corner Angle', 'Weighted by the corner angles']] },
      { id: 'weight', label: 'Weight', type: 'int', default: 50, min: 1, max: 100, showIf: (p) => p.average_type !== 'CUSTOM_NORMAL' },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.01, min: 0, max: 10, showIf: (p) => p.average_type !== 'CUSTOM_NORMAL' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => averageNormals(m, p.average_type as string, p.weight as number, p.threshold as number)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.normals_tools',
    label: 'Normals Vector Tools',
    description: 'Copy, paste, add, multiply or reset custom normal vectors',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'COPY', items: [['COPY', 'Copy Normal'], ['PASTE', 'Paste Normal'], ['ADD', 'Add Normal'], ['MULTIPLY', 'Multiply Normal'], ['RESET', 'Reset Normal']] },
      { id: 'absolute', label: 'Absolute Coordinates', type: 'bool', default: false, showIf: (p) => p.mode === 'PASTE' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const activeV = -1;
      const changed = withEdit((m) => normalsTools(m, p.mode as string, !!p.absolute, activeV));
      if (p.mode === 'COPY') return clipboard ? 'FINISHED' : 'CANCELLED';
      return changed ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'mesh.smooth_normals',
    label: 'Smooth Normals Vectors',
    description: 'Blend the selected custom normals with those around them',
    props: [{ id: 'factor', label: 'Factor', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' }],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => smoothNormals(m, p.factor as number)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'transform.rotate_normal',
    label: 'Rotate Normals',
    description: 'Rotate the selected custom normals around the view axis',
    props: [{ id: 'value', label: 'Angle', type: 'float', default: 0, subtype: 'angle' }],
    poll: editPoll,
    invoke: (ctx) => {
      const axes = editMeshObjects().map(({ ob }) => viewAxisLocal(ob));
      return startValueModal({ label: 'Rotate Normals', idname: 'transform.rotate_normal', prop: 'value', initial: 0, perPixel: Math.PI / 360, name: 'Angle', unit: ' rad', apply: (m, a, i) => rotateNormals(m, axes[i] ?? new Vector3(0, 0, 1), a) }, ctx.event);
    },
    exec: (_ctx, p) => (withEdit((m, ob) => rotateNormals(m, viewAxisLocal(ob), p.value as number)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.customdata_custom_splitnormals_clear',
    label: 'Clear Custom Split Normals Data',
    description: 'Remove the custom normals so shading uses the automatic normals again',
    poll: (ctx) => !!app.activeObject?.data && !!app.doc.meshes[app.activeObject.data]?.custom_normals && ctx.doc.mode !== 'SCULPT',
    exec: () => {
      const ob = app.activeObject;
      const me = ob?.data ? app.doc.meshes[ob.data] : undefined;
      if (!me) return 'CANCELLED';
      me.custom_normals = undefined;
      app.changed('doc', 'geometry');
    },
  },
  {
    idname: 'mesh.customdata_custom_splitnormals_add',
    label: 'Add Custom Split Normals Data',
    description: 'Store the current shading normals as editable custom normals',
    poll: () => !!app.activeObject?.data && app.activeObject.type === 'MESH' && !app.doc.meshes[app.activeObject.data]?.custom_normals,
    exec: () => {
      const ob = app.activeObject;
      const me = ob?.data ? app.doc.meshes[ob.data] : undefined;
      if (!me) return 'CANCELLED';
      const m = MeshEdit.from(me);
      ensureCustomNormals(m);
      me.custom_normals = m.customNormals();
      app.changed('doc', 'geometry');
    },
  },
]);

/** Interactive Point to Target: the normals follow the mouse (at the selection's depth); I inverts, A aligns. */
function startPointModal(event: { x: number; y: number } | undefined, p: Record<string, unknown>) {
  const v = activeView3D();
  if (!v) return 'CANCELLED' as const;
  const snaps = editMeshObjects().map(({ ob, me }) => ({ ob, me, m: MeshEdit.from(me) }));
  if (!snaps.some((s) => selectedCorners(s.m).length)) return 'CANCELLED' as const;
  const center = new Vector3();
  let n = 0;
  for (const s of snaps)
    for (const vi of s.m.selectedVerts()) {
      center.add(V(s.m.p(vi)).applyMatrix4(worldMatrix(s.ob)));
      n++;
    }
  center.multiplyScalar(1 / Math.max(1, n));
  let invert = !!p.invert,
    align = !!p.align;
  let target = V(app.doc.scene.cursor.location);
  const r = v.el.getBoundingClientRect();
  const apply = () => {
    for (const s of snaps) {
      const c = s.m.clone();
      pointNormals(c, target.clone().applyMatrix4(worldMatrix(s.ob).clone().invert()), { invert, align });
      c.write(s.me);
    }
    app.changed('geometry');
  };
  const follow = (x: number, y: number) => {
    target = v.unproject(x - r.left, y - r.top, center);
    apply();
  };
  app.startModal({
    label: 'Point Normals to Target',
    header: () => `Point Normals: move the mouse to aim   [I] Invert: ${invert ? 'On' : 'Off'}   [A] Align: ${align ? 'On' : 'Off'}   [C] 3D Cursor`,
    status: () => [['LMB', 'Confirm'], ['RMB', 'Cancel'], ['I', 'Invert'], ['A', 'Align'], ['C', 'Use 3D Cursor']],
    onPointerMove(e) {
      follow(e.clientX, e.clientY);
    },
    onPointerDown(e) {
      return e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined;
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (k === 'i') invert = !invert;
      else if (k === 'a') align = !align;
      else if (k === 'c') target = V(app.doc.scene.cursor.location);
      else return true;
      apply();
      return true;
    },
    cancel() {
      for (const s of snaps) s.m.write(s.me);
      app.changed('geometry');
    },
    finish() {
      this.redoOp = { idname: 'mesh.point_normals', props: { invert, align, target_location: [target.x, target.y, target.z], spherize: false, spherize_strength: 0.1 } };
    },
  });
  if (event) follow(event.x, event.y);
  return 'RUNNING_MODAL' as const;
}

