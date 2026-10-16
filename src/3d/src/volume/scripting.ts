// Scripting: bpy.data.volumes / bpy.data.pointclouds, volume grids (`volume.grids`, with name,
// data_type, channels, matrix_object, load() / unload()), and point cloud points and attributes
// (`pointcloud.points[i].co / radius`, `pointcloud.attributes.new()/remove()` with per-element
// value access). `display` / `render` settings are reached through the generic struct wrapper.
import { app } from '../app/app';
import { ID_CLASSES, IDStruct, NEW_DATA, TABLE_OBTYPE, DATA_TABLE, addDataCollection } from '../scripting/api';
import { PropCollection, boundVector, ensureEvaluated, pyError, toPlain, touched } from '../scripting/rna';
import { Matrix } from '../scripting/mathutils';
import { allocData, dataComps, type DataType } from '../geonodes/types';
import { newVolume } from './data';
import { newPointCloud, pointCount, radii, removeAttr, setAttr, getAttr, DEFAULT_RADIUS } from '../pointcloud/data';
import type { VolumeData, VolumeGrid } from './types';
import type { PointCloudData } from '../pointcloud/types';

// ---------------------------------------------------------------------------
// Volumes

const GRID_TYPE: Record<string, string> = { FLOAT: 'FLOAT', VECTOR_FLOAT: 'VECTOR_FLOAT', INT: 'INT', BOOLEAN: 'BOOLEAN', MASK: 'MASK' };

class VolumeGrids extends PropCollection<unknown> {
  constructor(
    path: string,
    readonly __vo: () => VolumeData,
  ) {
    super(path);
  }
  /** Evaluated grids when modifiers made them, else the stored ones. */
  private grids(): VolumeGrid[] {
    ensureEvaluated();
    const vo = this.__vo();
    for (const ob of Object.values(app.doc.objects))
      if (ob.data === vo.id) {
        const g = app.graph.get(ob.id)?.mesh?.volume;
        if (g) return g;
      }
    return vo.grids;
  }
  list() {
    return this.grids().map((g, i) => this.wrap(g, i));
  }
  nameOf(item: unknown) {
    return (item as { name: string }).name;
  }
  private wrap(g: VolumeGrid, i: number) {
    const self = this;
    return {
      __kind: 'struct',
      __type: 'VolumeGrid',
      get name() {
        return g.name;
      },
      set name(v: string) {
        const vo = self.__vo();
        const k = vo.grids.indexOf(g);
        if (k < 0) throw pyError('AttributeError', 'bpy_struct: attribute "name" of an evaluated grid is read-only');
        vo.grids = vo.grids.map((x, j) => (j === k ? { ...x, name: String(v) } : x));
        touched('geometry');
      },
      get data_type() {
        return GRID_TYPE[g.data_type] ?? 'UNKNOWN';
      },
      get channels() {
        return g.data_type === 'VECTOR_FLOAT' ? 3 : 1;
      },
      get matrix_object() {
        return Matrix.fromColumnMajor(g.transform);
      },
      get is_loaded() {
        return true;
      },
      load() {
        return true;
      },
      unload() {},
      get index() {
        return i;
      },
      repr() {
        return `bpy.data.volumes[${JSON.stringify(self.__vo().name)}].grids[${JSON.stringify(g.name)}]`;
      },
    };
  }
  get active_index() {
    return this.__vo().active_grid_index;
  }
  set active_index(v: number) {
    this.__vo().active_grid_index = Math.max(0, Math.min(Number(v) | 0, this.grids().length - 1));
    touched('doc');
  }
  get active() {
    const g = this.grids();
    return g.length ? this.wrap(g[this.active_index] ?? g[0], this.active_index) : null;
  }
  get is_loaded() {
    return true;
  }
  get error_message() {
    return '';
  }
  get frame() {
    return app.doc.scene.frame_current;
  }
  get frame_filepath() {
    return this.__vo().filepath;
  }
  load() {
    return true;
  }
  unload() {}
}

class VolumeStruct extends IDStruct {
  get grids() {
    return new VolumeGrids(`${this.__path}.grids`, () => this.__raw as unknown as VolumeData);
  }
}

