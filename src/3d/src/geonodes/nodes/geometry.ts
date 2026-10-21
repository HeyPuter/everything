// Geometry, attribute and instance-level nodes that work on any component.
import { curvesMoved } from '../curves/curvedata';
import { gn, prop, sprop } from './defs';
import { evalOn, pointDomainOf, hasDomain, DATA_TYPE_ITEMS } from './common';
import { GeometrySet, InstancesComponent, composeMat, geometryBounds, mulMat, allocData, readAttribute, type Component } from '../geometry';
import { joinGeometries, realizeInstances, transformGeometry } from '../ops/join';
import { boxMesh, convexHull } from '../ops/hull';
import { deleteCurves, deleteMesh, deletePoints, mergeMesh, mergePoints, type DeleteMode } from '../ops/meshops';
import { ConstField, InputField, makeContext, evalFull, type Field } from '../field';
import { attributeField, positionField } from '../inputs';
import { dataTypeOfField, fieldTypeOfEnum, fieldComps, type DataType, type Domain, type FieldType } from '../types';
import type { NodeData } from '../../data/types';
import type { ExecContext } from '../exec';
import type { SocketDef } from '../../nodes/types';

// ---------------------------------------------------------------------------
// Set Position / Transform

function setPositions(c: Component, sel: Field, pos: Field, off: Field, implicitPos: boolean): Component {
  const dom = pointDomainOf(c);
  const r = evalOn(c, dom, sel, [pos, off]);
  const n = r.ctx.size;
  if (!n) return c;
  const P = r.values[0] as Float32Array,
    O = r.values[1] as Float32Array;
  if (c.kind === 'INSTANCES') {
    const T = new Float32Array(c.transforms);
    for (let i = 0; i < n; i++) {
      if (r.sel && !r.sel[i]) continue;
      T[i * 16 + 12] = P[i * 3] + O[i * 3];
      T[i * 16 + 13] = P[i * 3 + 1] + O[i * 3 + 1];
      T[i * 16 + 14] = P[i * 3 + 2] + O[i * 3 + 2];
    }
    const out = c.copy();
    out.transforms = T;
    return out;
  }
  const old = c.positions;
  const out = new Float32Array(old.length);
  for (let i = 0; i < n; i++) {
    const s = !r.sel || r.sel[i];
    for (let k = 0; k < 3; k++) out[i * 3 + k] = s ? P[i * 3 + k] + O[i * 3 + k] : old[i * 3 + k];
  }
  void implicitPos;
  const cc = c.copy();
  cc.positions = out;
  return cc.kind === 'CURVES' ? curvesMoved(cc, old) : cc;
}

gn('GeometryNodeSetPosition', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Geometry');
    const sel = ctx.field('Selection', 'BOOLEAN'),
      pos = ctx.field('Position', 'VECTOR'),
      off = ctx.field('Offset', 'VECTOR');
    // nothing to do for the implicit position and a zero offset
    const zero = off instanceof ConstField && (off.value as number[]).every((x) => x === 0);
    if (!ctx.linked('Position') && zero) return { Geometry: g };
    return {
      Geometry: g.map((c) => setPositions(c, sel, pos, off, !ctx.linked('Position'))),
    };
  },
  implicit: { Position: positionField },
});

gn(
  'GeometryNodeTransform',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const m = prop(ctx.node, 'Mode') === 'Matrix' ? ctx.matrix('Transform') : Array.from(composeMat(ctx.vector('Translation'), ctx.vector('Rotation'), ctx.vector('Scale')));
      return { Geometry: transformGeometry(g, m) };
    },
  },
  {
    menus: {
      Mode: [
        ['Components', 'Components'],
        ['Matrix', 'Matrix'],
      ],
    },
    available: (n, s) => {
      const matrix = prop(n, 'Mode') === 'Matrix';
      if (s.identifier === 'Transform') return matrix;
      if (s.identifier === 'Translation' || s.identifier === 'Rotation' || s.identifier === 'Scale') return !matrix;
      return !s.disabled;
    },
  },
);

{
  const d = gn('GeometryNodeJoinGeometry', 'geometry', {
    exec: (ctx) => ({ Geometry: joinGeometries(ctx.geometries('Geometry')) }),
  });
  d.inputs[0].multiInput = true;
}

