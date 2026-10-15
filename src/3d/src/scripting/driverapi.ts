// Scripting access to drivers: Object.driver_add / driver_remove return driver F-Curves whose
// `driver` has type, expression, use_self and `variables` (new / remove) with their targets.
import { app } from '../app/app';
import type { Driver, DriverTarget, DriverVariable, FModifier, ObjectData } from '../data/types';
import { getValue } from '../data/rna';
import { Struct, BoundArray, proxify, touched, pyError, idFactory, findIdTable, isIdWrapper, type Raw } from './rna';
import { insertKeyframe } from '../anim/fcurve';
import { driverCurveValue, runDriver } from '../anim/drivers';
import { compileExpr } from '../anim/driverexpr';

/** Every target field present, so scripts can assign any of them. */
function fullTarget(t: Partial<DriverTarget> = {}): DriverTarget {
  return {
    id: null,
    id_type: 'OBJECT',
    data_path: '',
    bone_target: '',
    transform_type: 'LOC_X',
    transform_space: 'WORLD_SPACE',
    rotation_mode: 'AUTO',
    context_property: 'ACTIVE_SCENE',
    use_fallback_value: false,
    fallback_value: 0,
    ...t,
  };
}

function normalize(d: Driver) {
  d.use_self ??= false;
  for (const v of d.variables) {
    const n = v.type === 'LOC_DIFF' || v.type === 'ROTATION_DIFF' ? 2 : 1;
    while (v.targets.length < n) v.targets.push(fullTarget());
    v.targets = v.targets.map((t) => fullTarget(t));
  }
}

