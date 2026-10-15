// Grease Pencil nodes: Curves to Grease Pencil, Grease Pencil to Curves, Merge Layers, Set Grease
// Pencil Color / Depth / Softness, Named Layer Selection.
import { gn, prop, sprop } from './defs';
import { evalOn } from '../nodes/common';
import { CurvesComponent, GeometrySet, InstancesComponent, gatherArray, type Component, type InstanceReference } from '../geometry';
import { InputField, type Field } from '../field';
import { realizeInstances, joinCurves } from '../ops/join';
import { dataComps } from '../types';
import { pointFloats, setCurveAttr, setPointAttr } from './curvedata';
import { GreasePencilComponent, IDENTITY, layerCurvesInParent, layerNames, type GPLayerGeometry } from './gpdata';
import { place } from './menu';

// ---------------------------------------------------------------------------
// Layer domain: fields on layers are evaluated on a stand-in component with one element per layer

const layerProxies = new WeakMap<object, GreasePencilComponent>();

/** Evaluation component for fields on the layers of a Grease Pencil component. */
function layerDomain(gp: GreasePencilComponent): Component {
  const n = gp.layerCount;
  const proxy = new InstancesComponent(new Float32Array(n * 16), new Int32Array(n), []);
  for (let i = 0; i < n; i++) proxy.transforms.set(gp.layers[i].transform, i * 16);
  layerProxies.set(proxy, gp);
  return proxy;
}

function layerSelection(gp: GreasePencilComponent, sel: Field): Uint8Array | null {
  return evalOn(layerDomain(gp), 'INSTANCE', sel, []).sel;
}

gn('GeometryNodeInputNamedLayerSelection', 'input', {
  exec: (ctx) => {
    const name = ctx.string('Name');
    const f: Field = new InputField('BOOLEAN', `layer_named:${name}`, (fc) => {
      const gp = layerProxies.get(fc.comp);
      if (gp) return { data: Uint8Array.from(gp.layers, (l) => (l.name === name ? 1 : 0)), single: false };
      const ln = fc.comp.kind === 'CURVES' ? layerNames.get(fc.comp) : undefined;
      return { data: new Uint8Array([ln !== undefined && ln === name ? 1 : 0]), single: true };
    });
    return { Selection: f };
  },
});

/** Apply `fn` to every layer's strokes. */
function mapLayers(gp: GreasePencilComponent, fn: (c: CurvesComponent, l: GPLayerGeometry) => CurvesComponent): GreasePencilComponent {
  return gp.copy(gp.layers.map((l) => ({ ...l, curves: fn(l.curves, l) })));
}

const withGP = (g: GeometrySet, gp: GreasePencilComponent | undefined) => {
  const out = new GeometrySet(g.mesh, g.points, g.curves, g.instances);
  out.greasePencil = gp;
  return out;
};

// ---------------------------------------------------------------------------
// Conversion

export function curvesToGreasePencil(g: GeometrySet, sel: (c: Component, domain: 'CURVE' | 'INSTANCE') => Uint8Array | null, instancesAsLayers: boolean): GreasePencilComponent | undefined {
  const layers: GPLayerGeometry[] = [];
  if (instancesAsLayers) {
    const inst = g.instances;
    if (!inst) return undefined;
    const s = sel(inst, 'INSTANCE');
    for (let i = 0; i < inst.count; i++) {
      if (s && !s[i]) continue;
      const ref = inst.references[inst.refIndex[i]];
      const c = ref ? realizeInstances(ref.geometry).curves : undefined;
      if (!c) continue;
      layers.push({ name: '', curves: c, transform: Array.from(inst.transforms.subarray(i * 16, i * 16 + 16)), opacity: 1 });
    }
  } else {
    const c = realizeInstances(g).curves;
    if (!c) return undefined;
    const s = sel(c, 'CURVE');
    let curves = c;
    if (s && !s.every((x) => x)) {
      const keepC: number[] = [],
        keepP: number[] = [],
        offs = [0];
      for (let k = 0; k < c.curveCount; k++) {
        if (!s[k]) continue;
        keepC.push(k);
        for (let i = c.curveOffsets[k]; i < c.curveOffsets[k + 1]; i++) keepP.push(i);
        offs.push(keepP.length);
      }
      curves = new CurvesComponent(
        gatherArray(c.positions, 3, keepP) as Float32Array,
        Uint32Array.from(offs),
        Uint8Array.from(keepC, (k) => c.cyclic[k]),
        new Map(),
        c.materials,
      );
      for (const [name, a] of c.attrs) curves.attrs.set(name, { ...a, data: gatherArray(a.data, dataComps(a.type), a.domain === 'CURVE' ? keepC : keepP) });
    }
    layers.push({ name: '', curves, transform: IDENTITY.slice(), opacity: 1 });
  }
  return new GreasePencilComponent(layers, [...(g.curves?.materials ?? [])]);
}

