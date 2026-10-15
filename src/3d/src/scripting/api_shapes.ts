// Curve splines and points made from scripts (splines.new, bezier_points.add, points.add),
// shape keys (key_blocks with per-vertex data, keyframes on their values, removal) and grease
// pencil styles on materials (bpy.data.materials.create_gpencil_data).
import { app } from '../app/app';
import type { BezierPoint, MeshData, ShapeKey, Spline, SplinePoint } from '../data/types';
import { defaultGPStyle } from '../greasepencil/data';
import { MeshStruct, ObjectStruct, bpyData, dataRecord, uniqueName } from './api';
import { insertKey } from './api_anim';
import { PropCollection, Struct, arrayFactories, boundVector, kwMethod, mixin, proxify, pyError, toPlain, touched, expectId, type Raw } from './rna';

const q = (s: string) => JSON.stringify(s);

// ---------------------------------------------------------------------------
// curves

const bezierPoint = (): BezierPoint => ({ co: [0, 0, 0], handle_left: [0, 0, 0], handle_right: [0, 0, 0], handle_left_type: 'AUTO', handle_right_type: 'AUTO', radius: 1, tilt: 0 });
const nurbsPoint = (): SplinePoint => ({ co: [0, 0, 0, 1], radius: 1, tilt: 0 }) as SplinePoint;

arrayFactories.unshift(
  {
    // a new spline has one point, like one drawn with a single click
    match: /^bpy\.data\.curves\[\]\.splines$/,
    make: (a) => {
      const type = String(a[0] ?? 'POLY').toUpperCase() as Spline['type'];
      if (!['POLY', 'BEZIER', 'NURBS'].includes(type)) throw pyError('TypeError', `CurveSplines.new(): enum "${a[0]}" not found in ('POLY', 'BEZIER', 'NURBS')`);
      return { type, bezier_points: type === 'BEZIER' ? [bezierPoint()] : [], points: type === 'BEZIER' ? [] : [nurbsPoint()], use_cyclic_u: false, resolution_u: 12, order_u: 4, use_endpoint_u: type === 'NURBS', use_smooth: true, material_index: 0 } as Spline;
    },
  },
  { match: /^bpy\.data\.curves\[\]\.splines\[\]\.bezier_points$/, make: () => bezierPoint() },
  { match: /^bpy\.data\.curves\[\]\.splines\[\]\.points$/, make: () => nurbsPoint() },
);

// ---------------------------------------------------------------------------
// shape keys

const meshOfOb = (obId: string) => {
  const ob = app.doc.objects[obId];
  const me = ob?.type === 'MESH' ? (dataRecord(ob) as unknown as MeshData | null) : null;
  if (!me) throw pyError('TypeError', 'shape keys require a mesh object');
  return me;
};

