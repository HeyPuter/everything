// Lists: ordered values of one type, made from fields (Field to List) or by calling a closure for
// every index (Closure to List), and read back with Get List Item, List Length, Filter List and
// Sort List. Field inputs of list nodes are evaluated over the list's indices.
import type { NodeData } from '../../data/types';
import type { SocketDef, SocketType } from '../../nodes/types';
import { geoNode, sock, enumProp } from '../nodes/gndef';
import type { OpaqueVal, Val } from '../exec';
import { coerce } from '../evaluator';
import { Field, ConstField, fnField, makeContext, evalFull, readScalar, writeScalar, type Evaluated } from '../field';
import { PointsComponent } from '../geometry';
import { FIELD_ITEM_TYPES, ITEM_TYPES, itemSocket } from '../zones/items';
import { registerItemNode, itemSocket as addSocket, readItems, type ItemListDef, type NodeItem } from '../nodes/items';
import type { FieldType } from '../types';
import { ClosureValue } from './values';

export class ListValue implements OpaqueVal {
  readonly opaqueKind = 'LIST';
  constructor(
    readonly type: SocketType,
    readonly items: Val[],
  ) {}
  get length() {
    return this.items.length;
  }
  toString() {
    return `List (${this.items.length})`;
  }
}

/** Upper bound on list sizes built by the list nodes. */
export const MAX_LIST = 1_000_000;

/** A field context of `n` elements (index-only: positions are zero). */
function indexContext(n: number) {
  return makeContext(new PointsComponent(new Float32Array(n * 3)), 'POINT');
}

/** Values of a field (or a single value) for indices 0..n-1. */
function fieldValues(v: Val, type: SocketType, n: number): Val[] {
  if (!FIELD_ITEM_TYPES.has(type) && type !== 'MATRIX') return Array.from({ length: n }, () => v);
  const ft = type as FieldType;
  const f = v instanceof Field ? v : new ConstField(ft, (v ?? coerce(undefined, type) ?? 0) as number);
  const data = evalFull(f, indexContext(n));
  return Array.from({ length: n }, (_, i) => readScalar({ data }, ft, i) as Val);
}

const listSock = (name: string, type: SocketType, identifier = name): SocketDef => ({ ...itemSocket({ id: 0, name, socket_type: type }, identifier), shape: 'SQUARE', hide_value: true });
const typeOf = (it: NodeItem): SocketType => (it.socket_type as SocketType) ?? 'FLOAT';
const typeProp = (n: NodeData, key = 'socket_type') => (String(n.props[key] ?? 'FLOAT') as SocketType) || 'FLOAT';

function countOf(ctxInt: (id: string) => number, warn: (m: string) => void): number {
  const n = ctxInt('Count');
  if (n > MAX_LIST) warn(`Lists are limited to ${MAX_LIST} items`);
  return Math.max(0, Math.min(MAX_LIST, n));
}

// ---------------------------------------------------------------------------
// Field to List / Closure to List (item lists)

const listItemDef = (ops: string, opLabel: string, withInputs: boolean, types: [SocketType, string][]): ItemListDef => ({
  prop: 'list_items',
  title: 'List Items',
  ...(withInputs ? { inSocket: (it: NodeItem) => `Field_${it.id}` } : {}),
  outSocket: (it) => `List_${it.id}`,
  types,
  typeKey: 'socket_type',
  typeFor: (s) => (types.some(([t]) => t === s.type) ? s.type : undefined),
  defaultName: () => 'Value',
  nameFromType: true,
  ops,
  opLabel,
});

export const FIELD_TO_LIST_ITEMS = listItemDef(
  'field_to_list',
  'Field to List',
  true,
  ITEM_TYPES.filter(([t]) => FIELD_ITEM_TYPES.has(t) || t === 'MATRIX'),
);
export const CLOSURE_TO_LIST_ITEMS = listItemDef('closure_to_list', 'Closure to List', false, ITEM_TYPES);
const listItems = (n: NodeData) => readItems(n, 'list_items');
registerItemNode('GeometryNodeFieldToList', FIELD_TO_LIST_ITEMS, listItems);
registerItemNode('GeometryNodeClosureToList', CLOSURE_TO_LIST_ITEMS, listItems);