gn('GeometryNodeBoundBox', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Geometry');
    const b = geometryBounds(g, ctx.bool('Use Radius'));
    if (!b)
      return {
        'Bounding Box': GeometrySet.empty(),
        Min: [0, 0, 0],
        Max: [0, 0, 0],
      };
    return {
      'Bounding Box': new GeometrySet(boxMesh(b.min, b.max)),
      Min: b.min,
      Max: b.max,
    };
  },
});

gn('GeometryNodeConvexHull', 'geometry', {
  exec: (ctx) => {
    const g = realizeInstances(ctx.geometry('Geometry'));
    const parts: Float32Array[] = [];
    if (g.mesh) parts.push(g.mesh.positions);
    if (g.points) parts.push(g.points.positions);
    if (g.curves) parts.push(g.curves.positions);
    let n = 0;
    for (const p of parts) n += p.length;
    const all = new Float32Array(n);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    return {
      'Convex Hull': n ? new GeometrySet(convexHull(all)) : GeometrySet.empty(),
    };
  },
});

// ---------------------------------------------------------------------------
// Delete / separate / merge

function deleteFrom(g: GeometrySet, domain: Domain, sel: Field, mode: DeleteMode, invert: boolean): GeometrySet {
  return g.map((c) => {
    if (!hasDomain(c, domain)) return c;
    const ctx = makeContext(c, domain);
    let del = evalFull(sel, ctx) as Uint8Array;
    if (invert) del = Uint8Array.from(del, (x) => (x ? 0 : 1));
    if (!del.some((x) => x)) return c;
    if (c.kind === 'MESH') {
      const m = deleteMesh(c, domain, del, mode);
      return m && (m.vertCount || m.faceCount) ? m : null;
    }
    if (c.kind === 'POINTS') {
      const p = deletePoints(c, del);
      return p.count ? p : null;
    }
    if (c.kind === 'CURVES') {
      const cu = deleteCurves(c, domain, del);
      return cu.curveCount ? cu : null;
    }
    const keep: number[] = [];
    for (let i = 0; i < c.count; i++) if (!del[i]) keep.push(i);
    if (!keep.length) return null;
    const T = new Float32Array(keep.length * 16),
      R = new Int32Array(keep.length);
    keep.forEach((s, i) => {
      T.set(c.transforms.subarray(s * 16, s * 16 + 16), i * 16);
      R[i] = c.refIndex[s];
    });
    const out = new InstancesComponent(T, R, c.references);
    for (const [name, a] of c.attrs) {
      const comps = a.data.length / c.count;
      const d = allocData(a.type, keep.length);
      keep.forEach((s, i) => {
        for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[s * comps + k];
      });
      out.attrs.set(name, { ...a, data: d });
    }
    return out;
  });
}

const DELETE_DOMAINS = ['POINT', 'EDGE', 'FACE', 'CURVE', 'INSTANCE'];

gn(
  'GeometryNodeDeleteGeometry',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      return {
        Geometry: deleteFrom(g, sprop(ctx.node, 'domain') as Domain, ctx.field('Selection', 'BOOLEAN'), sprop(ctx.node, 'mode') as DeleteMode, false),
      };
    },
  },
  {
    items: { domain: DELETE_DOMAINS },
    propPatch: {
      mode: { visible: (n) => ['POINT', 'EDGE', 'FACE'].includes(sprop(n, 'domain')) },
    },
  },
);

gn(
  'GeometryNodeSeparateGeometry',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const d = sprop(ctx.node, 'domain') as Domain;
      const sel = ctx.field('Selection', 'BOOLEAN');
      return {
        Selection: ctx.used('Selection') ? deleteFrom(g, d, sel, 'ALL', true) : GeometrySet.empty(),
        Inverted: ctx.used('Inverted') ? deleteFrom(g, d, sel, 'ALL', false) : GeometrySet.empty(),
      };
    },
  },
  { items: { domain: DELETE_DOMAINS } },
);