function shapeKeyStruct(meId: string, k: ShapeKey): unknown {
  const me = () => app.doc.meshes[meId];
  const path = `bpy.data.meshes[${q(me()?.name ?? '?')}].shape_keys.key_blocks[${q(k.name)}]`;
  const s = new Struct('ShapeKey', () => (me()?.shape_keys.includes(k) ? (k as unknown as Raw) : null), path);
  const points = () => k.data.length / 3;
  const point = (i: number) => ({
    __kind: 'struct',
    __type: 'ShapeKeyPoint',
    get co() {
      return boundVector('VECTOR', () => k.data.subarray(i * 3, i * 3 + 3), (c, x) => {
        k.data = k.data.slice();
        k.data[i * 3 + c] = x;
        touched('geometry');
      });
    },
    set co(v: unknown) {
      const a = toPlain(v) as number[];
      k.data = k.data.slice();
      for (let c = 0; c < 3; c++) k.data[i * 3 + c] = Number(a[c] ?? 0);
      touched('geometry');
    },
  });
  const data = new (class extends PropCollection<unknown> {
    override get length() {
      return points();
    }
    list() {
      return Array.from({ length: points() }, (_, i) => point(i));
    }
    nameOf() {
      return '';
    }
    override getItem(key: number | string) {
      if (typeof key !== 'number') throw pyError('TypeError', 'bpy_prop_collection: index must be an int');
      const i = key < 0 ? key + points() : key;
      if (i < 0 || i >= points()) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${points()}`);
      return point(i);
    }
    foreach_get(attr: string, seq?: unknown) {
      if (attr !== 'co') throw pyError('TypeError', `foreach_get: unsupported attribute "${attr}" (supported: co)`);
      const out = Array.from(k.data);
      if (Array.isArray(seq)) for (let i = 0; i < out.length && i < seq.length; i++) seq[i] = out[i];
      return out;
    }
    foreach_set(attr: string, seq: unknown) {
      if (attr !== 'co') throw pyError('TypeError', `foreach_set: unsupported attribute "${attr}" (supported: co)`);
      const a = (toPlain(seq) as unknown[]).flat() as number[];
      if (a.length !== k.data.length) throw pyError('ValueError', `foreach_set: expected ${k.data.length} values, got ${a.length}`);
      k.data = Float32Array.from(a, Number);
      touched('geometry');
    }
  })(`${path}.data`);
  Object.defineProperties(s, {
    __key: { value: k },
    data: { value: data },
    points: { value: data },
    name: {
      get: () => k.name,
      set: (v: string) => {
        const m = me()!;
        const old = k.name;
        k.name = uniqueName(Object.fromEntries(m.shape_keys.filter((x) => x !== k).map((x, i) => [i, x])), String(v));
        for (const o of m.shape_keys) if (o.relative_key === old) o.relative_key = k.name;
        touched();
      },
    },
    relative_key: {
      get: () => {
        const r = me()?.shape_keys.find((x) => x.name === k.relative_key);
        return r ? shapeKeyStruct(meId, r) : null;
      },
      set: (v: unknown) => {
        const r = (v as { __key?: ShapeKey } | null)?.__key;
        if (!r) throw pyError('TypeError', 'relative_key expects a shape key of the same mesh');
        k.relative_key = r.name;
        touched('geometry');
      },
    },
    /** Keys the value on the objects using this mesh. */
    keyframe_insert: {
      configurable: true,
      writable: true,
      value: (data_path = 'value', index = -1, frame: unknown = null) => {
        const ob = Object.values(app.doc.objects).find((o) => o.data === meId && o.type === 'MESH');
        if (!ob) throw pyError('TypeError', 'shape key values are animated on an object using the mesh; none does');
        return insertKey({ ob, path: `data.shape_keys.key_blocks[${q(k.name)}].${data_path}` }, Number(index ?? -1), frame);
      },
    },
  });
  kwMethod(s, 'keyframe_insert', ['data_path', 'index', 'frame', 'group']);
  return proxify(s);
}

class KeyBlocks extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`bpy.data.meshes[${q(app.doc.meshes[meId]?.name ?? '?')}].shape_keys.key_blocks`);
  }
  list() {
    return (app.doc.meshes[this.meId]?.shape_keys ?? []).map((k) => shapeKeyStruct(this.meId, k));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
}

class MeshShapes {
  get shape_keys() {
    const self = this as unknown as MeshStruct;
    const me = self.me;
    if (!me.shape_keys.length) return null;
    const id = self.__id;
    return {
      __kind: 'struct',
      __type: 'Key',
      name: 'Key',
      key_blocks: new KeyBlocks(id),
      get reference_key() {
        const k = app.doc.meshes[id]?.shape_keys[0];
        return k ? shapeKeyStruct(id, k) : null;
      },
      use_relative: true,
      user: self,
    };
  }
}
mixin(MeshStruct, MeshShapes, true);

class ObjectShapes {
  get active_shape_key() {
    const self = this as unknown as ObjectStruct;
    const ob = app.doc.objects[self.__id];
    if (ob?.type !== 'MESH') return null;
    const me = meshOfOb(ob.id);
    const k = me.shape_keys[me.active_shape_key_index];
    return k ? shapeKeyStruct(me.id, k) : null;
  }
  get active_shape_key_index() {
    const ob = app.doc.objects[(this as unknown as ObjectStruct).__id];
    return ob?.type === 'MESH' ? meshOfOb(ob.id).active_shape_key_index : 0;
  }
  set active_shape_key_index(i: number) {
    const me = meshOfOb((this as unknown as ObjectStruct).__id);
    me.active_shape_key_index = Math.max(0, Math.min(me.shape_keys.length - 1, Math.round(Number(i))));
    touched();
  }
  shape_key_add(name = 'Key', from_mix = true) {
    void from_mix;
    const id = (this as unknown as ObjectStruct).__id;
    const me = meshOfOb(id);
    const basis = !me.shape_keys.length;
    const k: ShapeKey = { name: basis ? 'Basis' : uniqueName(Object.fromEntries(me.shape_keys.map((x, i) => [i, x])), String(name || 'Key')), data: new Float32Array(me.positions), value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: me.shape_keys[0]?.name ?? 'Basis' };
    me.shape_keys.push(k);
    touched('geometry');
    return shapeKeyStruct(me.id, k);
  }
  shape_key_remove(key: unknown) {
    const me = meshOfOb((this as unknown as ObjectStruct).__id);
    const k = (key as { __key?: ShapeKey })?.__key;
    const i = k ? me.shape_keys.indexOf(k) : -1;
    if (i < 0) throw pyError('RuntimeError', 'Object.shape_key_remove(): key not found');
    me.shape_keys.splice(i, 1);
    for (const o of me.shape_keys) if (o.relative_key === k!.name) o.relative_key = me.shape_keys[0]?.name ?? 'Basis';
    me.active_shape_key_index = Math.max(0, Math.min(me.active_shape_key_index, me.shape_keys.length - 1));
    touched('geometry');
  }
  shape_key_clear() {
    const me = meshOfOb((this as unknown as ObjectStruct).__id);
    me.shape_keys = [];
    me.active_shape_key_index = 0;
    touched('geometry');
  }
}
mixin(ObjectStruct, ObjectShapes, true);
kwMethod(ObjectStruct.prototype, 'shape_key_add', ['name', 'from_mix']);
kwMethod(ObjectStruct.prototype, 'shape_key_remove', ['key']);

// ---------------------------------------------------------------------------
// grease pencil material style

const materials = bpyData.materials as Record<string, unknown>;
Object.defineProperties(materials, {
  /** Gives a material grease pencil stroke and fill settings (material.grease_pencil). */
  create_gpencil_data: {
    value: (material: unknown) => {
      const id = expectId(material, 'materials', 'Material');
      const m = app.doc.materials[id];
      m.grease_pencil ??= defaultGPStyle();
      touched();
    },
  },
  remove_gpencil_data: {
    value: (material: unknown) => {
      const m = app.doc.materials[expectId(material, 'materials', 'Material')];
      delete m.grease_pencil;
      touched();
    },
  },
});
