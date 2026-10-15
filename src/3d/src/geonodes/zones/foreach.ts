// For Each Geometry Element zone: runs its body once per element of a domain. The body sees the
// element's index, the element as its own geometry and the values of the input fields there.
// Main items are single values per element, stored back on the input geometry; generation
// items are geometries (and fields on them) joined from all iterations.
import type { NodeData } from '../../data/types';
import { geoNode, sock, geo, selection, enumProp } from '../nodes/gndef';
import type { Val } from '../exec';
import { Field, ConstField, makeContext, evalFull, evalSelection, readScalar, type Scalar } from '../field';
import { GeometrySet, InstancesComponent, PointsComponent, type Component } from '../geometry';
import { coerce } from '../evaluator';
import { attributeField } from '../inputs';
import { storeOn } from '../nodes/geometry';
import { hasDomain } from '../nodes/common';
import { joinGeometries } from '../ops/join';
import { Rebuild } from '../ops/rebuild';
import { deleteCurves } from '../ops/meshops';
import { allocData, dataTypeOfField, fieldComps, fieldTypeOfEnum, type Domain, type FieldType } from '../types';
import { extendSocket, itemSocket, nextItemId, pairedInput, pairedOutput, readItems, writeItems, FIELD_ITEM_TYPES, type ZoneItem } from './items';
import { FOREACH_INPUT, FOREACH_OUTPUT } from './kinds';
import { ZoneEval, inputOf, single, zoneBody } from './eval';
import { addPairedOutput } from './repeat';

const inId = (it: ZoneItem) => `Input_${it.id}`;
const mainId = (it: ZoneItem) => `Main_${it.id}`;
const genId = (it: ZoneItem) => `Generation_${it.id}`;

export const FOREACH_DOMAINS: [string, string][] = [
  ['POINT', 'Point'],
  ['EDGE', 'Edge'],
  ['FACE', 'Face'],
  ['CORNER', 'Face Corner'],
  ['CURVE', 'Spline'],
  ['INSTANCE', 'Instance'],
];

const lists = (out: NodeData | undefined) => ({
  inputs: readItems(out, 'input_items'),
  main: readItems(out, 'main_items'),
  gen: readItems(out, 'generation_items'),
});

const domainOf = (out: NodeData | undefined): Domain => (String(out?.props.domain ?? 'POINT') as Domain) || 'POINT';

/** A single element of a component as its own geometry. */
export function elementGeometry(c: Component, domain: Domain, i: number): GeometrySet {
  if (c.kind === 'MESH') {
    const r = new Rebuild(c);
    if (domain === 'POINT') r.copyVert(i);
    else if (domain === 'EDGE') {
      const t = c.topology();
      const a = r.copyVert(t.edges[i * 2]),
        b = r.copyVert(t.edges[i * 2 + 1]);
      r.edge(a, b);
    } else if (domain === 'FACE') {
      const vs: number[] = [],
        cs: number[] = [];
      const map = new Map<number, number>();
      for (let k = c.faceOffsets[i]; k < c.faceOffsets[i + 1]; k++) {
        const v = c.corners[k];
        if (!map.has(v)) map.set(v, r.copyVert(v));
        vs.push(map.get(v)!);
        cs.push(k);
      }
      r.face(vs, cs, i);
    } else return GeometrySet.empty();
    return new GeometrySet(r.build());
  }
  if (c.kind === 'POINTS' || (c.kind === 'CURVES' && domain === 'POINT')) {
    const pos = c.positions.slice(i * 3, i * 3 + 3);
    const attrs = new Map();
    for (const [name, a] of c.attrs) {
      if (a.domain !== 'POINT') continue;
      const comps = a.data.length / c.domainSize('POINT');
      attrs.set(name, {
        ...a,
        data: a.data.slice(i * comps, i * comps + comps),
      });
    }
    return new GeometrySet(undefined, new PointsComponent(pos, attrs, [...c.materials]));
  }
  if (c.kind === 'CURVES' && domain === 'CURVE') {
    const del = new Uint8Array(c.curveCount).fill(1);
    del[i] = 0;
    return new GeometrySet(undefined, undefined, deleteCurves(c, 'CURVE', del));
  }
  if (c.kind === 'INSTANCES' && domain === 'INSTANCE') {
    const attrs = new Map();
    for (const [name, a] of c.attrs) {
      const comps = a.data.length / c.count;
      attrs.set(name, {
        ...a,
        data: a.data.slice(i * comps, i * comps + comps),
      });
    }
    return new GeometrySet(undefined, undefined, undefined, new InstancesComponent(c.transforms.slice(i * 16, i * 16 + 16), new Int32Array([c.refIndex[i]]), c.references, attrs));
  }
  return GeometrySet.empty();
}