gn(
  'GeometryNodeMergeByDistance',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const dist = Math.max(0, ctx.float('Distance'));
      const connected = prop(ctx.node, 'Mode') === 'Connected';
      const selF = ctx.field('Selection', 'BOOLEAN');
      return {
        Geometry: g.map((c) => {
          if (c.kind === 'MESH') return mergeMesh(c, evalOn(c, 'POINT', selF, []).sel, dist, connected);
          if (c.kind === 'POINTS') return mergePoints(c, evalOn(c, 'POINT', selF, []).sel, dist);
          return c;
        }),
      };
    },
  },
  {
    menus: {
      Mode: [
        ['All', 'All'],
        ['Connected', 'Connected'],
      ],
    },
  },
);

/** The volume grids of a geometry on their own. */
function volumeOnly(g: GeometrySet): GeometrySet {
  const out = new GeometrySet();
  out.volume = g.volume;
  return out;
}

gn(
  'GeometryNodeSeparateComponents',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      return {
        Mesh: new GeometrySet(g.mesh),
        Curve: new GeometrySet(undefined, undefined, g.curves),
        'Point Cloud': new GeometrySet(undefined, g.points),
        Instances: new GeometrySet(undefined, undefined, undefined, g.instances),
        Volume: volumeOnly(g),
      };
    },
  },
  { drop: ['Grease Pencil'] },
);

// ---------------------------------------------------------------------------
// Instances

gn(
  'GeometryNodeRealizeInstances',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      if (!g.instances) return { Geometry: g };
      const r = evalOn(g.instances, 'INSTANCE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Realize All', 'BOOLEAN'), ctx.field('Depth', 'INT')]);
      const all = r.values[0],
        depth = r.values[1];
      return {
        Geometry: realizeInstances(g, r.sel, (i) => (all[i] ? Infinity : Math.max(0, depth[i]))),
      };
    },
  },
  {
    drop: ['realize_to_point_domain'],
    available: (n, s) => (s.identifier === 'Depth' ? true : !s.disabled),
  },
);

function instanceOp(ctx: ExecContext, fn: (T: Float32Array, i: number, local: boolean, vals: ArrayLike<number>[]) => void, fields: Field[]) {
  const g = ctx.geometry('Instances');
  const inst = g.instances;
  if (!inst) return { Instances: g };
  const r = evalOn(inst, 'INSTANCE', ctx.field('Selection', 'BOOLEAN'), [...fields, ctx.field('Local Space', 'BOOLEAN')]);
  const T = new Float32Array(inst.transforms);
  const local = r.values[r.values.length - 1];
  for (let i = 0; i < inst.count; i++) if (!r.sel || r.sel[i]) fn(T, i, !!local[i], r.values);
  const out = inst.copy();
  out.transforms = T;
  return { Instances: g.with(out) };
}

gn('GeometryNodeTranslateInstances', 'geometry', {
  exec: (ctx) =>
    instanceOp(
      ctx,
      (T, i, local, v) => {
        const t = [v[0][i * 3], v[0][i * 3 + 1], v[0][i * 3 + 2]];
        const m = T.subarray(i * 16, i * 16 + 16);
        const d = local ? [m[0] * t[0] + m[4] * t[1] + m[8] * t[2], m[1] * t[0] + m[5] * t[1] + m[9] * t[2], m[2] * t[0] + m[6] * t[1] + m[10] * t[2]] : t;
        m[12] += d[0];
        m[13] += d[1];
        m[14] += d[2];
      },
      [ctx.field('Translation', 'VECTOR')],
    ),
});

gn('GeometryNodeRotateInstances', 'geometry', {
  exec: (ctx) =>
    instanceOp(
      ctx,
      (T, i, local, v) => {
        const R = composeMat([0, 0, 0], [v[0][i * 3], v[0][i * 3 + 1], v[0][i * 3 + 2]], [1, 1, 1]);
        const pivot = [v[1][i * 3], v[1][i * 3 + 1], v[1][i * 3 + 2]];
        const m = T.subarray(i * 16, i * 16 + 16);
        const toP = composeMat(pivot, [0, 0, 0], [1, 1, 1]),
          fromP = composeMat([-pivot[0], -pivot[1], -pivot[2]], [0, 0, 0], [1, 1, 1]);
        const res = local ? mulMat(m, mulMat(toP, mulMat(R, fromP))) : mulMat(mulMat(toP, mulMat(R, fromP)), m);
        m.set(res);
      },
      [ctx.field('Rotation', 'ROTATION'), ctx.field('Pivot Point', 'VECTOR')],
    ),
});

