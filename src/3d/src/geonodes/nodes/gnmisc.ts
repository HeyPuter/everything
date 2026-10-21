// Geometry utility nodes: Replace Material, Get Geometry Component, Set Geometry Name, Get / Set
// Geometry Bundle, Get Attribute Names, Collection Children, Split String, Tag Filter, Enable
// Output and Implicit Conversion.
import { geoNode, sock, geo, enumProp } from './gndef';
import { idSocketBody } from './defs';
import type { NodeData } from '../../data/types';
import type { SocketDef, SocketType } from '../../nodes/types';
import type { Val } from '../exec';
import { coerce } from '../evaluator';
import { GeometrySet, isInternal, type Component } from '../geometry';
import { ListValue } from '../bundles/lists';
import { BundleValue } from '../bundles/values';
import { ITEM_TYPES, itemSocket } from '../zones/items';

// ---------------------------------------------------------------------------
// Replace Material

function replaceIn(g: GeometrySet, from: string | null, to: string | null, depth = 0): GeometrySet {
  const swap = (list: (string | null)[]) => list.map((m) => (m === from ? to : m));
  const out = g.map((c) => {
    if (c.kind === 'INSTANCES') {
      if (depth > 16) return c;
      const n = c.copy();
      n.references = c.references.map((r) => ({ ...r, geometry: replaceIn(r.geometry, from, to, depth + 1), key: `${r.key}|rm:${from}>${to}` }));
      return n;
    }
    if (!c.materials.includes(from)) return c;
    const n = c.copy();
    n.materials = swap(c.materials);
    return n;
  });
  if (g.greasePencil?.materials.includes(from)) {
    const gp = Object.assign(Object.create(Object.getPrototypeOf(g.greasePencil)), g.greasePencil);
    gp.materials = swap(g.greasePencil.materials);
    out.greasePencil = gp;
  }
  return out;
}

const matSocks = [sock('Old', 'MATERIAL', { hide_value: true }), sock('New', 'MATERIAL', { hide_value: true })];
geoNode(
  {
    idname: 'GeometryNodeReplaceMaterial',
    label: 'Replace Material',
    category: 'geometry',
    description: 'Swap one material with another',
    inputs: [geo('Geometry'), ...matSocks],
    outputs: [geo('Geometry')],
    drawBody: (ctx) => idSocketBody(ctx, matSocks.filter((s) => !ctx.tree.links.some((l) => l.to_node === ctx.node.id && l.to_socket === s.identifier))),
    bodyHeight: () => 50,
  },
  {
    exec: (ctx) => ({ Geometry: replaceIn(ctx.geometry('Geometry'), ctx.idRef('Old'), ctx.idRef('New')) }),
  },
);

// ---------------------------------------------------------------------------
// Get Geometry Component

const COMPONENT_ITEMS: [string, string][] = [
  ['Mesh', 'Mesh'],
  ['Curve', 'Curve'],
  ['Point Cloud', 'Point Cloud'],
  ['Instances', 'Instances'],
  ['Volume', 'Volume'],
  ['Grease Pencil', 'Grease Pencil'],
];

/** Split a geometry into the chosen component and the rest. */
export function splitComponent(g: GeometrySet, type: string): { component: GeometrySet; rest: GeometrySet; exists: boolean } {
  const only = new GeometrySet();
  const rest = g.clone();
  let exists = false;
  switch (type) {
    case 'Mesh':
      exists = !!g.mesh;
      only.mesh = g.mesh;
      rest.mesh = undefined;
      break;
    case 'Curve':
      exists = !!g.curves;
      only.curves = g.curves;
      rest.curves = undefined;
      break;
    case 'Point Cloud':
      exists = !!g.points;
      only.points = g.points;
      rest.points = undefined;
      break;
    case 'Instances':
      exists = !!g.instances;
      only.instances = g.instances;
      rest.instances = undefined;
      break;
    case 'Volume':
      exists = !!g.volume?.grids.length;
      only.volume = g.volume;
      rest.volume = undefined;
      break;
    case 'Grease Pencil':
      exists = !!g.greasePencil;
      only.greasePencil = g.greasePencil;
      rest.greasePencil = undefined;
      break;
  }
  return { component: only, rest, exists };
}