geoNode(
  {
    idname: 'GeometryNodeFieldToList',
    label: 'Field to List',
    category: 'converter',
    description: 'Evaluate fields for the indices 0 to Count - 1 and keep the values as lists',
    dynamicSockets: (node) => ({
      inputs: [sock('Count', 'INT', { d: 1, min: 0 }), ...listItems(node).map((it) => itemSocket({ id: it.id, name: it.name, socket_type: typeOf(it) }, `Field_${it.id}`)), addSocket()],
      outputs: [...listItems(node).map((it) => listSock(it.name, typeOf(it), `List_${it.id}`)), addSocket()],
    }),
  },
  {
    exec: (ctx) => {
      const n = countOf(ctx.int, ctx.warn);
      const out: Record<string, Val> = {};
      for (const it of listItems(ctx.node)) out[`List_${it.id}`] = new ListValue(typeOf(it), fieldValues(ctx.input(`Field_${it.id}`), typeOf(it), n));
      return out;
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeClosureToList',
    label: 'Closure to List',
    category: 'converter',
    description: 'Call a closure once per index (its "Index" input) and collect its outputs into lists',
    dynamicSockets: (node) => ({
      inputs: [sock('Count', 'INT', { d: 1, min: 0 }), sock('Closure', 'CLOSURE', { hide_value: true })],
      outputs: [...listItems(node).map((it) => listSock(it.name, typeOf(it), `List_${it.id}`)), addSocket()],
    }),
  },
  {
    exec: (ctx) => {
      const n = countOf(ctx.int, ctx.warn);
      const items = listItems(ctx.node);
      const c = ctx.input('Closure');
      const cols: Val[][] = items.map(() => []);
      for (let i = 0; i < n; i++) {
        const vals =
          c instanceof ClosureValue
            ? c.evaluate(
                [{ name: 'Index', type: 'INT', value: i }],
                items.map((it) => ({ name: it.name, type: typeOf(it) })),
              )
            : null;
        items.forEach((it, k) => cols[k].push(vals ? vals[k] : coerce(undefined, typeOf(it))));
        if (c instanceof ClosureValue && !vals) {
          ctx.warn('Closures call each other too deeply', 'ERROR');
          break;
        }
      }
      const out: Record<string, Val> = {};
      items.forEach((it, k) => (out[`List_${it.id}`] = new ListValue(typeOf(it), cols[k])));
      return out;
    },
  },
);

// ---------------------------------------------------------------------------
// Reading lists

const LIST_TYPES: [string, string][] = ITEM_TYPES.map(([t, l]) => [t, l]);
const asList = (v: Val): ListValue | null => (v instanceof ListValue ? v : null);

geoNode(
  {
    idname: 'GeometryNodeListGetItem',
    label: 'Get List Item',
    category: 'converter',
    description: 'The value at an index of a list (indices outside the list give the default value)',
    props: [enumProp('socket_type', 'Type', LIST_TYPES, 'FLOAT')],
    dynamicSockets: (node) => {
      const t = typeProp(node);
      const field = FIELD_ITEM_TYPES.has(t);
      return { inputs: [listSock('List', t), sock('Index', 'INT', { d: 0, ...(field ? { dot: true } : {}) })], outputs: [itemSocket({ id: 0, name: 'Value', socket_type: t }, 'Value')] };
    },
  },
  {
    exec: (ctx) => {
      const t = typeProp(ctx.node);
      const list = asList(ctx.input('List'));
      const items = list?.items ?? [];
      const dflt = coerce(undefined, t);
      const idx = ctx.input('Index');
      if (idx instanceof Field && idx.dependsOnContext && FIELD_ITEM_TYPES.has(t)) {
        const ft = t as FieldType;
        return {
          Value: fnField(ft, [idx], ([ix]: Evaluated[], out, n) => {
            for (let i = 0; i < n; i++) {
              const k = Math.trunc(Number(ix.data[ix.single ? 0 : i]));
              writeScalar(out, ft, i, (k >= 0 && k < items.length ? items[k] : dflt) as number);
            }
          }),
        };
      }
      const k = ctx.int('Index');
      return { Value: k >= 0 && k < items.length ? items[k] : dflt };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeListLength',
    label: 'List Length',
    category: 'converter',
    description: 'Number of items in a list',
    props: [enumProp('data_type', 'Type', LIST_TYPES, 'FLOAT')],
    dynamicSockets: (node) => ({ inputs: [listSock('List', typeProp(node, 'data_type'))], outputs: [sock('Length', 'INT')] }),
  },
  { exec: (ctx) => ({ Length: asList(ctx.input('List'))?.length ?? 0 }) },
);

/** Per-index values of a field input over a list. */
function perIndex(v: Val, type: FieldType, n: number): Val[] {
  return fieldValues(v, type, n);
}

geoNode(
  {
    idname: 'GeometryNodeFilterList',
    label: 'Filter List',
    category: 'converter',
    description: 'Split a list into the items whose selection is on and the rest',
    props: [enumProp('socket_type', 'Type', LIST_TYPES, 'FLOAT')],
    dynamicSockets: (node) => {
      const t = typeProp(node);
      return { inputs: [listSock('List', t), sock('Selection', 'BOOLEAN', { d: true, dot: true })], outputs: [listSock('Selection', t), listSock('Inverted', t)] };
    },
  },
  {
    exec: (ctx) => {
      const t = typeProp(ctx.node);
      const list = asList(ctx.input('List'));
      const items = list?.items ?? [];
      const sel = perIndex(ctx.input('Selection'), 'BOOLEAN', items.length);
      return {
        Selection: new ListValue(
          t,
          items.filter((_, i) => !!sel[i]),
        ),
        Inverted: new ListValue(
          t,
          items.filter((_, i) => !sel[i]),
        ),
      };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeSortList',
    label: 'Sort List',
    category: 'converter',
    description: 'Reorder the selected items of a list by group, then by increasing weight (unselected items keep their place)',
    props: [enumProp('socket_type', 'Type', LIST_TYPES, 'FLOAT')],
    dynamicSockets: (node) => {
      const t = typeProp(node);
      return {
        inputs: [listSock('List', t), sock('Selection', 'BOOLEAN', { d: true, dot: true }), sock('Group ID', 'INT', { d: 0, dot: true }), sock('Sort Weight', 'FLOAT', { d: 0, dot: true })],
        outputs: [listSock('List', t)],
      };
    },
  },
  {
    exec: (ctx) => {
      const t = typeProp(ctx.node);
      const items = asList(ctx.input('List'))?.items ?? [];
      const n = items.length;
      const sel = perIndex(ctx.input('Selection'), 'BOOLEAN', n);
      const grp = perIndex(ctx.input('Group ID'), 'INT', n) as number[];
      const w = perIndex(ctx.input('Sort Weight'), 'FLOAT', n) as number[];
      const slots = items.map((_, i) => i).filter((i) => !!sel[i]);
      const order = [...slots].sort((a, b) => grp[a] - grp[b] || w[a] - w[b] || a - b);
      const out = items.slice();
      slots.forEach((s, k) => (out[s] = items[order[k]]));
      return { List: new ListValue(t, out) };
    },
  },
);
