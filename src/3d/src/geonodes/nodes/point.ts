// Point and instancing nodes.
import { gn, sprop } from './defs';
import { evalOn } from './common';
import { GeometrySet, type InstanceReference, type Component } from '../geometry';
import { distributePoisson, distributeRandom, buildDistributed, instanceOnPoints } from '../ops/points';
import { pointsToVertices } from '../ops/meshops';
import { joinInstances } from '../ops/join';
import { attributeField, idField } from '../inputs';
import { ConstField } from '../field';

gn(
  'GeometryNodeDistributePointsOnFaces',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Mesh');
      const m = g.mesh;
      const none = {
        Points: GeometrySet.empty(),
        Normal: new ConstField('VECTOR', [0, 0, 0]),
        Rotation: new ConstField('ROTATION', [0, 0, 0]),
      };
      if (!m || !m.faceCount) return none;
      const seed = ctx.int('Seed');
      const sel = evalOn(m, 'FACE', ctx.field('Selection', 'BOOLEAN'), []).sel;
      let samples;
      if (sprop(ctx.node, 'distribute_method') === 'POISSON') {
        const factor = evalOn(m, 'CORNER', undefined, [ctx.field('Density Factor', 'FLOAT')]).values[0] as Float32Array;
        samples = distributePoisson(m, sel, Math.max(0, ctx.float('Distance Min')), Math.max(0, ctx.float('Density Max')), factor, seed);
      } else {
        const dens = evalOn(m, 'CORNER', undefined, [ctx.field('Density', 'FLOAT')]).values[0] as Float32Array;
        samples = distributeRandom(m, sel, dens, seed);
      }
      const res = buildDistributed(m, samples, seed);
      const out: Record<string, unknown> = {};
      for (const [k, data, t] of [
        ['Normal', res.normal, 'VECTOR'],
        ['Rotation', res.rotation, 'ROTATION'],
      ] as const) {
        if (!ctx.used(k)) {
          out[k] = new ConstField(t, [0, 0, 0]);
          continue;
        }
        const name = ctx.anon(k);
        res.points.attrs.set(name, {
          domain: 'POINT',
          type: t === 'ROTATION' ? 'QUATERNION' : 'FLOAT_VECTOR',
          data,
        });
        out[k] = attributeField(name, t);
      }
      out.Points = new GeometrySet(undefined, res.points);
      return out as Record<string, never>;
    },
  },
  {
    drop: ['use_legacy_normal'],
    available: (n, s, out) => {
      if (out) return true;
      const poisson = sprop(n, 'distribute_method') === 'POISSON';
      if (s.identifier === 'Distance Min' || s.identifier === 'Density Max' || s.identifier === 'Density Factor') return poisson;
      if (s.identifier === 'Density') return !poisson;
      return true;
    },
  },
);

gn('GeometryNodePointsToVertices', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Points');
    const p = g.points;
    if (!p) return { Mesh: GeometrySet.empty() };
    return {
      Mesh: new GeometrySet(pointsToVertices(p, evalOn(p, 'POINT', ctx.field('Selection', 'BOOLEAN'), []).sel)),
    };
  },
});

gn('GeometryNodeSetPointRadius', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Points');
    const p = g.points;
    if (!p) return { Points: g };
    const r = evalOn(p, 'POINT', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Radius', 'FLOAT')]);
    const prev = p.attrs.get('radius');
    const data = new Float32Array(p.count);
    if (prev) data.set(prev.data as Float32Array);
    else data.fill(0.01);
    for (let i = 0; i < p.count; i++) if (!r.sel || r.sel[i]) data[i] = r.values[0][i];
    const out = p.copy();
    out.attrs.set('radius', { domain: 'POINT', type: 'FLOAT', data });
    return { Points: g.with(out) };
  },
});

/** Stable key of a geometry used as an instance reference (for render batching). */
const refKeys = new WeakMap<GeometrySet, string>();
let refCounter = 0;
function refKey(g: GeometrySet) {
  let k = refKeys.get(g);
  if (!k) {
    k = `g${++refCounter}`;
    refKeys.set(g, k);
  }
  return k;
}

gn(
  'GeometryNodeInstanceOnPoints',
  'geometry',
  {
    exec: (ctx) => {
      const pts = ctx.geometry('Points');
      const inst = ctx.geometry('Instance');
      const pick = ctx.bool('Pick Instance') && !!inst.instances?.count;
      let refs: InstanceReference[];
      if (pick) refs = inst.instances!.references.length ? inst.instances!.references : [];
      else refs = inst.isEmpty() ? [] : [{ type: 'GEOMETRY', geometry: inst, key: refKey(inst) }];
      const sources: Component[] = [];
      if (pts.mesh) sources.push(pts.mesh);
      if (pts.points) sources.push(pts.points);
      if (pts.curves) sources.push(pts.curves);
      if (pts.instances) sources.push(pts.instances);
      const out: GeometrySet[] = [];
      for (const c of sources) {
        const domain = c.kind === 'INSTANCES' ? 'INSTANCE' : 'POINT';
        const r = evalOn(c, domain, ctx.field('Selection', 'BOOLEAN'), [ctx.field('Rotation', 'ROTATION'), ctx.field('Scale', 'VECTOR'), ctx.field('Instance Index', 'INT')]);
        if (!r.ctx.size || !refs.length) continue;
        let positions: Float32Array;
        if (c.kind === 'INSTANCES') {
          positions = new Float32Array(c.count * 3);
          for (let i = 0; i < c.count; i++) positions.set(c.transforms.subarray(i * 16 + 12, i * 16 + 15), i * 3);
        } else positions = c.positions;
        const idx = r.values[2];
        const pickRef = pick ? inst.instances!.refIndex : null;
        const picked = (i: number) => ((idx[i] % pickRef!.length) + pickRef!.length) % pickRef!.length;
        const comp = instanceOnPoints(
          positions,
          c.attrs,
          r.sel,
          refs,
          (i) => (pickRef ? pickRef[picked(i)] : 0),
          r.values[0] as Float32Array,
          r.values[1] as Float32Array,
          pickRef ? (i) => inst.instances!.transforms.subarray(picked(i) * 16, picked(i) * 16 + 16) : undefined,
        );
        out.push(new GeometrySet(undefined, undefined, undefined, comp));
      }
      if (!out.length) return { Instances: GeometrySet.empty() };
      if (out.length === 1) return { Instances: out[0] };
      // several point sources: merge their instances (and the attributes they carry)
      return {
        Instances: new GeometrySet(undefined, undefined, undefined, joinInstances(out.map((g) => g.instances!))),
      };
    },
    implicit: { 'Instance Index': idField },
  },
  {
    available: (n, s) => (s.identifier === 'Instance Index' ? true : !s.disabled),
  },
);