gn('GeometryNodeCurvesToGreasePencil', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Curves');
    const selF = ctx.field('Selection', 'BOOLEAN');
    const gp = curvesToGreasePencil(g, (c, d) => evalOn(c, d, selF, []).sel, ctx.bool('Instances as Layers'));
    const out = new GeometrySet();
    out.greasePencil = gp;
    return { 'Grease Pencil': out };
  },
});

export function greasePencilToCurves(gp: GreasePencilComponent, sel: Uint8Array | null, asInstances: boolean): GeometrySet {
  const layers = gp.layers.filter((_, i) => !sel || sel[i]);
  if (asInstances) {
    const refs: InstanceReference[] = layers.map((l, i) => ({ type: 'GEOMETRY', geometry: new GeometrySet(undefined, undefined, l.curves), key: `gp-layer:${i}:${l.name}` }));
    const T = new Float32Array(layers.length * 16);
    layers.forEach((l, i) => T.set(l.transform, i * 16));
    const inst = new InstancesComponent(
      T,
      Int32Array.from(layers, (_, i) => i),
      refs,
    );
    inst.attrs.set('opacity', { domain: 'INSTANCE', type: 'FLOAT', data: Float32Array.from(layers, (l) => l.opacity) });
    return layers.length ? new GeometrySet(undefined, undefined, undefined, inst) : GeometrySet.empty();
  }
  const parts = layers.map((l) => {
    const c = layerCurvesInParent(l).copy();
    const op = new Float32Array(pointFloats(c, 'opacity', 1));
    for (let i = 0; i < op.length; i++) op[i] *= l.opacity;
    setPointAttr(c.attrs, 'opacity', 'FLOAT', op);
    return c;
  });
  const curves = parts.length ? joinCurves(parts) : undefined;
  return curves && curves.pointCount ? new GeometrySet(undefined, undefined, curves) : GeometrySet.empty();
}

gn('GeometryNodeGreasePencilToCurves', 'geometry', {
  exec: (ctx) => {
    const gp = ctx.geometry('Grease Pencil').greasePencil;
    if (!gp) return { Curves: GeometrySet.empty() };
    return { Curves: greasePencilToCurves(gp, layerSelection(gp, ctx.field('Selection', 'BOOLEAN')), ctx.bool('Layers as Instances')) };
  },
});

// ---------------------------------------------------------------------------
// Layers

export function mergeLayers(gp: GreasePencilComponent, sel: Uint8Array | null, keys: (string | number)[]): GreasePencilComponent {
  const groups = new Map<string | number, number[]>();
  const order: (number | number[])[] = [];
  gp.layers.forEach((_, i) => {
    if (sel && !sel[i]) {
      order.push(i);
      return;
    }
    let g = groups.get(keys[i]);
    if (!g) {
      groups.set(keys[i], (g = []));
      order.push(g);
    }
    g.push(i);
  });
  const layers: GPLayerGeometry[] = order.map((o) => {
    if (typeof o === 'number') return gp.layers[o];
    const first = gp.layers[o[0]];
    if (o.length === 1) return first;
    // strokes of the other layers move into the first layer's space
    const inv = invert4(first.transform);
    const parts = o.map((i) => {
      const l = gp.layers[i];
      return i === o[0] ? l.curves : layerCurvesInParent({ ...l, transform: mul4(inv, l.transform) });
    });
    return { ...first, curves: joinCurves(parts) };
  });
  return gp.copy(layers);
}

function mul4(a: number[], b: number[]): number[] {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += a[k * 4 + rr] * b[c * 4 + k];
  return r;
}

function invert4(m: number[]): number[] {
  // affine inverse (rotation/scale + translation)
  const a = m[0],
    b = m[4],
    c = m[8],
    d = m[1],
    e = m[5],
    f = m[9],
    g = m[2],
    h = m[6],
    i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!det) return IDENTITY.slice();
  const inv = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const t = [m[12], m[13], m[14]];
  const it = [-(inv[0] * t[0] + inv[1] * t[1] + inv[2] * t[2]), -(inv[3] * t[0] + inv[4] * t[1] + inv[5] * t[2]), -(inv[6] * t[0] + inv[7] * t[1] + inv[8] * t[2])];
  return [inv[0], inv[3], inv[6], 0, inv[1], inv[4], inv[7], 0, inv[2], inv[5], inv[8], 0, it[0], it[1], it[2], 1];
}