function uniqueName(d: Driver, base: string) {
  const names = new Set(d.variables.map((v) => v.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}_${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

class DriverTargetStruct extends Struct {
  constructor(
    private getT: () => DriverTarget | undefined,
    path: string,
  ) {
    super('DriverTarget', () => getT() as unknown as Raw, path);
  }
  /** the target data-block (an ID wrapper) */
  get id() {
    const id = this.getT()?.id;
    if (!id) return null;
    const t = findIdTable(id);
    return t ? idFactory.wrap(t, id) : null;
  }
  set id(v: unknown) {
    const t = this.getT();
    if (!t) throw pyError('ReferenceError', 'driver target removed');
    if (v === null || v === undefined) t.id = null;
    else if (isIdWrapper(v)) {
      t.id = v.__id;
      const types: Record<string, DriverTarget['id_type']> = { objects: 'OBJECT', meshes: 'MESH', materials: 'MATERIAL', cameras: 'CAMERA', lights: 'LIGHT', curves: 'CURVE', armatures: 'ARMATURE', lattices: 'LATTICE', worlds: 'WORLD', images: 'IMAGE', actions: 'ACTION', node_groups: 'NODETREE', texts: 'TEXT', collections: 'COLLECTION', particles: 'PARTICLE' };
      t.id_type = types[v.__table] ?? 'OBJECT';
    } else throw pyError('TypeError', 'DriverTarget.id expects an ID (for example an Object) or None');
    touched();
  }
}

class DriverVariableStruct extends Struct {
  constructor(
    private getV: () => DriverVariable | undefined,
    path: string,
  ) {
    super('DriverVariable', () => getV() as unknown as Raw, path);
  }
  get type() {
    return this.getV()?.type ?? 'SINGLE_PROP';
  }
  set type(t: string) {
    const v = this.getV();
    if (!v) throw pyError('ReferenceError', 'driver variable removed');
    if (!['SINGLE_PROP', 'TRANSFORMS', 'ROTATION_DIFF', 'LOC_DIFF', 'CONTEXT_PROP'].includes(t)) throw pyError('TypeError', `bpy_struct: item.attr = val: enum "${t}" not found in ('SINGLE_PROP', 'TRANSFORMS', 'ROTATION_DIFF', 'LOC_DIFF', 'CONTEXT_PROP')`);
    v.type = t as DriverVariable['type'];
    const n = t === 'LOC_DIFF' || t === 'ROTATION_DIFF' ? 2 : 1;
    v.targets = Array.from({ length: n }, (_, i) => fullTarget(i === 0 ? { id: v.targets[0]?.id ?? null, data_path: v.targets[0]?.data_path ?? '' } : {}));
    touched();
  }
  get targets() {
    const getV = this.getV;
    const base = `${this.__path}.targets`;
    const arr = new BoundArray('DriverTarget', base, () => getV()?.targets as unknown[] | undefined, 'targets');
    return Object.assign(arr, {
      getItem: (i: number) => {
        const n = getV()?.targets.length ?? 0;
        const idx = i < 0 ? n + i : i;
        if (idx < 0 || idx >= n) throw pyError('IndexError', `bpy_prop_collection[index]: index ${i} out of range`);
        return proxify(new DriverTargetStruct(() => getV()?.targets[idx], `${base}[${idx}]`));
      },
    });
  }
}

class DriverStruct extends Struct {
  constructor(
    private getD: () => Driver | undefined,
    private ob: () => ObjectData | undefined,
    path: string,
  ) {
    super('Driver', () => getD() as unknown as Raw, path);
  }
  get type() {
    return this.getD()?.type ?? 'SCRIPTED';
  }
  set type(t: string) {
    const d = this.getD();
    if (!d) throw pyError('ReferenceError', 'driver removed');
    if (!['AVERAGE', 'SUM', 'SCRIPTED', 'MIN', 'MAX'].includes(t)) throw pyError('TypeError', `bpy_struct: item.attr = val: enum "${t}" not found in ('AVERAGE', 'SUM', 'SCRIPTED', 'MIN', 'MAX')`);
    d.type = t as Driver['type'];
    touched();
  }
  get variables() {
    const getD = this.getD;
    const base = `${this.__path}.variables`;
    const arr = new BoundArray('DriverVariable', base, () => getD()?.variables as unknown[] | undefined, 'variables');
    const wrap = (i: number) => proxify(new DriverVariableStruct(() => getD()?.variables[i], `${base}[${i}]`));
    return Object.assign(arr, {
      getItem: (i: number | string) => {
        const vs = getD()?.variables ?? [];
        let idx = typeof i === 'string' ? vs.findIndex((v) => v.name === i) : i < 0 ? vs.length + i : i;
        if (idx < 0 || idx >= vs.length) throw pyError(typeof i === 'string' ? 'KeyError' : 'IndexError', `driver variable ${i} not found`);
        idx = Math.trunc(idx);
        return wrap(idx);
      },
      new: () => {
        const d = getD();
        if (!d) throw pyError('ReferenceError', 'driver removed');
        d.variables.push({ name: uniqueName(d, 'var'), type: 'SINGLE_PROP', targets: [fullTarget()] });
        touched();
        return wrap(d.variables.length - 1);
      },
      remove: (v: DriverVariableStruct) => {
        const d = getD();
        const raw = v?.__resolve?.();
        const i = d ? d.variables.indexOf(raw as unknown as DriverVariable) : -1;
        if (!d || i < 0) throw pyError('ValueError', 'variable not in this driver');
        d.variables.splice(i, 1);
        touched();
      },
    });
  }
  get is_valid() {
    const d = this.getD(),
      ob = this.ob();
    return !!d && !!ob && !runDriver(app.doc, ob, d, app.doc.scene.frame_current).error;
  }
  get is_simple_expression() {
    try {
      return compileExpr(this.getD()?.expression ?? '').simple;
    } catch {
      return false;
    }
  }
}

class DriverFCurveStruct extends Struct {
  constructor(
    private getD: () => Driver | undefined,
    private ob: () => ObjectData | undefined,
    path: string,
  ) {
    super('FCurve', () => getD()?.fcurve as unknown as Raw, path);
  }
  get driver() {
    return proxify(new DriverStruct(this.getD, this.ob, `${this.__path}.driver`));
  }
  get keyframe_points() {
    const fc = () => this.getD()?.fcurve;
    const arr = new BoundArray('Keyframe', `${this.__path}.keyframe_points`, () => fc()?.keyframe_points as unknown[] | undefined, 'keyframe_points');
    return Object.assign(arr, {
      insert: (x: number, y: number) => {
        const f = fc();
        if (!f) throw pyError('ReferenceError', 'F-Curve removed');
        // keys define the mapping: the default straight-line Generator gives way
        if (f.modifiers.length === 1 && f.modifiers[0].type === 'GENERATOR' && JSON.stringify(f.modifiers[0].coefficients) === '[0,1]') f.modifiers = [];
        insertKeyframe(f, Number(x), Number(y));
        touched();
        return arr.getItem(f.keyframe_points.findIndex((k) => Math.abs(k.co[0] - x) < 1e-6));
      },
    });
  }
  get modifiers() {
    const fc = () => this.getD()?.fcurve;
    const arr = new BoundArray('FModifier', `${this.__path}.modifiers`, () => fc()?.modifiers as unknown[] | undefined, 'modifiers');
    return Object.assign(arr, {
      new: (type: string) => {
        const f = fc();
        if (!f) throw pyError('ReferenceError', 'F-Curve removed');
        const m: FModifier = type === 'GENERATOR' ? { type: 'GENERATOR', coefficients: [0, 1], use_additive: false } : ({ type } as FModifier);
        f.modifiers.push(m);
        touched();
        return arr.getItem(f.modifiers.length - 1);
      },
    });
  }
  evaluate(x: number) {
    return driverCurveValue(this.getD()?.fcurve, Number(x));
  }
}

/** Object.driver_add(path, index): one F-Curve, or a list for a whole array (index -1). */
export function driverAdd(ob: ObjectData, path: string, index = -1, obPath = ''): unknown {
  const val = getValue(app.doc, ob, path);
  if (val === undefined) throw pyError('TypeError', `bpy_struct.driver_add(): property "${path}" not found`);
  const isArr = Array.isArray(val) || ArrayBuffer.isView(val);
  if (!isArr && typeof val !== 'number' && typeof val !== 'boolean') throw pyError('TypeError', `bpy_struct.driver_add(): property "${path}" can not be driven`);
  const indices = index >= 0 ? [index] : isArr ? [...Array((val as ArrayLike<number>).length).keys()] : [0];
  const obId = ob.id;
  const ad = (ob.animation_data ??= { action: null, nla_tracks: [], drivers: [] });
  const out = indices.map((i) => {
    let d = ad.drivers.find((x) => x.data_path === path && x.array_index === i);
    if (!d) {
      d = { data_path: path, array_index: i, type: 'SCRIPTED', expression: 'var', variables: [], use_self: false };
      d.fcurve = { data_path: path, array_index: i, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [{ type: 'GENERATOR', coefficients: [0, 1], use_additive: false }] };
      ad.drivers.push(d);
    }
    normalize(d);
    const getOb = () => app.doc.objects[obId];
    const getD = () => getOb()?.animation_data?.drivers.find((x) => x.data_path === path && x.array_index === i);
    return proxify(new DriverFCurveStruct(getD, getOb, `${obPath}.animation_data.drivers.find(${JSON.stringify(path)}, ${i})`));
  });
  touched();
  return index < 0 && isArr ? out : out[0];
}

/** Object.driver_remove(path, index): True when a driver was removed. */
export function driverRemove(ob: ObjectData, path: string, index = -1): boolean {
  const ad = ob.animation_data;
  if (!ad) return false;
  const n = ad.drivers.length;
  ad.drivers = ad.drivers.filter((d) => !(d.data_path === path && (index < 0 || d.array_index === index)));
  touched();
  return ad.drivers.length !== n;
}
