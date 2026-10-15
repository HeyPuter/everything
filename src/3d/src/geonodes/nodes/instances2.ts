// Instance nodes: Geometry to Instance, Instances to Points and Split to Instances.
import { geoNode, sock, geo, selection, enumProp } from './gndef';
import { evalOn, hasDomain } from './common';
import { prop } from './defs';
import { GeometrySet, InstancesComponent, PointsComponent, allocData, dataComps, type InstanceReference, type Component } from '../geometry';
import { ConstField } from '../field';
import { attributeField, positionField } from '../inputs';
import { deleteCurves, deleteMesh, deletePoints } from '../ops/meshops';
import { joinGeometries } from '../ops/join';
import type { Domain } from '../types';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const keys = new WeakMap<GeometrySet, string>();
let counter = 0;
/** Stable reference key per geometry (instances of the same geometry share drawing data). */
export function geometryKey(g: GeometrySet): string {
  let k = keys.get(g);
  if (!k) keys.set(g, (k = `gi${++counter}`));
  return k;
}

/** Instances of geometries, one each, at the origin. */
export function instancesOf(list: GeometrySet[]): InstancesComponent {
  const n = list.length;
  const T = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) T.set(IDENTITY, i * 16);
  const refs: InstanceReference[] = list.map((g) => ({ type: 'GEOMETRY', geometry: g, key: geometryKey(g) }));
  return new InstancesComponent(
    T,
    Int32Array.from({ length: n }, (_, i) => i),
    refs,
  );
}

geoNode(
  {
    idname: 'GeometryNodeGeometryToInstance',
    label: 'Geometry to Instance',
    category: 'geometry',
    width: 160,
    description: 'Turn each connected geometry into one instance',
    inputs: [geo('Geometry', { multiInput: true })],
    outputs: [geo('Instances')],
  },
  {
    exec: (ctx) => {
      const list = ctx.geometries('Geometry');
      if (!list.length) return { Instances: GeometrySet.empty() };
      return { Instances: new GeometrySet(undefined, undefined, undefined, instancesOf(list)) };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeInstancesToPoints',
    label: 'Instances to Points',
    category: 'geometry',
    description: 'Create a point for every selected instance, keeping instance attributes',
    inputs: [
      geo('Instances'),
      selection(),
      sock('Position', 'VECTOR', { d: [0, 0, 0], hide_value: true, field: true }),
      sock('Radius', 'FLOAT', { d: 0.05, min: 0, field: true, subtype: 'DISTANCE' }),
    ],
    outputs: [geo('Points')],
  },
  {
    exec: (ctx) => {
      const inst = ctx.geometry('Instances').instances;
      if (!inst || !inst.count) return { Points: GeometrySet.empty() };
      const r = evalOn(inst, 'INSTANCE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Position', 'VECTOR'), ctx.field('Radius', 'FLOAT')]);
      const keep: number[] = [];
      for (let i = 0; i < inst.count; i++) if (!r.sel || r.sel[i]) keep.push(i);
      const pos = new Float32Array(keep.length * 3);
      const rad = new Float32Array(keep.length);
      keep.forEach((s, i) => {
        for (let k = 0; k < 3; k++) pos[i * 3 + k] = r.values[0][s * 3 + k];
        rad[i] = r.values[1][s];
      });
      const pc = new PointsComponent(pos);
      for (const [name, a] of inst.attrs) {
        if (name === 'radius' || name === 'position') continue;
        const comps = dataComps(a.type);
        const d = allocData(a.type, keep.length);
        keep.forEach((s, i) => {
          for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[s * comps + k];
        });
        pc.attrs.set(name, { domain: 'POINT', type: a.type, data: d });
      }
      pc.attrs.set('radius', { domain: 'POINT', type: 'FLOAT', data: rad });
      return { Points: new GeometrySet(undefined, pc) };
    },
    implicit: { Position: positionField },
  },
);

/** Elements of one group of a component as their own geometry. */
function subset(c: Component, domain: Domain, keep: Uint8Array): GeometrySet {
  const del = keep.map((k) => (k ? 0 : 1));
  if (c.kind === 'MESH') {
    const m = deleteMesh(c, domain, del, 'ALL');
    return m ? new GeometrySet(m) : GeometrySet.empty();
  }
  if (c.kind === 'POINTS') return new GeometrySet(undefined, deletePoints(c, del));
  if (c.kind === 'CURVES') return new GeometrySet(undefined, undefined, deleteCurves(c, domain, del));
  // instances
  const idx: number[] = [];
  for (let i = 0; i < c.count; i++) if (keep[i]) idx.push(i);
  const T = new Float32Array(idx.length * 16);
  idx.forEach((s, i) => T.set(c.transforms.subarray(s * 16, s * 16 + 16), i * 16));
  const out = new InstancesComponent(
    T,
    Int32Array.from(idx, (s) => c.refIndex[s]),
    c.references,
  );
  for (const [name, a] of c.attrs) {
    const comps = dataComps(a.type);
    const d = allocData(a.type, idx.length);
    idx.forEach((s, i) => {
      for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[s * comps + k];
    });
    out.attrs.set(name, { ...a, data: d });
  }
  return new GeometrySet(undefined, undefined, undefined, out);
}

geoNode(
  {
    idname: 'GeometryNodeSplitToInstances',
    label: 'Split to Instances',
    category: 'geometry',
    description: 'Separate elements into instances, one instance per group id',
    inputs: [geo('Geometry'), selection(), sock('Group ID', 'INT', { hide_value: true, field: true })],
    outputs: [geo('Instances'), sock('Group ID', 'INT', { field: true })],
    props: [
      enumProp('domain', 'Domain', [
        ['POINT', 'Point'],
        ['EDGE', 'Edge'],
        ['FACE', 'Face'],
        ['CURVE', 'Spline'],
        ['INSTANCE', 'Instance'],
      ]),
    ],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const domain = String(prop(ctx.node, 'domain')) as Domain;
      const selF = ctx.field('Selection', 'BOOLEAN'),
        gidF = ctx.field('Group ID', 'INT');
      const order: number[] = [];
      const parts = new Map<number, GeometrySet[]>();
      for (const c of g.components()) {
        if (!hasDomain(c, domain)) continue;
        const r = evalOn(c, domain, selF, [gidF]);
        const ids = r.values[0];
        const groups = new Map<number, Uint8Array>();
        for (let i = 0; i < r.ctx.size; i++) {
          if (r.sel && !r.sel[i]) continue;
          let k = groups.get(ids[i]);
          if (!k) groups.set(ids[i], (k = new Uint8Array(r.ctx.size)));
          k[i] = 1;
        }
        for (const [id, keep] of groups) {
          if (!parts.has(id)) (parts.set(id, []), order.push(id));
          parts.get(id)!.push(subset(c, domain, keep));
        }
      }
      if (!order.length) return { Instances: GeometrySet.empty(), 'Group ID': new ConstField('INT', 0) };
      const inst = instancesOf(order.map((id) => joinGeometries(parts.get(id)!)));
      const name = ctx.used('Group ID') ? ctx.anon('Group ID') : null;
      if (name) inst.attrs.set(name, { domain: 'INSTANCE', type: 'INT', data: Int32Array.from(order) });
      return { Instances: new GeometrySet(undefined, undefined, undefined, inst), 'Group ID': name ? attributeField(name, 'INT') : new ConstField('INT', 0) };
    },
  },
);