gn('GeometryNodeScaleInstances', 'geometry', {
  exec: (ctx) =>
    instanceOp(
      ctx,
      (T, i, local, v) => {
        const S = composeMat([0, 0, 0], [0, 0, 0], [v[0][i * 3], v[0][i * 3 + 1], v[0][i * 3 + 2]]);
        const c = [v[1][i * 3], v[1][i * 3 + 1], v[1][i * 3 + 2]];
        const m = T.subarray(i * 16, i * 16 + 16);
        const toC = composeMat(c, [0, 0, 0], [1, 1, 1]),
          fromC = composeMat([-c[0], -c[1], -c[2]], [0, 0, 0], [1, 1, 1]);
        const res = local ? mulMat(m, mulMat(toC, mulMat(S, fromC))) : mulMat(mulMat(toC, mulMat(S, fromC)), m);
        m.set(res);
      },
      [ctx.field('Scale', 'VECTOR'), ctx.field('Center', 'VECTOR')],
    ),
});

// ---------------------------------------------------------------------------
// Attributes

/** Store field values on a component domain under a name (position writes the positions). */
export function storeOn(c: Component, domain: Domain, name: string, type: FieldType, field: Field, selF?: Field): Component {
  if (!hasDomain(c, domain)) return c;
  const r = evalOn(c, domain, selF, [field]);
  const n = r.ctx.size;
  const vals = r.values[0];
  const comps = fieldComps(type);
  if (name === 'position' && type === 'VECTOR' && domain === pointDomainOf(c) && c.kind !== 'INSTANCES') {
    const out = c.copy();
    const p = new Float32Array(c.positions);
    for (let i = 0; i < n; i++) if (!r.sel || r.sel[i]) for (let k = 0; k < 3; k++) p[i * 3 + k] = vals[i * 3 + k];
    out.positions = p;
    return out;
  }
  const dt: DataType = dataTypeOfField(type);
  let data = vals;
  if (r.sel) {
    // unselected elements keep their previous value (or default)
    const prev = readAttribute(c, name, domain);
    data = allocData(dt, n);
    if (prev && prev.type === dt) data.set(prev.data.subarray(0, n * comps));
    for (let i = 0; i < n; i++) if (r.sel[i]) for (let k = 0; k < comps; k++) data[i * comps + k] = vals[i * comps + k];
  }
  const out = c.copy();
  out.attrs.set(name, { domain, type: dt, data });
  return out;
}

const STORE_TYPES = DATA_TYPE_ITEMS;

gn(
  'GeometryNodeStoreNamedAttribute',
  'attribute',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const name = ctx.string('Name');
      if (!name) return { Geometry: g };
      const dataType = sprop(ctx.node, 'data_type');
      const t = fieldTypeOfEnum(dataType);
      const domain = sprop(ctx.node, 'domain') as Domain;
      const f = ctx.field('Value', t);
      const sel = ctx.field('Selection', 'BOOLEAN');
      let out = g.map((c) => storeOn(c, domain, name, t, f, sel));
      if (dataType === 'FLOAT2')
        out = out.map((c) => {
          const a = c.attrs.get(name);
          if (!a || a.type !== 'FLOAT_VECTOR') return c;
          const n = a.data.length / 3;
          const d = new Float32Array(n * 2);
          for (let i = 0; i < n; i++) {
            d[i * 2] = a.data[i * 3];
            d[i * 2 + 1] = a.data[i * 3 + 1];
          }
          const cc = c.copy();
          cc.attrs.set(name, { domain: a.domain, type: 'FLOAT2', data: d });
          return cc;
        });
      return { Geometry: out };
    },
  },
  {
    items: {
      data_type: STORE_TYPES,
      domain: ['POINT', 'EDGE', 'FACE', 'CORNER', 'CURVE', 'INSTANCE'],
    },
    dynamicSockets: (node) => ({
      inputs: [
        { name: 'Geometry', identifier: 'Geometry', type: 'GEOMETRY' },
        {
          name: 'Selection',
          identifier: 'Selection',
          type: 'BOOLEAN',
          default: true,
          hide_value: true,
          shape: 'DIAMOND',
        },
        { name: 'Name', identifier: 'Name', type: 'STRING', default: '' },
        valueSocket('Value', fieldTypeOfEnum(prop(node, 'data_type'))),
      ],
      outputs: [{ name: 'Geometry', identifier: 'Geometry', type: 'GEOMETRY' }],
    }),
  },
);