gn(
  'GeometryNodeMergeLayers',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Grease Pencil');
      const gp = g.greasePencil;
      if (!gp) return { 'Grease Pencil': g };
      const byId = sprop(ctx.node, 'mode') === 'MERGE_BY_ID';
      const dom = layerDomain(gp);
      const r = evalOn(dom, 'INSTANCE', ctx.field('Selection', 'BOOLEAN'), byId ? [ctx.field('Group ID', 'INT')] : []);
      const keys = byId ? Array.from(r.values[0] as Int32Array) : gp.layers.map((l) => l.name);
      return { 'Grease Pencil': withGP(g, mergeLayers(gp, r.sel, keys)) };
    },
  },
  {
    available: (n, s) => (s.identifier === 'Group ID' ? sprop(n, 'mode') === 'MERGE_BY_ID' : true),
  },
);

// ---------------------------------------------------------------------------
// Stroke settings

gn(
  'GeometryNodeSetGreasePencilColor',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Grease Pencil');
      const gp = g.greasePencil;
      if (!gp) return { 'Grease Pencil': g };
      const fill = sprop(ctx.node, 'mode') === 'FILL';
      const domain = fill ? 'CURVE' : 'POINT';
      const out = mapLayers(gp, (c) => {
        const r = evalOn(c, domain, ctx.field('Selection', 'BOOLEAN'), [ctx.field('Color', 'RGBA'), ctx.field('Opacity', 'FLOAT')]);
        const n = c.domainSize(domain);
        const colName = fill ? 'fill_color' : 'vertex_color',
          opName = fill ? 'fill_opacity' : 'opacity';
        const prevC = c.attrs.get(colName),
          prevO = c.attrs.get(opName);
        const col = prevC && prevC.domain === domain ? new Float32Array(prevC.data as Float32Array) : new Float32Array(n * 4);
        const op = prevO && prevO.domain === domain ? new Float32Array(prevO.data as Float32Array) : new Float32Array(n).fill(1);
        const cv = r.values[0] as Float32Array,
          ov = r.values[1] as Float32Array;
        for (let i = 0; i < n; i++) {
          if (r.sel && !r.sel[i]) continue;
          col.set(cv.subarray(i * 4, i * 4 + 4), i * 4);
          op[i] = ov[i];
        }
        const cc = c.copy();
        if (fill) {
          setCurveAttr(cc.attrs, colName, 'FLOAT_COLOR', col);
          setCurveAttr(cc.attrs, opName, 'FLOAT', op);
        } else {
          setPointAttr(cc.attrs, colName, 'FLOAT_COLOR', col);
          setPointAttr(cc.attrs, opName, 'FLOAT', op);
        }
        return cc;
      });
      return { 'Grease Pencil': withGP(g, out) };
    },
  },
  { propPatch: { mode: { expand: true } } },
);

gn(
  'GeometryNodeSetGreasePencilDepth',
  'geometry',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Grease Pencil');
      if (!g.greasePencil) return { 'Grease Pencil': g };
      const gp = g.greasePencil.copy();
      gp.depthOrder = String(prop(ctx.node, 'depth_order')) === '3D' ? '3D' : '2D';
      return { 'Grease Pencil': withGP(g, gp) };
    },
  },
  { propPatch: { depth_order: { expand: true } } },
);

gn('GeometryNodeSetGreasePencilSoftness', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Grease Pencil');
    const gp = g.greasePencil;
    if (!gp) return { 'Grease Pencil': g };
    const out = mapLayers(gp, (c) => {
      const r = evalOn(c, 'CURVE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Softness', 'FLOAT')]);
      const prev = c.attrs.get('softness');
      const data = prev && prev.domain === 'CURVE' ? new Float32Array(prev.data as Float32Array) : new Float32Array(c.curveCount);
      const v = r.values[0] as Float32Array;
      for (let k = 0; k < c.curveCount; k++) if (!r.sel || r.sel[k]) data[k] = v[k];
      const cc = c.copy();
      setCurveAttr(cc.attrs, 'softness', 'FLOAT', data);
      return cc;
    });
    return { 'Grease Pencil': withGP(g, out) };
  },
});

place('Grease Pencil/Read', 'GeometryNodeInputNamedLayerSelection');
place('Grease Pencil/Write', 'GeometryNodeSetGreasePencilColor');
place('Grease Pencil/Write', 'GeometryNodeSetGreasePencilDepth');
place('Grease Pencil/Write', 'GeometryNodeSetGreasePencilSoftness');
place('Grease Pencil/Operations', 'GeometryNodeGreasePencilToCurves');
place('Grease Pencil/Operations', 'GeometryNodeMergeLayers');
place('Curve/Operations', 'GeometryNodeCurvesToGreasePencil');
