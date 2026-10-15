// Further input nodes: data-block constants (Object, Collection, Material, Image, Font), instance
// attributes (rotation, scale, transform, reference, bounds), Curve Handle Positions, Material
// Selection, and the Set ID / Set Instance Transform writers.
import './fdata';
import { gn, prop } from './defs';
import { h } from '../../ui/h';
import { enumMenu } from '../../ui/widgets';
import { app } from '../../app/app';
import { Field, InputField, allocField, evalFull, matrixToEuler, type Evaluated, type FieldContext } from '../field';
import { adaptDomain, geometryBounds, readAttribute, type Component, type InstancesComponent } from '../geometry';
import { idField, positionField } from '../inputs';
import { evalOn, pointDomainOf } from './common';
import { curveTypes, CT } from '../curves/curvedata';
import type { FieldType } from '../types';

const zeros = (type: FieldType): Evaluated => ({ data: allocField(type, 1), single: true });
const full = (data: Float32Array | Int32Array | Uint8Array): Evaluated => ({ data, single: false });

// ---------------------------------------------------------------------------
// Data-block constants

for (const [idname, out, propId] of [
  ['GeometryNodeInputObject', 'Object', 'object'],
  ['GeometryNodeInputCollection', 'Collection', 'collection'],
  ['GeometryNodeInputMaterial', 'Material', 'material'],
  ['GeometryNodeInputImage', 'Image', 'image'],
] as const) {
  gn(
    idname,
    'input',
    {
      exec: (ctx) => {
        const v = prop(ctx.node, propId);
        return { [out]: typeof v === 'string' && v ? v : null };
      },
    },
    { propPatch: { [propId]: { noLabel: true } } },
  );
}

// ---------------------------------------------------------------------------
// Instances

/** Field read from the instance transforms (zero for other components). */
function instanceField(type: FieldType, key: string, fn: (c: InstancesComponent, i: number, out: Float32Array | Int32Array, o: number) => void): Field {
  const comps = type === 'MATRIX' ? 16 : type === 'INT' ? 1 : 3;
  return new InputField(type, key, (ctx: FieldContext) => {
    const c = ctx.comp;
    if (c.kind !== 'INSTANCES' || ctx.domain !== 'INSTANCE') return zeros(type);
    const out = allocField(type, c.count) as Float32Array | Int32Array;
    for (let i = 0; i < c.count; i++) fn(c, i, out, i * comps);
    return full(out);
  });
}

export const instanceTransformField = () => instanceField('MATRIX', 'instance_transform', (c, i, out, o) => out.set(c.transforms.subarray(i * 16, i * 16 + 16), o));

gn('GeometryNodeInstanceTransform', 'input', { exec: () => ({ Transform: instanceTransformField() }) });

/** Scale of a column-major transform: column lengths, all negated when the matrix mirrors. */
export function signedScale(t: ArrayLike<number>, b: number): [number, number, number] {
  const sx = Math.hypot(t[b], t[b + 1], t[b + 2]),
    sy = Math.hypot(t[b + 4], t[b + 5], t[b + 6]),
    sz = Math.hypot(t[b + 8], t[b + 9], t[b + 10]);
  const det = t[b] * (t[b + 5] * t[b + 10] - t[b + 6] * t[b + 9]) - t[b + 4] * (t[b + 1] * t[b + 10] - t[b + 2] * t[b + 9]) + t[b + 8] * (t[b + 1] * t[b + 6] - t[b + 2] * t[b + 5]);
  return det < 0 ? [-sx, -sy, -sz] : [sx, sy, sz];
}

gn('GeometryNodeInputInstanceRotation', 'input', {
  exec: () => ({
    Rotation: instanceField('ROTATION', 'instance_rotation', (c, i, out, o) => {
      const t = c.transforms,
        b = i * 16;
      const s = signedScale(t, b);
      const m = [
        t[b] / (s[0] || 1),
        t[b + 1] / (s[0] || 1),
        t[b + 2] / (s[0] || 1),
        0,
        t[b + 4] / (s[1] || 1),
        t[b + 5] / (s[1] || 1),
        t[b + 6] / (s[1] || 1),
        0,
        t[b + 8] / (s[2] || 1),
        t[b + 9] / (s[2] || 1),
        t[b + 10] / (s[2] || 1),
      ];
      matrixToEuler(m, 0, out, o);
    }),
  }),
});

gn('GeometryNodeInputInstanceScale', 'input', {
  exec: () => ({ Scale: instanceField('VECTOR', 'instance_scale', (c, i, out, o) => out.set(signedScale(c.transforms, i * 16), o)) }),
});

gn('GeometryNodeInputInstanceReference', 'input', {
  exec: () => ({ 'Reference Index': instanceField('INT', 'instance_reference', (c, i, out, o) => (out[o] = c.refIndex[i])) }),
});

gn('GeometryNodeInputInstanceBounds', 'input', {
  exec: (ctx) => {
    const useRadius = ctx.bool('Use Radius');
    const bounds = (c: InstancesComponent) => c.references.map((r) => geometryBounds(r.geometry, useRadius));
    const cache = new WeakMap<InstancesComponent, ReturnType<typeof bounds>>();
    const get = (c: InstancesComponent) => {
      let b = cache.get(c);
      if (!b) cache.set(c, (b = bounds(c)));
      return b;
    };
    const side = (max: boolean) =>
      instanceField('VECTOR', `instance_bounds:${max}:${useRadius}`, (c, i, out, o) => {
        const b = get(c)[c.refIndex[i]];
        if (!b) return;
        const v = max ? b.max : b.min;
        out[o] = v[0];
        out[o + 1] = v[1];
        out[o + 2] = v[2];
      });
    return { Min: side(false), Max: side(true) };
  },
});