export function valueSocket(id: string, t: FieldType, name = id): SocketDef {
  const d: Record<FieldType, SocketDef['default']> = {
    FLOAT: 0,
    INT: 0,
    BOOLEAN: false,
    VECTOR: [0, 0, 0],
    RGBA: [0, 0, 0, 1],
    ROTATION: [0, 0, 0],
    MATRIX: undefined,
  };
  return {
    name,
    identifier: id,
    type: t,
    default: d[t],
    shape: 'DIAMOND',
    ...(t === 'ROTATION' ? { subtype: 'EULER' } : {}),
  };
}

// Capture Attribute: items are stored on the node as JSON [{ id, name, data_type }]
export interface CaptureItem {
  id: number;
  name: string;
  data_type: string;
}
export const ITEM_SOCKET = '__item__';

export function captureItems(n: NodeData): CaptureItem[] {
  try {
    const v = JSON.parse(String(n.props.capture_items ?? '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export const captureIn = (it: CaptureItem) => (it.id === 0 ? 'Value' : `Value_${it.id}`);
export const captureOut = (it: CaptureItem) => (it.id === 0 ? 'Attribute' : `Attribute_${it.id}`);

gn(
  'GeometryNodeCaptureAttribute',
  'attribute',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const items = captureItems(ctx.node);
      const domain = sprop(ctx.node, 'domain') as Domain;
      const sel = ctx.field('Selection', 'BOOLEAN');
      const out: Record<string, Field | GeometrySet> = {};
      let geo = g;
      for (const it of items) {
        const t = fieldTypeOfEnum(it.data_type);
        const name = ctx.anon(captureOut(it));
        const f = ctx.field(captureIn(it), t);
        geo = geo.map((c) => storeOn(c, domain, name, t, f, sel));
        out[captureOut(it)] = attributeField(name, t);
      }
      out.Geometry = geo;
      return out;
    },
  },
  {
    drop: ['active_index'],
    items: { domain: ['POINT', 'EDGE', 'FACE', 'CORNER', 'CURVE', 'INSTANCE'] },
    dynamicSockets: (node) => {
      const items = captureItems(node);
      return {
        inputs: [
          { name: 'Geometry', identifier: 'Geometry', type: 'GEOMETRY' },
          {
            name: 'Selection',
            identifier: 'Selection',
            type: 'BOOLEAN',
            default: true,
            hide_value: true,
            shape: 'DIAMOND',
          },
          ...items.map((it) => valueSocket(captureIn(it), fieldTypeOfEnum(it.data_type), it.name)),
          {
            name: '',
            identifier: ITEM_SOCKET,
            type: 'CUSTOM',
            hide_value: true,
          },
        ],
        outputs: [
          { name: 'Geometry', identifier: 'Geometry', type: 'GEOMETRY' },
          ...items.map((it) => ({
            ...valueSocket(captureOut(it), fieldTypeOfEnum(it.data_type), it.name),
          })),
          { name: '', identifier: ITEM_SOCKET, type: 'CUSTOM' },
        ],
      };
    },
  },
);

gn(
  'GeometryNodeAttributeStatistic',
  'attribute',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const vec = sprop(ctx.node, 'data_type') === 'FLOAT_VECTOR';
      const domain = sprop(ctx.node, 'domain') as Domain;
      const f = ctx.field('Attribute', vec ? 'VECTOR' : 'FLOAT');
      const sel = ctx.field('Selection', 'BOOLEAN');
      const comps = vec ? 3 : 1;
      const values: number[][] = Array.from({ length: comps }, () => []);
      for (const c of g.components()) {
        if (!hasDomain(c, domain)) continue;
        const r = evalOn(c, domain, sel, [f]);
        const v = r.values[0];
        for (let i = 0; i < r.ctx.size; i++) if (!r.sel || r.sel[i]) for (let k = 0; k < comps; k++) values[k].push(v[i * comps + k]);
      }
      const stat = (arr: number[]) => {
        const n = arr.length;
        if (!n)
          return {
            mean: 0,
            median: 0,
            sum: 0,
            min: 0,
            max: 0,
            range: 0,
            std: 0,
            variance: 0,
          };
        let sum = 0,
          min = Infinity,
          max = -Infinity;
        for (const x of arr) {
          sum += x;
          if (x < min) min = x;
          if (x > max) max = x;
        }
        const mean = sum / n;
        let v = 0;
        for (const x of arr) v += (x - mean) ** 2;
        v /= n;
        const sorted = [...arr].sort((a, b) => a - b);
        const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        return {
          mean,
          median,
          sum,
          min,
          max,
          range: max - min,
          std: Math.sqrt(v),
          variance: v,
        };
      };
      const s = values.map(stat);
      const pick = (k: keyof ReturnType<typeof stat>) => (vec ? s.map((x) => x[k]) : s[0][k]);
      return {
        Mean: pick('mean'),
        Median: pick('median'),
        Sum: pick('sum'),
        Min: pick('min'),
        Max: pick('max'),
        Range: pick('range'),
        'Standard Deviation': pick('std'),
        Variance: pick('variance'),
      };
    },
  },
  {
    items: {
      data_type: ['FLOAT', 'FLOAT_VECTOR'],
      domain: ['POINT', 'EDGE', 'FACE', 'CORNER', 'CURVE', 'INSTANCE'],
    },
    dynamicSockets: (node) => {
      const t: FieldType = sprop(node, 'data_type') === 'FLOAT_VECTOR' ? 'VECTOR' : 'FLOAT';
      return {
        inputs: [
          { name: 'Geometry', identifier: 'Geometry', type: 'GEOMETRY' },
          {
            name: 'Selection',
            identifier: 'Selection',
            type: 'BOOLEAN',
            default: true,
            hide_value: true,
            shape: 'DIAMOND',
          },
          { ...valueSocket('Attribute', t), hide_value: true },
        ],
        outputs: ['Mean', 'Median', 'Sum', 'Min', 'Max', 'Range', 'Standard Deviation', 'Variance'].map((nm) => ({ name: nm, identifier: nm, type: t })),
      };
    },
  },
);