geoNode(
  {
    idname: 'GeometryNodeGetGeometryComponent',
    label: 'Get Geometry Component',
    category: 'geometry',
    width: 180,
    description: 'Take one component out of a geometry',
    inputs: [geo('Geometry'), sock('Remove', 'BOOLEAN', { d: true })],
    outputs: [geo('Geometry'), geo('Component'), sock('Exists', 'BOOLEAN')],
    props: [enumProp('Type', 'Type', COMPONENT_ITEMS)],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const r = splitComponent(g, String(ctx.prop('Type') ?? 'Mesh'));
      return { Geometry: ctx.bool('Remove') ? r.rest : g, Component: r.component, Exists: r.exists };
    },
  },
);

// ---------------------------------------------------------------------------
// Geometry name and bundle

geoNode(
  {
    idname: 'GeometryNodeSetGeometryName',
    label: 'Set Geometry Name',
    category: 'geometry',
    description: 'Give the geometry a name (shown for instances in the spreadsheet)',
    inputs: [geo('Geometry'), sock('Name', 'STRING', { d: '' })],
    outputs: [geo('Geometry')],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry').clone();
      g.name = ctx.string('Name');
      return { Geometry: g };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeGetGeometryBundle',
    label: 'Get Geometry Bundle',
    category: 'geometry',
    width: 160,
    description: 'Read the bundle attached to a geometry',
    inputs: [geo('Geometry'), sock('Remove', 'BOOLEAN', { d: false })],
    outputs: [geo('Geometry'), sock('Bundle', 'BUNDLE', { shape: 'DIAMOND' })],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const bundle = g.bundle ?? new BundleValue();
      if (!ctx.bool('Remove') || !g.bundle) return { Geometry: g, Bundle: bundle };
      const out = g.clone();
      out.bundle = undefined;
      return { Geometry: out, Bundle: bundle };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeSetGeometryBundle',
    label: 'Set Geometry Bundle',
    category: 'geometry',
    width: 160,
    description: 'Attach a bundle of values to a geometry',
    inputs: [geo('Geometry'), sock('Bundle', 'BUNDLE', { hide_value: true })],
    outputs: [geo('Geometry')],
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry').clone();
      const b = ctx.input('Bundle');
      g.bundle = b instanceof BundleValue ? b : undefined;
      return { Geometry: g };
    },
  },
);

// ---------------------------------------------------------------------------
// Get Attribute Names

const DATA_TYPE_ITEMS: [string, string, string][] = [
  ['Float', 'Float', 'FLOAT'],
  ['Integer', 'Integer', 'INT'],
  ['Boolean', 'Boolean', 'BOOLEAN'],
  ['Vector', 'Vector', 'FLOAT_VECTOR'],
  ['Color', 'Color', 'FLOAT_COLOR'],
  ['String', 'String', 'STRING'],
  ['Byte Color', 'Byte Color', 'BYTE_COLOR'],
  ['2D Vector', '2D Vector', 'FLOAT2'],
  ['Quaternion', 'Quaternion', 'QUATERNION'],
  ['8-Bit Integer', '8-Bit Integer', 'INT8'],
];
const DOMAIN_MENU: [string, string, string][] = [
  ['Point', 'Point', 'POINT'],
  ['Edge', 'Edge', 'EDGE'],
  ['Face', 'Face', 'FACE'],
  ['Face Corner', 'Face Corner', 'CORNER'],
  ['Spline', 'Spline', 'CURVE'],
  ['Instance', 'Instance', 'INSTANCE'],
  ['Layer', 'Layer', 'LAYER'],
];

/** Names of the (non-internal) attributes of a geometry, optionally filtered. */
export function attributeNames(g: GeometrySet, dataType: string | null, domain: string | null): string[] {
  const names: string[] = [];
  const add = (n: string) => !names.includes(n) && names.push(n);
  const visit = (c: Component) => {
    if (c.kind !== 'INSTANCES' && (!dataType || dataType === 'FLOAT_VECTOR') && (!domain || domain === 'POINT')) add('position');
    for (const [name, a] of c.attrs) {
      if (isInternal(name)) continue;
      if (dataType && a.type !== dataType) continue;
      if (domain && a.domain !== domain) continue;
      add(name);
    }
  };
  for (const c of g.components()) visit(c);
  return names;
}