gn('GeometryNodeSetInstanceTransform', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Instances');
    const inst = g.instances;
    if (!inst) return { Instances: g };
    const r = evalOn(inst, 'INSTANCE', ctx.field('Selection', 'BOOLEAN'), [ctx.field('Transform', 'MATRIX')]);
    const T = new Float32Array(inst.transforms);
    const m = r.values[0];
    for (let i = 0; i < inst.count; i++) if (!r.sel || r.sel[i]) T.set(m.subarray(i * 16, i * 16 + 16), i * 16);
    const out = inst.copy();
    out.transforms = T;
    return { Instances: g.with(out) };
  },
  implicit: { Transform: instanceTransformField },
});

// ---------------------------------------------------------------------------
// Set ID

gn('GeometryNodeSetID', 'geometry', {
  exec: (ctx) => {
    const g = ctx.geometry('Geometry');
    const sel = ctx.field('Selection', 'BOOLEAN'),
      id = ctx.field('ID', 'INT');
    return {
      Geometry: g.map((c) => {
        const dom = pointDomainOf(c);
        const r = evalOn(c, dom, sel, [id]);
        const n = r.ctx.size;
        if (!n) return c;
        const prev = readAttribute(c, 'id', dom);
        const data = new Int32Array(n);
        // a new ID attribute starts at zero for unselected elements
        if (prev && prev.type === 'INT') data.set(prev.data.subarray(0, n) as Int32Array);
        const v = r.values[0];
        for (let i = 0; i < n; i++) if (!r.sel || r.sel[i]) data[i] = v[i];
        const out = c.copy() as Component;
        out.attrs.set('id', { domain: dom, type: 'INT', data });
        return out;
      }),
    };
  },
  implicit: { ID: idField },
});

// ---------------------------------------------------------------------------
// Curves

gn('GeometryNodeInputCurveHandlePositions', 'input', {
  exec: (ctx) => {
    const relative = ctx.field('Relative', 'BOOLEAN');
    const pos = positionField();
    const side = (name: string) =>
      new (class extends Field {
        protected compute(c: FieldContext): Evaluated {
          if (c.comp.kind !== 'CURVES') return zeros('VECTOR');
          const P = evalFull(pos, c);
          const comp = c.comp;
          const a = readAttribute(comp, name, 'POINT');
          // handles exist on Bézier curves only; other curves report zero handle positions
          const hp = new Float32Array(comp.pointCount * 3);
          if (a) {
            const types = curveTypes(comp);
            for (let k = 0; k < comp.curveCount; k++) {
              if (!types || types[k] !== CT.BEZIER) continue;
              for (let i = comp.curveOffsets[k]; i < comp.curveOffsets[k + 1]; i++) for (let q = 0; q < 3; q++) hp[i * 3 + q] = a.data[i * 3 + q];
            }
          }
          const h = c.domain === 'POINT' ? hp : (adaptDomain(comp, hp, 'FLOAT_VECTOR', 'POINT', c.domain) as Float32Array);
          const rel = evalFull(relative, c);
          const out = new Float32Array(c.size * 3);
          for (let i = 0; i < c.size; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = h[i * 3 + k] - (rel[i] ? P[i * 3 + k] : 0);
          return full(out);
        }
      })('VECTOR');
    return { Left: side('handle_left'), Right: side('handle_right') };
  },
});

// ---------------------------------------------------------------------------
// Material selection

gn('GeometryNodeMaterialSelection', 'input', {
  exec: (ctx) => {
    const mat = ctx.idRef('Material');
    return {
      Selection: new InputField('BOOLEAN', `material_selection:${mat}`, (c) => {
        const comp = c.comp;
        if (comp.kind === 'INSTANCES') return zeros('BOOLEAN');
        const dom = comp.kind === 'MESH' ? 'FACE' : comp.kind === 'CURVES' ? 'CURVE' : 'POINT';
        const slots = comp.materials;
        const n = comp.domainSize(dom);
        const idx = comp.attrs.get('material_index');
        const sel = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const k = idx && idx.domain === dom ? idx.data[i] : 0;
          sel[i] = (slots[k] ?? null) === mat && (slots.length > 0 || mat === null) ? 1 : 0;
        }
        return full(dom === c.domain ? sel : adaptDomain(comp, sel, 'BOOLEAN', dom, c.domain));
      }),
    };
  },
});

// ---------------------------------------------------------------------------
// Font

gn(
  'GeometryNodeInputFont',
  'input',
  {
    exec: (ctx) => {
      const v = ctx.node.props.font;
      return { Font: typeof v === 'string' && v && ctx.env.doc.fonts?.[v] ? v : null };
    },
  },
  {
    drop: ['font'],
    drawBody: (ctx) => {
      const fonts = Object.values(app.doc.fonts ?? {});
      const cur = typeof ctx.node.props.font === 'string' ? ctx.node.props.font : '';
      return h(
        'div',
        { class: 'gn-id-rows' },
        enumMenu(
          `${ctx.key}:font`,
          [{ value: '', label: '—' }, ...fonts.map((f) => ({ value: f.id, label: f.name, icon: 'outliner_ob_font' }))],
          cur,
          (v) => {
            ctx.node.props.font = v || null;
            ctx.changed('Set Font', true);
          },
          { title: 'Font' },
        ),
      );
    },
    bodyHeight: () => 26,
  },
);
