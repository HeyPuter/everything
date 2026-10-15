// More data for scripts: pose bones, armature bones and edit bones, grease pencil (layers,
// frames, drawings, strokes, points), visual effects, speakers, masks, movie clips, fonts,
// the video sequencer and view layer passes. Fields not handled here go through the generic
// struct wrapper (rna.ts), so every stored setting stays reachable by name.
import { Euler as TEuler, Matrix4, Quaternion as TQuaternion, Vector3 } from 'three';
import { app } from '../app/app';
import type { Bone, PoseBone } from '../data/types';
import { uid } from '../data/defaults';
import { newConstraint, constraintTypes, boneOnlyConstraints } from '../eval/constraints';
import { boneRestMatrix } from '../eval/armature';
import type { GPDrawing, GPFrame, GPLayer, GreasePencilData } from '../greasepencil/types';
import { emptyDrawing, fromStrokes, newGreasePencil, newLayer as newGPLayer, newPoint, newStroke, toStrokes } from '../greasepencil/data';
import { FX_TYPES, newEffect } from '../greasepencil/fxtypes';
import { defaultSpeaker, type SpeakerSettings } from '../object/speakerdata';
import { maskTable, newLayer as newMaskLayer, newMask, newPoint as newMaskPoint } from '../mask/types';
import { clipTable } from '../tracking/types';
import type { Strip, StripType } from '../sequencer/types';
import { connect, connectedOf, disconnect } from '../sequencer/connect';
import { addKey, hasRetiming, resetRetiming, retimable, setSegmentSpeed, speedAt } from '../sequencer/retime';
import { allStrips, ensureEditor, findStrip, inputCount, newStrip, uniqueName as uniqueStripName, updateEffectRanges } from '../sequencer/strips';
import { ID_MIXINS, NEW_DATA, NEW_PARAMS, OBJECT_DATA_HOOKS, ObjectStruct, SceneStruct, addDataCollection, bpyData, uniqueName, viewLayer, wrapId, TABLE_OBTYPE } from './api';
import { Matrix, Vector } from './mathutils';
import { PropCollection, Struct, arrayFactories, boundVector, expectId, kwMethod, mixin, proxify, pyError, toPlain, touched, ensureEvaluated, type Raw } from './rna';

type Any = Record<string, unknown>;
const q = (s: string) => JSON.stringify(s);
const obPath = (id: string) => `bpy.data.objects[${q(app.doc.objects[id]?.name ?? '?')}]`;
const obOf = (id: string) => {
  const ob = app.doc.objects[id];
  if (!ob) throw pyError('ReferenceError', 'Object has been removed');
  return ob;
};

// ---------------------------------------------------------------------------
// lists the generic wrappers can grow

const uniq = (list: unknown[], base: string) => uniqueName(Object.fromEntries((list as { name: string }[]).map((x, i) => [i, x])), base);
arrayFactories.push(
  { match: /\.selection_sets$/, make: (a, list) => ({ name: uniq(list, String(a[0] ?? 'SelectionSet')), bones: [] }) },
  { match: /^bpy\.data\.masks\[\]\.layers$/, make: (a, list) => newMaskLayer(uniq(list, String(a[0] ?? 'MaskLayer'))) },
  { match: /\.layers\[\]\.splines$/, make: () => ({ points: [], use_cyclic: false, use_fill: true }) },
  { match: /\.splines\[\]\.points$/, make: () => newMaskPoint(0, 0) },
);

// ---------------------------------------------------------------------------
// armature: bones, edit bones, pose bones

const armOf = (id: string) => {
  const arm = app.doc.armatures[id];
  if (!arm) throw pyError('ReferenceError', 'Armature has been removed');
  return arm;
};
const armPath = (id: string) => `bpy.data.armatures[${q(app.doc.armatures[id]?.name ?? '?')}]`;

function boneStruct(armId: string, b: Bone, edit: boolean): unknown {
  const s = new Struct(edit ? 'EditBone' : 'Bone', () => (app.doc.armatures[armId]?.bones.includes(b) ? (b as unknown as Raw) : null), `${armPath(armId)}.${edit ? 'edit_bones' : 'bones'}[${q(b.name)}]`);
  const arm = () => armOf(armId);
  const vec = (key: 'head' | 'tail') => ({
    get: () => boundVector('VECTOR', () => b[key], (i, x) => ((b[key][i] = x), touched('geometry'))),
    set: (v: unknown) => {
      const a = toPlain(v) as number[];
      b[key] = [Number(a[0]), Number(a[1]), Number(a[2])];
      if (key === 'head' && b.use_connect && b.parent) {
        const p = arm().bones.find((x) => x.name === b.parent);
        if (p) p.tail = [...b.head];
      }
      touched('geometry');
    },
  });
  Object.defineProperties(s, {
    __bone: { value: b },
    name: {
      get: () => b.name,
      set: (v: string) => {
        const a = arm();
        const old = b.name;
        const n = uniqueName(Object.fromEntries(a.bones.filter((x) => x !== b).map((x, i) => [i, x])), String(v));
        for (const c of a.bones) if (c.parent === old) c.parent = n;
        for (const ob of Object.values(app.doc.objects)) {
          if (ob.data === armId && ob.pose?.[old]) {
            ob.pose[n] = ob.pose[old];
            delete ob.pose[old];
          }
        }
        b.name = n;
        touched();
      },
    },
    parent: {
      get: () => {
        const p = b.parent ? arm().bones.find((x) => x.name === b.parent) : null;
        return p ? boneStruct(armId, p, edit) : null;
      },
      set: (v: unknown) => {
        if (!edit) throw pyError('AttributeError', 'bpy_struct: attribute "parent" from "Bone" is read-only (set it on edit_bones in Edit Mode)');
        const p = (v as { __bone?: Bone } | null)?.__bone ?? null;
        for (let x: Bone | undefined = p ?? undefined; x; x = arm().bones.find((y) => y.name === x!.parent)) if (x === b) throw pyError('ValueError', 'loop in bone parents');
        b.parent = p?.name ?? null;
        if (!p) b.use_connect = false;
        touched('geometry');
      },
    },
    children: { get: () => arm().bones.filter((x) => x.parent === b.name).map((x) => boneStruct(armId, x, edit)) },
    children_recursive: {
      get: () => {
        const out: unknown[] = [];
        const walk = (n: string) => arm().bones.filter((x) => x.parent === n).forEach((x) => (out.push(boneStruct(armId, x, edit)), walk(x.name)));
        walk(b.name);
        return out;
      },
    },
    head: vec('head'),
    tail: vec('tail'),
    head_local: { get: () => new Vector([...b.head]) },
    tail_local: { get: () => new Vector([...b.tail]) },
    length: {
      get: () => Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]),
      set: (l: number) => {
        const d = [0, 1, 2].map((k) => b.tail[k] - b.head[k]);
        const cur = Math.hypot(...d) || 1;
        b.tail = [0, 1, 2].map((k) => b.head[k] + (d[k] / cur) * Number(l)) as [number, number, number];
        touched('geometry');
      },
    },
    vector: { get: () => new Vector([0, 1, 2].map((k) => b.tail[k] - b.head[k])) },
    matrix: { get: () => Matrix.fromColumnMajor(boneRestMatrix(b).elements) },
    matrix_local: { get: () => Matrix.fromColumnMajor(boneRestMatrix(b).elements) },
    collections: { get: () => (b.collections ?? []).map((n) => ({ __kind: 'struct', __type: 'BoneCollection', name: n })) },
  });
  return proxify(s);
}