ID_CLASSES.volumes = VolumeStruct;
NEW_DATA.volumes = (name) => {
  app.doc.volumes ??= {};
  return newVolume(name || 'Volume');
};
addDataCollection('volumes', 'Volume');
TABLE_OBTYPE.volumes = 'VOLUME';
DATA_TABLE.VOLUME = 'volumes';

// ---------------------------------------------------------------------------
// Point clouds

class PointCloudPoints extends PropCollection<unknown> {
  constructor(
    path: string,
    readonly __pc: () => PointCloudData,
  ) {
    super(path);
  }
  override get length() {
    return pointCount(this.__pc());
  }
  list() {
    return Array.from({ length: this.length }, (_, i) => this.point(i));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    const n = this.length;
    const i = typeof key === 'number' ? (key < 0 ? key + n : key) : Number(key);
    if (!(i >= 0 && i < n)) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${n}`);
    return this.point(i);
  }
  private point(i: number) {
    const pc = this.__pc;
    return {
      __kind: 'struct',
      __type: 'Point',
      index: i,
      get co() {
        return boundVector('VECTOR', () => pc().positions.subarray(i * 3, i * 3 + 3), (k, x) => {
          const p = pc();
          p.positions = p.positions.slice();
          p.positions[i * 3 + k] = x;
          touched('geometry');
        });
      },
      set co(v: unknown) {
        const a = toPlain(v) as number[];
        const p = pc();
        p.positions = p.positions.slice();
        for (let k = 0; k < 3; k++) p.positions[i * 3 + k] = Number(a[k] ?? 0);
        touched('geometry');
      },
      get radius() {
        return radii(pc())[i];
      },
      set radius(v: number) {
        const p = pc();
        const r = radii(p).slice();
        r[i] = Number(v);
        setAttr(p, 'radius', 'FLOAT', r);
        touched('geometry');
      },
      get select() {
        const a = getAttr(pc(), '.selection');
        return a ? !!a.data[i] : true;
      },
      set select(v: boolean) {
        const p = pc();
        const a = getAttr(p, '.selection');
        const s = a ? Uint8Array.from(a.data) : new Uint8Array(pointCount(p)).fill(1);
        s[i] = v ? 1 : 0;
        setAttr(p, '.selection', 'BOOLEAN', s);
        touched('select');
      },
    };
  }
  /** Append `count` points at the origin (default radius). */
  add(count: number) {
    const p = this.__pc();
    const n = pointCount(p),
      m = Math.max(0, Number(count) | 0);
    const pos = new Float32Array((n + m) * 3);
    pos.set(p.positions);
    const r = new Float32Array(n + m).fill(DEFAULT_RADIUS);
    r.set(radii(p));
    p.attributes = p.attributes
      .filter((a) => a.name !== 'radius')
      .map((a) => {
        const d = allocData(a.data_type, n + m);
        d.set(a.data as never);
        return { ...a, data: d };
      });
    p.positions = pos;
    setAttr(p, 'radius', 'FLOAT', r);
    touched('geometry');
  }
}

const ATTR_TYPES = ['FLOAT', 'INT', 'FLOAT_VECTOR', 'FLOAT_COLOR', 'BOOLEAN', 'FLOAT2', 'INT8', 'QUATERNION'];

class PointCloudAttributes extends PropCollection<unknown> {
  constructor(
    path: string,
    readonly __pc: () => PointCloudData,
  ) {
    super(path);
  }
  list() {
    const p = this.__pc();
    const pos = this.wrapPosition();
    return [pos, ...p.attributes.filter((a) => !a.name.startsWith('.')).map((a) => this.wrap(a.name))];
  }
  nameOf(item: unknown) {
    return (item as { name: string }).name;
  }
  private wrapPosition() {
    const pc = this.__pc;
    return {
      __kind: 'struct',
      __type: 'FloatVectorAttribute',
      name: 'position',
      data_type: 'FLOAT_VECTOR',
      domain: 'POINT',
      is_internal: false,
      is_required: true,
      get data() {
        const n = pointCount(pc());
        return Array.from({ length: n }, (_, i) => ({
          get vector() {
            return boundVector('VECTOR', () => pc().positions.subarray(i * 3, i * 3 + 3), (k, x) => {
              const p = pc();
              p.positions = p.positions.slice();
              p.positions[i * 3 + k] = x;
              touched('geometry');
            });
          },
        }));
      },
    };
  }
  private wrap(name: string) {
    const pc = this.__pc;
    const attr = () => {
      const a = pc().attributes.find((x) => x.name === name);
      if (!a) throw pyError('ReferenceError', `StructRNA of type Attribute has been removed`);
      return a;
    };
    const write = (i: number, vals: number[]) => {
      const a = attr();
      const c = dataComps(a.data_type);
      const d = a.data.slice();
      for (let k = 0; k < c; k++) d[i * c + k] = Number(vals[k] ?? 0);
      setAttr(pc(), a.name, a.data_type, d);
      touched('geometry');
    };
    return {
      __kind: 'struct',
      __type: 'Attribute',
      get name() {
        return name;
      },
      get data_type() {
        return attr().data_type;
      },
      get domain() {
        return 'POINT';
      },
      get is_internal() {
        return false;
      },
      get is_required() {
        return false;
      },
      get data() {
        const a = attr();
        const c = dataComps(a.data_type);
        const n = a.data.length / c;
        return Array.from({ length: n }, (_, i) => ({
          get value() {
            const v = attr().data[i * c];
            return a.data_type === 'BOOLEAN' ? !!v : v;
          },
          set value(v: number | boolean) {
            write(i, [Number(v)]);
          },
          get vector() {
            return boundVector('VECTOR', () => attr().data.subarray(i * c, i * c + c) as Float32Array, (k, x) => {
              const cur = Array.from(attr().data.subarray(i * c, i * c + c));
              cur[k] = x;
              write(i, cur);
            });
          },
          set vector(v: unknown) {
            write(i, toPlain(v) as number[]);
          },
          get color() {
            return boundVector('COLOR', () => attr().data.subarray(i * c, i * c + c) as Float32Array, (k, x) => {
              const cur = Array.from(attr().data.subarray(i * c, i * c + c));
              cur[k] = x;
              write(i, cur);
            });
          },
          set color(v: unknown) {
            write(i, toPlain(v) as number[]);
          },
        }));
      },
    };
  }
  /** Add an attribute on the points. */
  new(name: string, type: string, domain = 'POINT') {
    const t = String(type).toUpperCase();
    if (!ATTR_TYPES.includes(t)) throw pyError('TypeError', `AttributeGroup.new(): enum "${type}" not found in (${ATTR_TYPES.map((x) => `'${x}'`).join(', ')})`);
    if (String(domain).toUpperCase() !== 'POINT') throw pyError('RuntimeError', 'Error: Point clouds only have the POINT domain');
    const p = this.__pc();
    const n = String(name);
    if (n === 'position' || p.attributes.some((a) => a.name === n)) throw pyError('RuntimeError', `Error: Attribute "${n}" already exists`);
    setAttr(p, n, t as DataType, allocData(t as DataType, pointCount(p)));
    touched('geometry');
    return this.wrap(n);
  }
  remove(attribute: unknown) {
    const n = (attribute as { name?: string } | null)?.name;
    if (!n || n === 'position') throw pyError('RuntimeError', 'Error: Attribute cannot be removed');
    if (!removeAttr(this.__pc(), n)) throw pyError('RuntimeError', `Error: Attribute "${n}" not found`);
    touched('geometry');
  }
  get active() {
    const p = this.__pc();
    const a = p.attributes[p.active_attribute ?? -1];
    return a ? this.wrap(a.name) : null;
  }
}

class PointCloudStruct extends IDStruct {
  get points() {
    return new PointCloudPoints(`${this.__path}.points`, () => this.__raw as unknown as PointCloudData);
  }
  get attributes() {
    return new PointCloudAttributes(`${this.__path}.attributes`, () => this.__raw as unknown as PointCloudData);
  }
}

ID_CLASSES.pointclouds = PointCloudStruct;
NEW_DATA.pointclouds = (name) => {
  app.doc.pointclouds ??= {};
  return newPointCloud(name || 'PointCloud');
};
addDataCollection('pointclouds', 'PointCloud');
TABLE_OBTYPE.pointclouds = 'POINTCLOUD';
DATA_TABLE.POINTCLOUD = 'pointclouds';