/** Write per-element values (one entry per element, undefined = not run) as an attribute. */
function storeValues(c: Component, domain: Domain, name: string, t: FieldType, values: (Scalar | undefined)[]): Component {
  const n = values.length;
  const dt = dataTypeOfField(t);
  const data = allocData(dt, n);
  const comps = fieldComps(t);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === undefined) continue;
    if (comps === 1) data[i] = typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) ? (v[0] ?? 0) : v;
    else for (let k = 0; k < comps; k++) data[i * comps + k] = Array.isArray(v) ? (v[k] ?? (k === 3 ? 1 : 0)) : Number(v);
  }
  const out = c.copy();
  out.attrs.set(name, { domain, type: dt, data });
  return out;
}

geoNode(
  {
    idname: FOREACH_INPUT,
    label: 'For Each Geometry Element Input',
    category: 'converter',
    width: 140,
    description: 'Start of a for-each zone: the index, geometry and input field values of the current element',
    inputs: [geo('Geometry'), selection()],
    outputs: [sock('Index', 'INT')],
    dynamicSockets: (node, ctx) => {
      const out = pairedOutput(ctx.tree, node);
      const { inputs } = lists(out);
      const d = domainOf(out);
      return {
        inputs: [geo('Geometry'), selection(), ...inputs.map((it) => itemSocket(it, inId(it), { shape: 'DIAMOND', hide_value: false })), extendSocket()],
        outputs: [sock('Index', 'INT'), ...(d === 'CORNER' ? [] : [geo('Element')]), ...inputs.map((it) => itemSocket(it, inId(it), { shape: 'CIRCLE' })), extendSocket()],
      };
    },
    onAdd: (tree, n) =>
      addPairedOutput(tree, n, FOREACH_OUTPUT, (out) => {
        const g = readItems(out, 'generation_items').find((i) => i.socket_type === 'GEOMETRY');
        return g ? ['Element', genId(g)] : null;
      }),
  },
  {
    exec: (ctx) => {
      const out: Record<string, Val> = {
        Index: 0,
        Element: GeometrySet.empty(),
      };
      for (const it of lists(pairedOutput(ctx.tree, ctx.node)).inputs) out[inId(it)] = coerce(undefined, it.socket_type);
      return out;
    },
  },
);