gn(
  'GeometryNodeSampleIndex',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const t = fieldTypeOfEnum(prop(ctx.node, 'data_type'));
      const domain = sprop(ctx.node, 'domain') as Domain;
      const valueF = ctx.field('Value', t);
      const indexF = ctx.field('Index', 'INT');
      const clamp = !!prop(ctx.node, 'clamp');
      const comp = g.components().find((c) => hasDomain(c, domain) && c.domainSize(domain) > 0);
      let src: ReturnType<typeof evalFull> | null = null;
      const comps = fieldComps(t);
      const field = new InputField(t, `sample:${ctx.path}`, (fc) => {
        if (!comp) return { data: allocDataF(t, 1), single: true };
        if (!src) src = evalFull(valueF, makeContext(comp, domain));
        const idx = evalFull(indexF, fc);
        const n = comp.domainSize(domain);
        const out = allocDataF(t, fc.size);
        for (let i = 0; i < fc.size; i++) {
          let j = idx[i];
          if (clamp) j = Math.max(0, Math.min(n - 1, j));
          if (j < 0 || j >= n) continue;
          for (let k = 0; k < comps; k++) out[i * comps + k] = src[j * comps + k];
        }
        return { data: out, single: false };
      });
      return { Value: field };
    },
  },
  {
    items: {
      data_type: ['FLOAT', 'INT', 'BOOLEAN', 'FLOAT_VECTOR', 'FLOAT_COLOR', 'QUATERNION'],
      domain: ['POINT', 'EDGE', 'FACE', 'CORNER', 'CURVE', 'INSTANCE'],
    },
    dynamicSockets: (node) => {
      const t = fieldTypeOfEnum(prop(node, 'data_type'));
      return {
        inputs: [
          { name: 'Geometry', identifier: 'Geometry', type: 'GEOMETRY' },
          { ...valueSocket('Value', t), hide_value: true },
          {
            name: 'Index',
            identifier: 'Index',
            type: 'INT',
            default: 0,
            shape: 'DIAMOND_DOT',
          },
        ],
        outputs: [{ ...valueSocket('Value', t) }],
      };
    },
  },
);

function allocDataF(t: FieldType, n: number) {
  return t === 'INT' ? new Int32Array(n) : t === 'BOOLEAN' ? new Uint8Array(n) : new Float32Array(n * fieldComps(t));
}