class Bones extends PropCollection<unknown> {
  constructor(
    readonly armId: string,
    readonly edit: boolean,
  ) {
    super(`${armPath(armId)}.${edit ? 'edit_bones' : 'bones'}`);
  }
  private checkEdit() {
    if (!this.edit) return;
    const inEdit = app.doc.mode === 'EDIT' && app.editObjects().some((o) => o.data === this.armId);
    if (!inEdit) throw pyError('RuntimeError', 'edit_bones are only available in Edit Mode (bpy.ops.object.mode_set(mode="EDIT") with the armature active); use bones / pose.bones otherwise');
  }
  list() {
    this.checkEdit();
    return armOf(this.armId).bones.map((b) => boneStruct(this.armId, b, this.edit));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  get active() {
    const arm = armOf(this.armId);
    const b = arm.bones.find((x) => x.name === arm.active_bone);
    return b ? boneStruct(this.armId, b, this.edit) : null;
  }
  set active(v: unknown) {
    armOf(this.armId).active_bone = (v as { __bone?: Bone } | null)?.__bone?.name ?? null;
    touched('select');
  }
  /** Edit Mode: adds a bone (head at the origin, tail 1 up along Z unless set). */
  new(name = 'Bone') {
    if (!this.edit) throw pyError('AttributeError', "'ArmatureBones' object has no attribute 'new' (add bones with edit_bones.new in Edit Mode)");
    this.checkEdit();
    const arm = armOf(this.armId);
    const b: Bone = { name: uniqueName(Object.fromEntries(arm.bones.map((x, i) => [i, x])), String(name || 'Bone')), parent: null, head: [0, 0, 0], tail: [0, 0, 1], roll: 0, use_connect: false, use_deform: true, use_inherit_rotation: true, inherit_scale: 'FULL', envelope_distance: 0.25, head_radius: 0.1, tail_radius: 0.05, bbone_segments: 1 };
    if (arm.collections?.length) b.collections = [(arm.collections[arm.active_collection_index ?? 0] ?? arm.collections[0]).name];
    arm.bones.push(b);
    touched('geometry');
    return boneStruct(this.armId, b, true);
  }
  remove(bone: unknown) {
    if (!this.edit) throw pyError('AttributeError', "'ArmatureBones' object has no attribute 'remove' (use edit_bones in Edit Mode)");
    this.checkEdit();
    const arm = armOf(this.armId);
    const b = (bone as { __bone?: Bone })?.__bone;
    const i = b ? arm.bones.indexOf(b) : -1;
    if (i < 0) throw pyError('RuntimeError', 'ArmatureEditBones.remove(): bone not found');
    for (const c of arm.bones) if (c.parent === b!.name) ((c.parent = b!.parent), (c.use_connect = false));
    arm.bones.splice(i, 1);
    if (arm.active_bone === b!.name) arm.active_bone = null;
    touched('geometry');
  }
}
kwMethod(Bones.prototype, 'new', ['name']);

class ArmatureData_ {
  get bones() {
    return new Bones((this as unknown as { __id: string }).__id, false);
  }
  get edit_bones() {
    return new Bones((this as unknown as { __id: string }).__id, true);
  }
  get is_editmode() {
    const id = (this as unknown as { __id: string }).__id;
    return app.doc.mode === 'EDIT' && app.editObjects().some((o) => o.data === id);
  }
}
(ID_MIXINS.armatures ??= []).push(ArmatureData_);

function poseBoneStruct(obId: string, name: string): unknown {
  const raw = () => app.doc.objects[obId]?.pose?.[name] as unknown as Raw | undefined;
  const s = new Struct('PoseBone', raw, `${obPath(obId)}.pose.bones[${q(name)}]`);
  const ob = () => obOf(obId);
  const arm = () => (ob().data ? app.doc.armatures[ob().data!] : undefined);
  const bone = () => arm()?.bones.find((b) => b.name === name);
  const evalBone = () => {
    ensureEvaluated();
    return app.graph.get(obId)?.pose?.bones.get(name);
  };
  Object.defineProperties(s, {
    __pb: { get: () => raw() },
    name: { get: () => name },
    bone: { get: () => (bone() && ob().data ? boneStruct(ob().data!, bone()!, false) : null) },
    parent: { get: () => (bone()?.parent ? poseBoneStruct(obId, bone()!.parent!) : null) },
    children: { get: () => (arm()?.bones ?? []).filter((b) => b.parent === name).map((b) => poseBoneStruct(obId, b.name)) },
    head: { get: () => new Vector(new Vector3().setFromMatrixPosition(evalBone()?.pose ?? new Matrix4()).toArray()) },
    tail: {
      get: () => {
        const e = evalBone();
        if (!e) return new Vector([0, 0, 0]);
        return new Vector(new Vector3(0, e.length, 0).applyMatrix4(e.pose).toArray());
      },
    },
    length: { get: () => evalBone()?.length ?? 0 },
    /** Final pose matrix in armature space. */
    matrix: {
      get: () => Matrix.fromColumnMajor((evalBone()?.pose ?? new Matrix4()).elements),
      set: (m: unknown) => {
        const e = evalBone();
        const b = bone();
        if (!e || !b) return;
        // local = rest^-1 * parentPose^-1-relative; solve basis from the wanted armature-space matrix
        const want = new Matrix4().fromArray((m instanceof Matrix ? m : new Matrix(toPlain(m) as number[][])).toColumnMajor());
        const p = b.parent ? app.graph.get(obId)?.pose?.bones.get(b.parent) : undefined;
        const rest = boneRestMatrix(b);
        const parentRest = p && b.parent ? boneRestMatrix(arm()!.bones.find((x) => x.name === b.parent)!) : new Matrix4();
        const restLocal = parentRest.clone().invert().multiply(rest);
        const parentPose = p ? p.pose : new Matrix4();
        const basis = restLocal.invert().multiply(parentPose.clone().invert()).multiply(want);
        applyBasis(raw() as unknown as PoseBone, basis);
        touched();
      },
    },
    matrix_basis: {
      get: () => {
        const pb = raw() as unknown as PoseBone | undefined;
        return pb ? Matrix.fromColumnMajor(basisMatrix(pb).elements) : Matrix.Identity(4);
      },
      set: (m: unknown) => {
        applyBasis(raw() as unknown as PoseBone, new Matrix4().fromArray((m instanceof Matrix ? m : new Matrix(toPlain(m) as number[][])).toColumnMajor()));
        touched();
      },
    },
    constraints: { get: () => new PoseBoneConstraints(obId, name) },
  });
  return proxify(s);
}

const threeOrder = (mode: string) => (mode === 'QUATERNION' || mode === 'AXIS_ANGLE' ? 'XYZ' : mode).split('').reverse().join('') as 'XYZ';

/** The pose bone's own transform (location, rotation, scale) as a matrix. */
function basisMatrix(pb: PoseBone): Matrix4 {
  const r = pb.rotation_quaternion;
  const q =
    pb.rotation_mode === 'QUATERNION'
      ? new TQuaternion(r[1], r[2], r[3], r[0]).normalize()
      : pb.rotation_mode === 'AXIS_ANGLE'
        ? new TQuaternion().setFromAxisAngle(new Vector3(pb.rotation_axis_angle[1], pb.rotation_axis_angle[2], pb.rotation_axis_angle[3]).normalize(), pb.rotation_axis_angle[0])
        : new TQuaternion().setFromEuler(new TEuler(pb.rotation_euler[0], pb.rotation_euler[1], pb.rotation_euler[2], threeOrder(pb.rotation_mode)));
  return new Matrix4().compose(new Vector3(...pb.location), q, new Vector3(...pb.scale));
}

function applyBasis(pb: PoseBone | undefined, m: Matrix4) {
  if (!pb) return;
  const p = new Vector3(),
    qt = new TQuaternion(),
    sc = new Vector3();
  m.decompose(p, qt, sc);
  pb.location = [p.x, p.y, p.z];
  pb.scale = [sc.x, sc.y, sc.z];
  pb.rotation_quaternion = [qt.w, qt.x, qt.y, qt.z];
  const e = new TEuler().setFromQuaternion(qt, threeOrder(pb.rotation_mode));
  pb.rotation_euler = [e.x, e.y, e.z];
  const ang = 2 * Math.acos(Math.min(1, Math.abs(qt.w)));
  const sn = Math.sqrt(Math.max(0, 1 - qt.w * qt.w)) || 1;
  pb.rotation_axis_angle = [ang, qt.x / sn, qt.y / sn, qt.z / sn];
}

class PoseBones extends PropCollection<unknown> {
  constructor(readonly obId: string) {
    super(`${obPath(obId)}.pose.bones`);
  }
  list() {
    const ob = obOf(this.obId);
    const arm = ob.data ? app.doc.armatures[ob.data] : undefined;
    const names = arm ? arm.bones.map((b) => b.name) : Object.keys(ob.pose ?? {});
    return names.filter((n) => ob.pose?.[n]).map((n) => poseBoneStruct(this.obId, n));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
}

class PoseBoneConstraints extends PropCollection<unknown> {
  constructor(
    readonly obId: string,
    readonly bone: string,
  ) {
    super(`${obPath(obId)}.pose.bones[${q(bone)}].constraints`);
  }
  private pb() {
    const pb = obOf(this.obId).pose?.[this.bone];
    if (!pb) throw pyError('ReferenceError', 'pose bone has been removed');
    return pb;
  }
  list() {
    return this.pb().constraints.map((c) => this.wrap(c.id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  private wrap(cid: string) {
    const s = new Struct('Constraint', () => app.doc.objects[this.obId]?.pose?.[this.bone]?.constraints.find((c) => c.id === cid) as Raw | undefined, `${this.__path}[${q(this.pb().constraints.find((c) => c.id === cid)?.name ?? '')}]`);
    Object.defineProperty(s, '__cid', { value: cid });
    return proxify(s);
  }
  new(type: string) {
    const t = String(type ?? '').toUpperCase();
    if (!constraintTypes[t] && !boneOnlyConstraints[t]) throw pyError('TypeError', `PoseBoneConstraints.new(): enum "${type}" not found in (${[...Object.keys(constraintTypes), ...Object.keys(boneOnlyConstraints)].map((k) => `'${k}'`).join(', ')})`);
    const pb = this.pb();
    const c = newConstraint(t, uid('cn'));
    c.name = uniqueName(Object.fromEntries(pb.constraints.map((x) => [x.id, x])), c.name);
    pb.constraints.push(c);
    touched();
    return this.wrap(c.id);
  }
  remove(con: unknown) {
    const pb = this.pb();
    const i = pb.constraints.findIndex((c) => c.id === (con as { __cid?: string })?.__cid);
    if (i < 0) throw pyError('ReferenceError', 'Constraint not found on this bone');
    pb.constraints.splice(i, 1);
    touched();
  }
  clear() {
    this.pb().constraints = [];
    touched();
  }
}
kwMethod(PoseBoneConstraints.prototype, 'new', ['type']);

// ---------------------------------------------------------------------------
// grease pencil

const gpOf = (id: string) => {
  const gp = app.doc.grease_pencils?.[id];
  if (!gp) throw pyError('ReferenceError', 'Grease Pencil data has been removed');
  return gp;
};
const gpPath = (id: string) => `bpy.data.grease_pencils[${q(app.doc.grease_pencils?.[id]?.name ?? '?')}]`;

function writeDrawing(gp: GreasePencilData, idx: number, d: GPDrawing) {
  gp.drawings[idx] = d;
  touched('geometry');
}

/** A drawing's strokes; writes rebuild the drawing (struct-of-arrays) from the stroke list. */
function drawingStruct(gpId: string, drawingIndex: number, path: string) {
  const gp = () => gpOf(gpId);
  const d = () => gp().drawings[drawingIndex] ?? emptyDrawing();
  const strokes = new GPStrokes(gpId, drawingIndex, `${path}.strokes`);
  return {
    __kind: 'struct',
    __type: 'GreasePencilDrawing',
    strokes,
    /** Adds strokes with the given point counts (points at the origin). */
    add_strokes(sizes: unknown) {
      const ns = (toPlain(sizes) as number[]).map((n) => Math.max(1, Math.round(Number(n))));
      const list = toStrokes(d());
      for (const n of ns) list.push(newStroke(Array.from({ length: n }, () => newPoint([0, 0, 0], 0.01, 1))));
      writeDrawing(gp(), drawingIndex, fromStrokes(list));
    },
    /** Removes the strokes at `indices` (all strokes when None). */
    remove_strokes(indices: unknown = null) {
      const list = toStrokes(d());
      if (indices === null || indices === undefined) writeDrawing(gp(), drawingIndex, fromStrokes([]));
      else {
        const drop = new Set((toPlain(indices) as number[]).map(Number));
        writeDrawing(gp(), drawingIndex, fromStrokes(list.filter((_, i) => !drop.has(i))));
      }
    },
    get attributes() {
      const dr = d();
      return ['position', 'radius', 'opacity', 'vertex_color', 'cyclic', 'material_index', 'fill_color', 'fill_opacity'].filter((k) => (dr as unknown as Any)[k]).map((name) => ({ __kind: 'struct', __type: 'Attribute', name, domain: ['cyclic', 'material_index', 'fill_color', 'fill_opacity'].includes(name) ? 'CURVE' : 'POINT' }));
    },
    tag_positions_changed() {
      touched('geometry');
    },
    toString: () => `<bpy_struct, GreasePencilDrawing at ${path}>`,
  };
}

class GPStrokes extends PropCollection<unknown> {
  constructor(
    readonly gpId: string,
    readonly di: number,
    path: string,
  ) {
    super(path);
  }
  private d() {
    return gpOf(this.gpId).drawings[this.di] ?? emptyDrawing();
  }
  override get length() {
    return this.d().offsets.length - 1;
  }
  list() {
    return Array.from({ length: this.length }, (_, i) => this.stroke(i));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    if (typeof key !== 'number') throw pyError('TypeError', 'bpy_prop_collection: index must be an int');
    const n = this.length;
    const i = key < 0 ? key + n : key;
    if (i < 0 || i >= n) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${n}`);
    return this.stroke(i);
  }
  private stroke(si: number) {
    const self = this;
    const d = () => self.d();
    const curveField = (key: 'cyclic' | 'material_index' | 'start_cap' | 'end_cap' | 'fill_opacity', bool = false) => ({
      get: () => (bool ? !!d()[key][si] : Number(d()[key][si])),
      set: (v: unknown) => {
        const dr = d();
        const a = (dr[key] as Uint8Array).slice();
        a[si] = Number(v);
        (dr as unknown as Any)[key] = a;
        touched('geometry');
      },
      enumerable: true,
    });
    const range = () => [d().offsets[si], d().offsets[si + 1]];
    const o: Any = {
      __kind: 'struct',
      __type: 'GreasePencilStroke',
      index: si,
      get points() {
        const [a, b] = range();
        return Array.from({ length: b - a }, (_, k) => gpPoint(self.gpId, self.di, a + k, `${self.__path}[${si}].points[${k}]`));
      },
      get fill_color() {
        return boundVector('COLOR', () => d().fill_color.subarray(si * 4, si * 4 + 4), (k, x) => {
          const dr = d();
          dr.fill_color = dr.fill_color.slice();
          dr.fill_color[si * 4 + k] = x;
          touched('geometry');
        });
      },
      set fill_color(v: unknown) {
        const a = toPlain(v) as number[];
        const dr = d();
        dr.fill_color = dr.fill_color.slice();
        for (let k = 0; k < 4; k++) dr.fill_color[si * 4 + k] = Number(a[k] ?? 1);
        touched('geometry');
      },
      get select() {
        const [a, b] = range();
        const sel = d().select;
        for (let k = a; k < b; k++) if (sel?.[k]) return true;
        return false;
      },
      set select(v: boolean) {
        const dr = d();
        const [a, b] = range();
        const sel = dr.select ? dr.select.slice() : new Uint8Array(dr.position.length / 3);
        for (let k = a; k < b; k++) sel[k] = v ? 1 : 0;
        dr.select = sel;
        touched('select');
      },
      /** Appends `count` points copied from the last one. */
      add_points(count: number) {
        const list = toStrokes(d());
        const st = list[si];
        const last = st.points[st.points.length - 1] ?? newPoint([0, 0, 0]);
        for (let k = 0; k < Math.max(0, Math.round(Number(count))); k++) st.points.push({ ...last, co: [...last.co] as [number, number, number], vertex_color: [...last.vertex_color] as [number, number, number, number] });
        writeDrawing(gpOf(self.gpId), self.di, fromStrokes(list));
      },
      /** Removes `count` points from the end. */
      remove_points(count: number) {
        const list = toStrokes(d());
        list[si].points.splice(Math.max(1, list[si].points.length - Math.max(0, Math.round(Number(count)))));
        writeDrawing(gpOf(self.gpId), self.di, fromStrokes(list));
      },
      toString: () => `<bpy_struct, GreasePencilStroke at ${self.__path}[${si}]>`,
    };
    return Object.defineProperties(o, { cyclic: curveField('cyclic', true), material_index: curveField('material_index'), start_cap: curveField('start_cap'), end_cap: curveField('end_cap'), fill_opacity: curveField('fill_opacity') });
  }
}

function gpPoint(gpId: string, di: number, pi: number, path: string) {
  const d = () => gpOf(gpId).drawings[di];
  const write = (key: 'position' | 'radius' | 'opacity' | 'vertex_color', i: number, x: number) => {
    const dr = d();
    const a = dr[key].slice();
    a[i] = x;
    dr[key] = a;
    touched('geometry');
  };
  return {
    __kind: 'struct',
    __type: 'GreasePencilStrokePoint',
    index: pi,
    get position() {
      return boundVector('VECTOR', () => d().position.subarray(pi * 3, pi * 3 + 3), (k, x) => write('position', pi * 3 + k, x));
    },
    set position(v: unknown) {
      const a = toPlain(v) as number[];
      const dr = d();
      const p = dr.position.slice();
      for (let k = 0; k < 3; k++) p[pi * 3 + k] = Number(a[k] ?? 0);
      dr.position = p;
      touched('geometry');
    },
    get radius() {
      return d().radius[pi];
    },
    set radius(v: number) {
      write('radius', pi, Number(v));
    },
    get opacity() {
      return d().opacity[pi];
    },
    set opacity(v: number) {
      write('opacity', pi, Number(v));
    },
    get vertex_color() {
      return boundVector('COLOR', () => d().vertex_color.subarray(pi * 4, pi * 4 + 4), (k, x) => write('vertex_color', pi * 4 + k, x));
    },
    set vertex_color(v: unknown) {
      const a = toPlain(v) as number[];
      for (let k = 0; k < 4; k++) write('vertex_color', pi * 4 + k, Number(a[k] ?? 0));
    },
    get select() {
      return !!d().select?.[pi];
    },
    set select(v: boolean) {
      const dr = d();
      const s = dr.select ? dr.select.slice() : new Uint8Array(dr.position.length / 3);
      s[pi] = v ? 1 : 0;
      dr.select = s;
      touched('select');
    },
    toString: () => `<bpy_struct, GreasePencilStrokePoint at ${path}>`,
  };
}

function frameStruct(gpId: string, layer: GPLayer, f: GPFrame, path: string) {
  const s = new Struct('GreasePencilFrame', () => (layer.frames.includes(f) ? (f as unknown as Raw) : null), path);
  Object.defineProperties(s, {
    __frame: { value: f },
    drawing: { get: () => drawingStruct(gpId, f.drawing, `${path}.drawing`) },
    frame_number: {
      get: () => f.frame_number,
      set: (v: number) => {
        const n = Math.round(Number(v));
        if (layer.frames.some((x) => x !== f && x.frame_number === n)) throw pyError('RuntimeError', `Error: the layer already has a keyframe at frame ${n}`);
        f.frame_number = n;
        layer.frames.sort((a, b) => a.frame_number - b.frame_number);
        touched();
      },
    },
  });
  return proxify(s);
}

class GPFrames extends PropCollection<unknown> {
  constructor(
    readonly gpId: string,
    readonly layer: GPLayer,
    path: string,
  ) {
    super(path);
  }
  list() {
    return this.layer.frames.map((f) => frameStruct(this.gpId, this.layer, f, `${this.__path}[${this.layer.frames.indexOf(f)}]`));
  }
  nameOf() {
    return '';
  }
  /** Adds a keyframe with an empty drawing at `frame_number`. */
  new(frame_number: number) {
    const gp = gpOf(this.gpId);
    const n = Math.round(Number(frame_number));
    if (this.layer.frames.some((f) => f.frame_number === n)) throw pyError('RuntimeError', `Error: Frame already exists on layer "${this.layer.name}" at frame ${n}`);
    gp.drawings.push(emptyDrawing());
    const f: GPFrame = { frame_number: n, drawing: gp.drawings.length - 1, keyframe_type: 'KEYFRAME' };
    this.layer.frames.push(f);
    this.layer.frames.sort((a, b) => a.frame_number - b.frame_number);
    touched('geometry');
    return frameStruct(this.gpId, this.layer, f, `${this.__path}[${this.layer.frames.indexOf(f)}]`);
  }
  remove(frame_number: number) {
    const i = this.layer.frames.findIndex((f) => f.frame_number === Math.round(Number(frame_number)));
    if (i < 0) throw pyError('RuntimeError', `Error: no keyframe at frame ${frame_number} on layer "${this.layer.name}"`);
    this.layer.frames.splice(i, 1);
    touched('geometry');
  }
  /** Duplicates the keyframe at `from_frame_number` (with its own copy of the drawing) to `to_frame_number`. */
  copy(from_frame_number: number, to_frame_number: number, instance_drawing = false) {
    const gp = gpOf(this.gpId);
    const src = this.layer.frames.find((f) => f.frame_number === Math.round(Number(from_frame_number)));
    if (!src) throw pyError('RuntimeError', `Error: no keyframe at frame ${from_frame_number}`);
    const to = Math.round(Number(to_frame_number));
    this.layer.frames = this.layer.frames.filter((f) => f.frame_number !== to);
    let di = src.drawing;
    if (!instance_drawing) {
      gp.drawings.push(fromStrokes(toStrokes(gp.drawings[src.drawing])));
      di = gp.drawings.length - 1;
    }
    const f: GPFrame = { frame_number: to, drawing: di, keyframe_type: src.keyframe_type };
    this.layer.frames.push(f);
    this.layer.frames.sort((a, b) => a.frame_number - b.frame_number);
    touched('geometry');
    return frameStruct(this.gpId, this.layer, f, `${this.__path}[${this.layer.frames.indexOf(f)}]`);
  }
}
kwMethod(GPFrames.prototype, 'new', ['frame_number']);
kwMethod(GPFrames.prototype, 'remove', ['frame_number']);
kwMethod(GPFrames.prototype, 'copy', ['from_frame_number', 'to_frame_number', 'instance_drawing']);

function layerStruct(gpId: string, layer: GPLayer) {
  const path = `${gpPath(gpId)}.layers[${q(layer.name)}]`;
  const s = new Struct('GreasePencilLayer', () => (app.doc.grease_pencils?.[gpId]?.layers.includes(layer) ? (layer as unknown as Raw) : null), path);
  const frameAt = (n: number) => {
    let hit: GPFrame | null = null;
    for (const f of layer.frames) if (f.frame_number <= n) hit = f;
    return hit;
  };
  Object.defineProperties(s, {
    __layer: { value: layer },
    frames: { get: () => new GPFrames(gpId, layer, `${path}.frames`) },
    name: {
      get: () => layer.name,
      set: (v: string) => {
        const gp = gpOf(gpId);
        layer.name = uniqueName(Object.fromEntries(gp.layers.filter((x) => x !== layer).map((x, i) => [i, x])), String(v));
        touched();
      },
    },
    /** The keyframe showing at the current frame (or None). */
    current_frame: { value: () => (frameAt(app.doc.scene.frame_current) ? frameStruct(gpId, layer, frameAt(app.doc.scene.frame_current)!, `${path}.current_frame()`) : null) },
    get_frame_at: { value: (n: number) => (frameAt(Number(n)) ? frameStruct(gpId, layer, frameAt(Number(n))!, `${path}.get_frame_at(${n})`) : null) },
  });
  return proxify(s);
}

class GPLayers extends PropCollection<unknown> {
  constructor(readonly gpId: string) {
    super(`${gpPath(gpId)}.layers`);
  }
  list() {
    return gpOf(this.gpId).layers.map((l) => layerStruct(this.gpId, l));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  new(name = 'Layer', set_active = true, layer_group: unknown = null) {
    const gp = gpOf(this.gpId);
    const l = newGPLayer(uniqueName(Object.fromEntries(gp.layers.map((x, i) => [i, x])), String(name || 'Layer')));
    if (layer_group) l.parent_group = String((layer_group as { name?: string }).name ?? layer_group);
    gp.layers.push(l);
    if (set_active) gp.active_layer_index = gp.layers.length - 1;
    touched('geometry');
    return layerStruct(this.gpId, l);
  }
  remove(layer: unknown) {
    const gp = gpOf(this.gpId);
    const i = gp.layers.indexOf((layer as { __layer?: GPLayer })?.__layer!);
    if (i < 0) throw pyError('RuntimeError', 'GreasePencilv3Layers.remove(): layer not found');
    gp.layers.splice(i, 1);
    gp.active_layer_index = Math.max(0, Math.min(gp.active_layer_index, gp.layers.length - 1));
    touched('geometry');
  }
  move(layer: unknown, type: string) {
    const gp = gpOf(this.gpId);
    const i = gp.layers.indexOf((layer as { __layer?: GPLayer })?.__layer!);
    const j = String(type).toUpperCase() === 'UP' ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= gp.layers.length) return;
    [gp.layers[i], gp.layers[j]] = [gp.layers[j], gp.layers[i]];
    touched('geometry');
  }
  get active() {
    const gp = gpOf(this.gpId);
    const l = gp.layers[gp.active_layer_index];
    return l ? layerStruct(this.gpId, l) : null;
  }
  set active(v: unknown) {
    const gp = gpOf(this.gpId);
    const i = gp.layers.indexOf((v as { __layer?: GPLayer })?.__layer!);
    if (i >= 0) gp.active_layer_index = i;
    touched();
  }
}
kwMethod(GPLayers.prototype, 'new', ['name', 'set_active', 'layer_group']);

class GreasePencilData_ {
  get layers() {
    return new GPLayers((this as unknown as { __id: string }).__id);
  }
  get materials() {
    const id = (this as unknown as { __id: string }).__id;
    return new GPMaterials(id);
  }
}
(ID_MIXINS.grease_pencils ??= []).push(GreasePencilData_);

class GPMaterials extends PropCollection<unknown> {
  constructor(readonly gpId: string) {
    super(`${gpPath(gpId)}.materials`);
  }
  list() {
    return gpOf(this.gpId).materials.map((id) => (id && app.doc.materials[id] ? wrapId('materials', id) : null));
  }
  nameOf(x: unknown) {
    return (x as { name?: string } | null)?.name ?? '';
  }
  append(mat: unknown) {
    gpOf(this.gpId).materials.push(mat === null || mat === undefined ? null : expectId(mat, 'materials', 'Material'));
    touched();
  }
  pop(index = -1) {
    const l = gpOf(this.gpId).materials;
    const [id] = l.splice(index < 0 ? l.length + index : index, 1);
    touched();
    return id ? wrapId('materials', id) : null;
  }
  clear() {
    gpOf(this.gpId).materials = [];
    touched();
  }
}

NEW_DATA.grease_pencils = (name) => {
  app.doc.grease_pencils ??= {};
  return newGreasePencil(name || 'GreasePencil');
};
addDataCollection('grease_pencils', 'GreasePencil');


// visual effects on grease pencil objects
class ShaderEffects extends PropCollection<unknown> {
  constructor(readonly obId: string) {
    super(`${obPath(obId)}.shader_effects`);
  }
  private list_() {
    return (obOf(this.obId).shader_effects ??= []);
  }
  list() {
    return this.list_().map((f) => this.wrap(f.id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  private wrap(fid: string) {
    const s = new Struct('ShaderFx', () => app.doc.objects[this.obId]?.shader_effects?.find((f) => f.id === fid) as Raw | undefined, '');
    Object.defineProperty(s, '__fid', { value: fid });
    Object.defineProperty(s, '__path', { get: () => `${this.__path}[${q(this.list_().find((f) => f.id === fid)?.name ?? '')}]` });
    return proxify(s);
  }
  new(name: string, type: string) {
    const ob = obOf(this.obId);
    if (ob.type !== 'GREASEPENCIL') throw pyError('RuntimeError', `Error: Object '${ob.name}' is not a grease pencil object; only those have visual effects`);
    const t = String(type ?? '').toUpperCase();
    if (!FX_TYPES.some((x) => x.type === t)) throw pyError('TypeError', `ObjectShaderFx.new(): enum "${type}" not found in (${FX_TYPES.map((x) => `'${x.type}'`).join(', ')})`);
    const list = this.list_();
    const fx = newEffect(t, list);
    if (name) fx.name = uniqueName(Object.fromEntries(list.map((x) => [x.id, x])), String(name));
    list.push(fx);
    touched();
    return this.wrap(fx.id);
  }
  remove(fx: unknown) {
    const list = this.list_();
    const i = list.findIndex((f) => f.id === (fx as { __fid?: string })?.__fid);
    if (i < 0) throw pyError('ReferenceError', 'effect not found on this object');
    list.splice(i, 1);
    touched();
  }
  clear() {
    obOf(this.obId).shader_effects = [];
    touched();
  }
}
kwMethod(ShaderEffects.prototype, 'new', ['name', 'type']);

// ---------------------------------------------------------------------------
// speakers: their settings live on the object; bpy.data.speakers lists them by object

const looseSpeakers = new Map<string, { name: string; settings: SpeakerSettings }>();

function speakerStruct(obId: string | null, looseId: string | null) {
  const raw = () => (obId ? (app.doc.objects[obId]?.speaker as unknown as Raw | undefined) : (looseSpeakers.get(looseId!)?.settings as unknown as Raw | undefined));
  const s = new Struct('Speaker', raw, obId ? `${obPath(obId)}.data` : `bpy.data.speakers[${q(looseSpeakers.get(looseId!)?.name ?? '')}]`);
  Object.defineProperties(s, {
    __kind: { value: 'id' },
    __table: { value: 'speakers' },
    __id: { value: obId ?? looseId },
    name: {
      get: () => (obId ? app.doc.objects[obId]?.name : looseSpeakers.get(looseId!)?.name) ?? '',
      set: (v: string) => {
        if (looseId) looseSpeakers.get(looseId)!.name = String(v);
      },
    },
    sound: {
      get: () => (raw()?.sound ? { __kind: 'struct', __type: 'Sound', name: ((raw()!.sound as { filepath?: string }).filepath ?? 'Sound').replace(/^.*[\\/]/, ''), filepath: (raw()!.sound as { filepath?: string }).filepath ?? '' } : null),
      set: (v: unknown) => {
        if (v !== null && v !== undefined) throw pyError('RuntimeError', 'Error: scripts cannot load sound files here; use Speaker ▸ Open Sound in the properties editor');
        const r = raw();
        if (r) r.sound = null;
        touched();
      },
    },
  });
  return proxify(s);
}

NEW_DATA.speakers = (name) => {
  const id = uid('spk');
  looseSpeakers.set(id, { name: name || 'Speaker', settings: defaultSpeaker() });
  return { wrapper: speakerStruct(null, id) };
};
TABLE_OBTYPE.speakers = 'SPEAKER';
OBJECT_DATA_HOOKS.SPEAKER = (ob, did) => {
  ob.speaker = structuredClone(looseSpeakers.get(did ?? '')?.settings ?? defaultSpeaker());
  ob.data = null;
};

/** bpy.data.speakers: the speaker objects' settings, plus those made by new() and not used yet. */
class SpeakersCollection extends PropCollection<unknown> {
  constructor() {
    super('bpy.data.speakers');
  }
  list() {
    const obs = app.doc.object_order.filter((id) => app.doc.objects[id]?.type === 'SPEAKER').map((id) => speakerStruct(id, null));
    return [...obs, ...[...looseSpeakers.keys()].map((k) => speakerStruct(null, k))];
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  new(name = 'Speaker') {
    return (NEW_DATA.speakers(String(name || 'Speaker'), []) as { wrapper: unknown }).wrapper;
  }
  remove(spk: unknown) {
    const id = (spk as { __id?: string })?.__id;
    if (id && looseSpeakers.delete(id)) return;
    throw pyError('RuntimeError', 'Error: a speaker in use is removed with its object (bpy.data.objects.remove)');
  }
}
kwMethod(SpeakersCollection.prototype, 'new', ['name']);
bpyData.speakers = new SpeakersCollection();

// ---------------------------------------------------------------------------
// masks, movie clips and fonts

NEW_DATA.masks = (name) => {
  maskTable(app.doc);
  return newMask(uid('mk'), name || 'Mask');
};
addDataCollection('masks', 'Mask');
addDataCollection('movieclips', 'MovieClip');
addDataCollection('fonts', 'VectorFont');
void clipTable;

// ---------------------------------------------------------------------------
// object members: pose, data for speakers, shader effects, grease pencil helpers

const dataDesc = Object.getOwnPropertyDescriptor(ObjectStruct.prototype, 'data')!;
class ObjectData_ {
  get data() {
    const self = this as unknown as ObjectStruct;
    const ob = app.doc.objects[self.__id];
    if (ob?.type === 'SPEAKER') {
      ob.speaker ??= defaultSpeaker();
      return speakerStruct(ob.id, null);
    }
    return dataDesc.get!.call(this);
  }
  set data(v: unknown) {
    const self = this as unknown as ObjectStruct;
    const ob = app.doc.objects[self.__id];
    if (ob?.type === 'SPEAKER' && (v as { __table?: string })?.__table === 'speakers') {
      const src = (v as Struct).__resolve() as unknown as SpeakerSettings | null;
      if (src) ob.speaker = structuredClone(src);
      touched();
      return;
    }
    dataDesc.set!.call(this, v);
  }
  get pose() {
    const self = this as unknown as ObjectStruct;
    const ob = obOf(self.__id);
    if (ob.type !== 'ARMATURE') return null;
    ob.pose ??= {};
    const id = self.__id;
    return { __kind: 'struct', __type: 'Pose', bones: new PoseBones(id), toString: () => `<bpy_struct, Pose at ${obPath(id)}.pose>` };
  }
  get shader_effects() {
    return new ShaderEffects((this as unknown as ObjectStruct).__id);
  }
  /** The 8 corners of the evaluated geometry's box in object space (zeros without geometry). */
  get bound_box() {
    ensureEvaluated();
    const P = app.graph.get((this as unknown as ObjectStruct).__id)?.mesh?.positions;
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; P && i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], P[i + k]);
        hi[k] = Math.max(hi[k], P[i + k]);
      }
    if (!Number.isFinite(lo[0])) return Array.from({ length: 8 }, () => [0, 0, 0]);
    const c = (x: number, y: number, z: number) => [x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]];
    return [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0), c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0)];
  }
}
mixin(ObjectStruct, ObjectData_, true);

// ---------------------------------------------------------------------------
// sequencer

const seqPath = 'bpy.context.scene.sequence_editor';

function stripStruct(s: Strip, path: string): unknown {
  const ed = () => app.doc.scene.sequence_editor;
  const st = new Struct(`${s.type === 'META' ? 'Meta' : s.type === 'COLOR' ? 'Color' : s.type === 'TEXT' ? 'Text' : s.type === 'SOUND' ? 'Sound' : s.type === 'MOVIE' ? 'Movie' : s.type === 'IMAGE' ? 'Image' : s.type === 'SCENE' ? 'Scene' : 'Effect'}Strip`, () => (ed() && allStrips(ed()!.strips).includes(s) ? (s as unknown as Raw) : null), path);
  Object.defineProperties(st, {
    __strip: { value: s },
    name: {
      get: () => s.name,
      set: (v: string) => {
        const e = ed()!;
        const old = s.name;
        s.name = uniqueStripName(e, String(v), new Set(allStrips(e.strips).filter((x) => x !== s).map((x) => x.name)));
        for (const x of allStrips(e.strips)) {
          const r = x as unknown as Any;
          if (r.input_1 === old) r.input_1 = s.name;
          if (r.input_2 === old) r.input_2 = s.name;
        }
        if (e.active_strip === old) e.active_strip = s.name;
        touched();
      },
    },
    frame_final_start: { get: () => s.frame_start + s.frame_offset_start },
    frame_final_end: { get: () => s.frame_start + s.frame_duration - s.frame_offset_end },
    frame_final_duration: { get: () => s.frame_duration - s.frame_offset_start - s.frame_offset_end },
    input_1: { get: () => stripByName((s as unknown as Any).input_1 as string) },
    input_2: { get: () => stripByName((s as unknown as Any).input_2 as string) },
    strips: { get: () => (s.type === 'META' ? new Strips(() => (s.strips ??= []), `${path}.strips`) : undefined) },
    /** Strips connected to this one (selected and edited together). */
    connected_strips: { get: () => connectedOf(allStrips(ed()?.strips ?? []), s).map((x) => stripStruct(x, `${seqPath}.strips_all[${q(x.name)}]`)) },
    connect: {
      value: (others: unknown) => {
        const list = allStrips(ed()?.strips ?? []);
        const more = [...((others ?? []) as Iterable<unknown>)].map((x) => (x as { __strip?: Strip }).__strip).filter((x): x is Strip => !!x);
        connect(list, [s, ...more]);
        touched();
      },
    },
    disconnect: {
      value: () => {
        const r = disconnect(allStrips(ed()?.strips ?? []), [s]);
        touched();
        return r;
      },
    },
    /** Retiming keys (speed changes inside the strip): add(timeline_frame), key.speed, reset(). */
    retiming_keys: {
      get: () => {
        const keys = () => (hasRetiming(s) ? s.retiming_keys! : []);
        const key = (i: number) => ({
          __kind: 'struct',
          __type: 'RetimingKey',
          index: i,
          get timeline_frame() {
            return s.frame_start + keys()[i].frame;
          },
          get speed() {
            return speedAt(s, keys()[i].frame);
          },
          set speed(v: number) {
            if (!setSegmentSpeed(s, i, Number(v))) throw pyError('RuntimeError', 'Error: this segment cannot change speed (last key, a transition or a freeze frame)');
            touched();
          },
        });
        return Object.assign(new (class extends PropCollection<unknown> {
          list() {
            return keys().map((_, i) => key(i));
          }
          nameOf() {
            return '';
          }
        })(`${path}.retiming_keys`), {
          add: (timeline_frame: number) => {
            if (!retimable(s)) throw pyError('RuntimeError', `Error: ${s.type} strips cannot be retimed`);
            const i = addKey(s, Number(timeline_frame) - s.frame_start);
            if (i < 0) throw pyError('RuntimeError', 'Error: no key can be added there (outside the strip, or inside a transition)');
            touched();
            return key(i);
          },
          reset: () => {
            resetRetiming(s);
            touched();
          },
        });
      },
    },
  });
  return proxify(st);
}

function stripByName(name: string | null | undefined) {
  const ed = app.doc.scene.sequence_editor;
  const s = ed ? findStrip(ed.strips, name) : null;
  return s ? stripStruct(s, `${seqPath}.strips_all[${q(s.name)}]`) : null;
}

const EFFECTS: StripType[] = ['CROSS', 'GAMMA_CROSS', 'WIPE', 'ADD', 'SUBTRACT', 'MULTIPLY', 'ALPHA_OVER', 'ALPHA_UNDER', 'COLORMIX', 'TRANSFORM', 'SPEED', 'GLOW', 'GAUSSIAN_BLUR', 'MULTICAM', 'COLOR', 'TEXT', 'ADJUSTMENT'];

class Strips extends PropCollection<unknown> {
  constructor(
    readonly strips: () => Strip[],
    path: string,
    readonly all = false,
  ) {
    super(path);
  }
  list() {
    return (this.all ? allStrips(this.strips()) : this.strips()).map((s) => stripStruct(s, `${this.__path}[${q(s.name)}]`));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  private add(s: Strip, name: string) {
    const ed = ensureEditor(app.doc.scene);
    s.name = uniqueStripName(ed, String(name || s.name));
    this.strips().push(s);
    updateEffectRanges(ed.strips);
    touched();
    return stripStruct(s, `${this.__path}[${q(s.name)}]`);
  }
  /** Adds an effect, color, text or adjustment strip; effects with inputs take input1 (and input2). */
  new_effect(name: string, type: string, channel: number, frame_start: number, frame_end: number | null = null, input1: unknown = null, input2: unknown = null) {
    const t = String(type ?? '').toUpperCase() as StripType;
    if (!EFFECTS.includes(t)) throw pyError('TypeError', `Strips.new_effect(): enum "${type}" not found in (${EFFECTS.map((x) => `'${x}'`).join(', ')})`);
    const n = inputCount(t);
    const ins = [input1, input2].filter(Boolean).map((x) => (x as { __strip?: Strip }).__strip);
    if (ins.length < n || ins.some((x) => !x)) throw pyError('RuntimeError', `Error: ${t} strips need ${n} input strip${n === 1 ? '' : 's'} (input1${n > 1 ? ', input2' : ''})`);
    const start = Math.round(Number(frame_start));
    const end = frame_end === null || frame_end === undefined ? start + 25 : Math.round(Number(frame_end));
    const s = newStrip(t, String(name || t), Number(channel), start, Math.max(1, end - start));
    if (n) {
      (s as unknown as Any).input_1 = ins[0]!.name;
      (s as unknown as Any).input_2 = ins[1]?.name ?? null;
    }
    return this.add(s, String(name || t));
  }
  /** Adds a strip showing this scene (through `scene`'s active camera, or the given one). */
  new_scene(name: string, scene: unknown, channel: number, frame_start: number) {
    void scene;
    const sc = app.doc.scene;
    const s = newStrip('SCENE', String(name || sc.name), Number(channel), Math.round(Number(frame_start)), Math.max(1, sc.frame_end - sc.frame_start + 1));
    (s as unknown as Any).scene = sc.name;
    return this.add(s, String(name || sc.name));
  }
  new_image(name: string, filepath: string, channel: number, frame_start: number) {
    void name;
    void channel;
    void frame_start;
    throw pyError('RuntimeError', `Error: cannot read "${filepath}": scripts have no file system access here; add images with Add ▸ Image/Sequence in the Video Sequencer`);
  }
  new_movie(name: string, filepath: string) {
    void name;
    throw pyError('RuntimeError', `Error: cannot read "${filepath}": scripts have no file system access here; add movies with Add ▸ Movie in the Video Sequencer`);
  }
  new_sound(name: string, filepath: string) {
    void name;
    throw pyError('RuntimeError', `Error: cannot read "${filepath}": scripts have no file system access here; add sounds with Add ▸ Sound in the Video Sequencer`);
  }
  new_meta(name: string, channel: number, frame_start: number) {
    const s = newStrip('META', String(name || 'MetaStrip'), Number(channel), Math.round(Number(frame_start)), 1);
    s.strips = [];
    return this.add(s, String(name || 'MetaStrip'));
  }
  remove(strip: unknown) {
    const list = this.strips();
    const s = (strip as { __strip?: Strip })?.__strip;
    const i = s ? list.indexOf(s) : -1;
    if (i < 0) throw pyError('RuntimeError', 'Strips.remove(): strip not found in this list');
    list.splice(i, 1);
    const ed = app.doc.scene.sequence_editor!;
    if (ed.active_strip === s!.name) ed.active_strip = null;
    touched();
  }
}
kwMethod(Strips.prototype, 'new_effect', ['name', 'type', 'channel', 'frame_start', 'frame_end', 'input1', 'input2']);
kwMethod(Strips.prototype, 'new_scene', ['name', 'scene', 'channel', 'frame_start']);
kwMethod(Strips.prototype, 'new_meta', ['name', 'channel', 'frame_start']);

function sequenceEditorStruct() {
  const s = new Struct('SequenceEditor', () => app.doc.scene.sequence_editor as unknown as Raw, seqPath);
  const top = () => ensureEditor(app.doc.scene).strips;
  Object.defineProperties(s, {
    strips: { get: () => new Strips(top, `${seqPath}.strips`) },
    sequences: { get: () => new Strips(top, `${seqPath}.strips`) },
    strips_all: { get: () => new Strips(top, `${seqPath}.strips_all`, true) },
    sequences_all: { get: () => new Strips(top, `${seqPath}.strips_all`, true) },
    active_strip: {
      get: () => stripByName(app.doc.scene.sequence_editor?.active_strip),
      set: (v: unknown) => {
        ensureEditor(app.doc.scene).active_strip = (v as { __strip?: Strip } | null)?.__strip?.name ?? null;
        touched();
      },
    },
    meta_stack: { get: () => (app.doc.scene.sequence_editor?.meta_stack ?? []).map((n) => stripByName(n)) },
  });
  return proxify(s);
}

class SceneData_ {
  get sequence_editor() {
    return app.doc.scene.sequence_editor ? sequenceEditorStruct() : null;
  }
  sequence_editor_create() {
    ensureEditor(app.doc.scene);
    touched();
    return sequenceEditorStruct();
  }
  sequence_editor_clear() {
    delete (app.doc.scene as unknown as Any).sequence_editor;
    touched();
  }
  get view_layers() {
    return new ViewLayers();
  }
}
mixin(SceneStruct, SceneData_, true);

// ---------------------------------------------------------------------------
// view layer: passes (stored with the render settings), names

const PASSES = ['use_pass_combined', 'use_pass_z', 'use_pass_mist', 'use_pass_normal', 'use_pass_position', 'use_pass_uv', 'use_pass_diffuse_color', 'use_pass_emit', 'use_pass_ambient_occlusion', 'use_pass_object_index', 'use_pass_material_index'];
for (const k of PASSES)
  Object.defineProperty(viewLayer, k, {
    get: () => !!(app.doc.scene.render as unknown as Any)[k] || (k === 'use_pass_combined' && (app.doc.scene.render as unknown as Any)[k] === undefined),
    set: (v: unknown) => {
      (app.doc.scene.render as unknown as Any)[k] = !!v;
      touched();
    },
    enumerable: true,
  });
Object.defineProperty(viewLayer, 'use', { value: true, writable: true });
Object.defineProperty(viewLayer, 'samples', { get: () => 0 });

class ViewLayers extends PropCollection<unknown> {
  constructor() {
    super('bpy.context.scene.view_layers');
  }
  list() {
    return [viewLayer];
  }
  nameOf() {
    return 'ViewLayer';
  }
  new(name: string) {
    void name;
    throw pyError('RuntimeError', 'Error: scenes here have one view layer');
  }
}
NEW_PARAMS.grease_pencils = ['name'];
// the name used by earlier versions of the grease pencil API
bpyData.grease_pencils_v3 = bpyData.grease_pencils;