geoNode(
  {
    idname: 'GeometryNodeGetAttributeNames',
    label: 'Get Attribute Names',
    category: 'attribute',
    width: 160,
    description: 'List the names of the attributes a geometry has',
    inputs: [geo('Geometry'), sock('Filter Data Type', 'BOOLEAN', { d: false }), sock('Filter Domain', 'BOOLEAN', { d: false })],
    outputs: [sock('Names', 'STRING', { shape: 'SQUARE' })],
    props: [
      enumProp(
        'Data Type',
        'Data Type',
        DATA_TYPE_ITEMS.map(([v, l]) => [v, l]),
        'Float',
        { visible: (n) => !!n.inputs['Filter Data Type'] },
      ),
      enumProp(
        'Domain',
        'Domain',
        DOMAIN_MENU.map(([v, l]) => [v, l]),
        'Point',
        { visible: (n) => !!n.inputs['Filter Domain'] },
      ),
    ],
  },
  {
    exec: (ctx) => {
      const dt = ctx.bool('Filter Data Type') ? (DATA_TYPE_ITEMS.find(([v]) => v === ctx.prop('Data Type'))?.[2] ?? 'FLOAT') : null;
      const dom = ctx.bool('Filter Domain') ? (DOMAIN_MENU.find(([v]) => v === ctx.prop('Domain'))?.[2] ?? 'POINT') : null;
      return { Names: new ListValue('STRING', attributeNames(ctx.geometry('Geometry'), dt, dom)) };
    },
  },
);

// ---------------------------------------------------------------------------
// Collection Children

const colSock = sock('Collection', 'COLLECTION', { hide_value: true });
geoNode(
  {
    idname: 'GeometryNodeCollectionChildren',
    label: 'Collection Children',
    category: 'input',
    description: 'List the child collections and objects of a collection',
    inputs: [colSock, sock('Recursive', 'BOOLEAN', { d: false })],
    outputs: [sock('Collections', 'COLLECTION', { shape: 'SQUARE' }), sock('Objects', 'OBJECT', { shape: 'SQUARE' })],
    drawBody: (ctx) => idSocketBody(ctx, ctx.tree.links.some((l) => l.to_node === ctx.node.id && l.to_socket === 'Collection') ? [] : [colSock]),
    bodyHeight: () => 26,
  },
  {
    exec: (ctx) => {
      const doc = ctx.env.doc;
      const id = ctx.idRef('Collection');
      const recursive = ctx.bool('Recursive');
      const cols: string[] = [],
        obs: string[] = [];
      const seen = new Set<string>();
      const walk = (cid: string, depth: number) => {
        const c = doc.collections[cid];
        if (!c || seen.has(cid) || depth > 64) return;
        seen.add(cid);
        for (const o of c.objects) if (doc.objects[o] && !obs.includes(o)) obs.push(o);
        for (const ch of c.children) {
          if (!doc.collections[ch]) continue;
          cols.push(ch);
          if (recursive) walk(ch, depth + 1);
        }
      };
      if (id) walk(id, 0);
      return { Collections: new ListValue('COLLECTION', cols), Objects: new ListValue('OBJECT', obs) };
    },
    deps: (n, doc) => {
      const id = n.inputs.Collection as string | null;
      return id && doc.collections[id] ? [...doc.collections[id].objects] : [];
    },
  },
);

// ---------------------------------------------------------------------------
// Split String / Tag Filter

geoNode(
  {
    idname: 'FunctionNodeSplitString',
    label: 'Split String',
    category: 'converter',
    description: 'Split a string into a list at every occurrence of the separator',
    inputs: [sock('String', 'STRING', { d: '' }), sock('Separator', 'STRING', { d: '' })],
    outputs: [sock('List', 'STRING', { shape: 'SQUARE' })],
  },
  {
    exec: (ctx) => {
      const s = ctx.string('String'),
        sep = ctx.string('Separator');
      return { List: new ListValue('STRING', sep ? s.split(sep) : [s]) };
    },
  },
);

/** Whether a list of tags matches a comma separated filter (any listed tag; empty filters match). */
export function tagFilterMatch(filter: string, tags: readonly string[]): boolean {
  const terms = filter
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length);
  if (!terms.length) return true;
  return terms.some((t) => tags.includes(t));
}

geoNode(
  {
    idname: 'GeometryNodeTagFilter',
    label: 'Tag Filter',
    category: 'converter',
    description: 'Check whether a list of tags contains one of the comma separated tags of the filter',
    inputs: [sock('Tag Filter', 'STRING', { d: '' }), sock('Tags', 'STRING', { hide_value: true, shape: 'SQUARE' })],
    outputs: [sock('Match', 'BOOLEAN')],
  },
  {
    exec: (ctx) => {
      const tags = ctx.input('Tags');
      const list = tags instanceof ListValue ? tags.items.map((t) => String(t ?? '')) : [];
      return { Match: tagFilterMatch(ctx.string('Tag Filter'), list) };
    },
  },
);

// ---------------------------------------------------------------------------
// Enable Output / Implicit Conversion (typed pass-through nodes)