geoNode(
  {
    idname: FOREACH_OUTPUT,
    label: 'For Each Geometry Element Output',
    category: 'converter',
    hidden: true,
    description: 'End of a for-each zone: per-element results stored on the input geometry, and joined generated geometry',
    props: [enumProp('domain', 'Domain', FOREACH_DOMAINS, 'POINT', { inNode: true })],
    init: (n) => {
      if (n.props.generation_items === undefined)
        writeItems(n, 'generation_items', [
          {
            id: nextItemId(n, ['generation_items']),
            name: 'Geometry',
            socket_type: 'GEOMETRY',
            domain: 'POINT',
          },
        ]);
    },
    dynamicSockets: (node) => {
      const { main, gen } = lists(node);
      return {
        inputs: [...main.map((it) => itemSocket(it, mainId(it))), extendSocket('__extend__main'), ...gen.map((it) => itemSocket(it, genId(it))), extendSocket('__extend__generation')],
        outputs: [
          geo('Geometry'),
          ...main.map((it) => itemSocket(it, mainId(it), { shape: 'DIAMOND' })),
          extendSocket('__extend__main'),
          ...gen.map((it) => itemSocket(it, genId(it), { shape: 'DIAMOND' })),
          extendSocket('__extend__generation'),
        ],
      };
    },
  },
  {
    exec: (ctx) => {
      const ev = ctx.evaluator;
      const node = ctx.node;
      const { inputs, main, gen } = lists(node);
      const domain = domainOf(node);
      const result: Record<string, Val> = {};
      const inp = pairedInput(ctx.tree, node, FOREACH_INPUT);
      if (!inp) {
        ctx.warn('The for-each output has no paired for-each input');
        return { Geometry: GeometrySet.empty() };
      }
      const g0 = inputOf(ev, inp, 'Geometry');
      const geometry = g0 instanceof GeometrySet ? g0 : GeometrySet.empty();
      const selV = inputOf(ev, inp, 'Selection');
      const selF = selV instanceof Field ? selV : new ConstField('BOOLEAN', selV === undefined ? true : !!selV);
      const inFields = inputs.map((it) => {
        const v = inputOf(ev, inp, inId(it));
        const t = fieldTypeOfEnum(it.socket_type) as FieldType;
        return FIELD_ITEM_TYPES.has(it.socket_type) ? (v instanceof Field ? v : new ConstField(t, (v ?? 0) as number)) : null;
      });
      const body = zoneBody(ctx.tree, inp.id, node.id);
      const wantElement = ev.isUsed(inp.id, 'Element');
      const genGeos: GeometrySet[][] = gen.map(() => []);
      const mainNames = main.map((it) => ctx.anon(mainId(it)));
      const genNames = gen.map((it) => ctx.anon(genId(it)));
      // per component of the input geometry that has the domain
      const outGeo = geometry.map((c) => {
        if (!hasDomain(c, domain)) return c;
        const fc = makeContext(c, domain);
        const n = fc.size;
        const sel = evalSelection(selF, fc);
        const vals = inFields.map((f) => (f ? evalFull(f, fc) : null));
        const mainVals: (Scalar | undefined)[][] = main.map(() => new Array(n).fill(undefined));
        for (let i = 0; i < n; i++) {
          if (sel && !sel[i]) continue;
          const ins: Record<string, Val> = { Index: i };
          if (domain !== 'CORNER' && wantElement) ins.Element = elementGeometry(c, domain, i);
          inputs.forEach((it, k) => {
            const arr = vals[k];
            ins[inId(it)] = arr ? (readScalar({ data: arr }, fieldTypeOfEnum(it.socket_type) as FieldType, i) as Val) : inputOf(ev, inp, inId(it));
          });
          const z = new ZoneEval(ev, body, inp.id, ins);
          main.forEach((it, k) => {
            const v = single(z.outputInput(node, mainId(it)));
            mainVals[k][i] = (v ?? 0) as Scalar;
          });
          // generation: geometries, then fields stored on the geometry item before them
          let lastGeo = -1;
          const iterGeos: (GeometrySet | null)[] = gen.map(() => null);
          gen.forEach((it, k) => {
            const v = z.outputInput(node, genId(it));
            if (it.socket_type === 'GEOMETRY') {
              iterGeos[k] = v instanceof GeometrySet ? v : GeometrySet.empty();
              lastGeo = k;
            } else if (lastGeo >= 0 && FIELD_ITEM_TYPES.has(it.socket_type)) {
              const t = fieldTypeOfEnum(it.socket_type) as FieldType;
              const f = v instanceof Field ? v : new ConstField(t, (v ?? 0) as number);
              const d = (it.domain ?? 'POINT') as Domain;
              iterGeos[lastGeo] = iterGeos[lastGeo]!.map((cc) => (hasDomain(cc, d) ? storeOn(cc, d, genNames[k], t, f) : cc));
            }
          });
          iterGeos.forEach((gg, k) => gg && genGeos[k].push(gg));
        }
        let cc: Component = c;
        main.forEach((it, k) => {
          if (!FIELD_ITEM_TYPES.has(it.socket_type)) return;
          cc = storeValues(cc, domain, mainNames[k], fieldTypeOfEnum(it.socket_type) as FieldType, mainVals[k]);
        });
        return cc;
      });
      result.Geometry = outGeo;
      main.forEach((it, k) => {
        result[mainId(it)] = FIELD_ITEM_TYPES.has(it.socket_type) ? attributeField(mainNames[k], fieldTypeOfEnum(it.socket_type) as FieldType) : coerce(undefined, it.socket_type);
      });
      gen.forEach((it, k) => {
        if (it.socket_type === 'GEOMETRY') result[genId(it)] = joinGeometries(genGeos[k]);
        else if (FIELD_ITEM_TYPES.has(it.socket_type)) result[genId(it)] = attributeField(genNames[k], fieldTypeOfEnum(it.socket_type) as FieldType);
        else result[genId(it)] = coerce(undefined, it.socket_type);
      });
      return result;
    },
  },
);