const PASS_TYPES = ITEM_TYPES;
const dataType = (n: NodeData, d: SocketType): SocketType => (String(n.props.data_type ?? d) as SocketType) || d;
const typedSock = (name: string, type: SocketType, o: Partial<SocketDef> = {}): SocketDef => ({ ...itemSocket({ id: 0, name, socket_type: type }, name), ...o });

geoNode(
  {
    idname: 'NodeEnableOutput',
    label: 'Enable Output',
    category: 'converter',
    description: 'Pass the value on only while Enable is on (the default value otherwise)',
    props: [enumProp('data_type', 'Data Type', PASS_TYPES, 'FLOAT', { inNode: true })],
    dynamicSockets: (n) => ({
      inputs: [sock('Enable', 'BOOLEAN', { d: false }), typedSock('Value', dataType(n, 'FLOAT'), { hide_value: true })],
      outputs: [typedSock('Value', dataType(n, 'FLOAT'))],
    }),
  },
  {
    exec: (ctx) => {
      const t = dataType(ctx.node, 'FLOAT');
      return { Value: ctx.bool('Enable') ? ctx.input('Value') : (coerce(undefined, t) as Val) };
    },
  },
);

geoNode(
  {
    idname: 'NodeImplicitConversion',
    label: 'Implicit Conversion',
    category: 'converter',
    description: 'Convert a value to the chosen type the same way links between different socket types do',
    props: [enumProp('data_type', 'Data Type', PASS_TYPES, 'RGBA', { inNode: true })],
    dynamicSockets: (n) => ({
      inputs: [typedSock('Value', dataType(n, 'RGBA'))],
      outputs: [typedSock('Value', dataType(n, 'RGBA'))],
    }),
  },
  { exec: (ctx) => ({ Value: ctx.input('Value') }) },
);

// ---------------------------------------------------------------------------
// Get Nested Bundle Paths

const NESTED_TYPES: [string, string, SocketType][] = [
  ['Float', 'Float', 'FLOAT'],
  ['Integer', 'Integer', 'INT'],
  ['Boolean', 'Boolean', 'BOOLEAN'],
  ['Vector', 'Vector', 'VECTOR'],
  ['Color', 'Color', 'RGBA'],
  ['Rotation', 'Rotation', 'ROTATION'],
  ['Matrix', 'Matrix', 'MATRIX'],
  ['String', 'String', 'STRING'],
  ['Closure', 'Closure', 'CLOSURE'],
  ['Bundle', 'Bundle', 'BUNDLE'],
  ['Object', 'Object', 'OBJECT'],
  ['Collection', 'Collection', 'COLLECTION'],
  ['Image', 'Image', 'IMAGE'],
  ['Material', 'Material', 'MATERIAL'],
  ['Font', 'Font', 'FONT'],
  ['Menu', 'Menu', 'MENU'],
  ['Geometry', 'Geometry', 'GEOMETRY'],
  ['Sound', 'Sound', 'SOUND'],
];

/** Paths ("a/b/c") of every item of a bundle and its nested bundles, depth first. */
export function nestedPaths(b: BundleValue, type: SocketType | null, prefix = '', depth = 0): string[] {
  const out: string[] = [];
  for (const [name, e] of b.items) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!type || e.type === type) out.push(path);
    if (e.value instanceof BundleValue && depth < 32) out.push(...nestedPaths(e.value, type, path, depth + 1));
  }
  return out;
}

geoNode(
  {
    idname: 'NodeGetNestedBundlePaths',
    label: 'Get Nested Bundle Paths',
    category: 'converter',
    width: 180,
    description: 'List the paths of the items in a bundle, including the items of nested bundles',
    inputs: [sock('Bundle', 'BUNDLE', { hide_value: true })],
    outputs: [sock('Paths', 'STRING', { shape: 'SQUARE' })],
    props: [
      enumProp('Mode', 'Mode', [
        ['All', 'All'],
        ['Data Type', 'Data Type'],
      ]),
      enumProp(
        'Data Type',
        'Data Type',
        NESTED_TYPES.map(([v, l]) => [v, l]),
        'Float',
        { visible: (n) => n.props.Mode === 'Data Type' },
      ),
    ],
  },
  {
    exec: (ctx) => {
      const b = ctx.input('Bundle');
      const type = ctx.prop('Mode') === 'Data Type' ? (NESTED_TYPES.find(([v]) => v === ctx.prop('Data Type'))?.[2] ?? 'FLOAT') : null;
      return { Paths: new ListValue('STRING', b instanceof BundleValue ? nestedPaths(b, type) : []) };
    },
  },
);
