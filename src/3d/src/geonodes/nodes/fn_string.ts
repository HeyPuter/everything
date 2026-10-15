// Text nodes: formatting, searching and editing strings, and number ↔ text conversion.
// Strings are single values (not fields).
import './fdata';
import { gn, prop, sprop } from './defs';
import { formatString, shortestFloat, toFixedExact, intToString, parseFloatPrefix, parseIntPrefix, type FormatValue } from '../strformat';
import { readItems, itemListUI, registerItemNode, itemSocket, type ItemListDef, type NodeItem } from './items';
import type { SocketDef } from '../../nodes/types';
import type { NodeData } from '../../data/types';

const cps = (s: string) => Array.from(s);

// ---------------------------------------------------------------------------
// Format String

const FORMAT_TYPES: [string, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['STRING', 'String'],
];
export const formatItems = (n: NodeData) => readItems(n, 'format_items');
const formatIn = (it: NodeItem) => `Item_${it.id}`;
const FORMAT_DEF: ItemListDef = {
  prop: 'format_items',
  title: 'Format Items',
  inSocket: formatIn,
  types: FORMAT_TYPES,
  typeFor: (s) => (s.type === 'INT' || s.type === 'BOOLEAN' ? 'INT' : s.type === 'STRING' ? 'STRING' : s.type === 'FLOAT' ? 'FLOAT' : undefined),
  defaultName: (items) => {
    let k = items.length;
    const names = new Set(items.map((i) => i.name));
    let nm = 'Value';
    while (names.has(nm)) nm = `Value_${++k}`;
    return nm;
  },
};
registerItemNode('FunctionNodeFormatString', FORMAT_DEF, formatItems);

gn(
  'FunctionNodeFormatString',
  'converter',
  {
    exec: (ctx) => {
      const values: FormatValue[] = formatItems(ctx.node).map((it) => {
        const t = (it.type ?? 'FLOAT') as FormatValue['type'];
        const id = formatIn(it);
        return { name: it.name, type: t, value: t === 'STRING' ? ctx.string(id) : t === 'INT' ? ctx.int(id) : Math.fround(ctx.float(id)) };
      });
      const r = formatString(ctx.string('Format'), values);
      if (r.error) ctx.warn(r.error);
      return { String: r.text };
    },
  },
  {
    dynamicSockets: (node) => ({
      inputs: [
        { name: 'Format', identifier: 'Format', type: 'STRING', default: '' },
        ...formatItems(node).map((it): SocketDef => {
          const t = it.type ?? 'FLOAT';
          return { name: it.name, identifier: formatIn(it), type: t === 'INT' ? 'INT' : t === 'STRING' ? 'STRING' : 'FLOAT', default: t === 'STRING' ? '' : 0 };
        }),
        itemSocket(),
      ],
      outputs: [{ name: 'String', identifier: 'String', type: 'STRING', default: '' }],
    }),
    drawOptions: (ctx) => itemListUI(ctx, FORMAT_DEF, formatItems(ctx.node)),
  },
);

// ---------------------------------------------------------------------------
// Join / match / replace / reverse / slice / case / trim / find / length

const join = gn('GeometryNodeStringJoin', 'converter', {
  exec: (ctx) => ({
    String: ctx
      .values('Strings')
      .map((v) => (typeof v === 'string' ? v : ''))
      .join(ctx.string('Delimiter')),
  }),
});
join.inputs.find((x) => x.identifier === 'Strings')!.multiInput = true;

const MATCH_OPS: [string, string][] = [
  ['Starts With', 'Starts With'],
  ['Ends With', 'Ends With'],
  ['Contains', 'Contains'],
];

gn(
  'FunctionNodeMatchString',
  'converter',
  {
    exec: (ctx) => {
      const s = ctx.string('String'),
        k = ctx.string('Key');
      const op = sprop(ctx.node, 'Operation') || 'Starts With';
      return { Result: op === 'Ends With' ? s.endsWith(k) : op === 'Contains' ? s.includes(k) : s.startsWith(k) };
    },
  },
  { menus: { Operation: MATCH_OPS } },
);

gn('FunctionNodeReplaceString', 'converter', {
  exec: (ctx) => {
    const s = ctx.string('String'),
      f = ctx.string('Find');
    return { String: f ? s.split(f).join(ctx.string('Replace')) : s };
  },
});

gn('FunctionNodeReverseString', 'converter', {
  exec: (ctx) => ({ String: cps(ctx.string('String')).reverse().join('') }),
});

/** Characters [position, position + length) of a string (code points, clipped to the string). */
export function sliceString(s: string, pos: number, len: number): string {
  const c = cps(s);
  const a = Math.max(0, pos),
    b = Math.min(c.length, pos + Math.max(0, len));
  return b > a ? c.slice(a, b).join('') : '';
}

gn('FunctionNodeSliceString', 'converter', {
  exec: (ctx) => ({ String: sliceString(ctx.string('String'), ctx.int('Position'), ctx.int('Length')) }),
});

gn(
  'FunctionNodeSetStringCase',
  'converter',
  {
    exec: (ctx) => {
      const s = ctx.string('String');
      return { String: sprop(ctx.node, 'Case') === 'Lowercase' ? s.toLowerCase() : s.toUpperCase() };
    },
  },
  {
    menus: {
      Case: [
        ['Uppercase', 'Uppercase'],
        ['Lowercase', 'Lowercase'],
      ],
    },
  },
);

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\v', '\f']);

export function trimString(s: string, chars: string, whitespace: boolean, start: boolean, end: boolean): string {
  const set = new Set(cps(chars));
  if (whitespace) for (const w of WHITESPACE) set.add(w);
  const c = cps(s);
  let a = 0,
    b = c.length;
  if (start) while (a < b && set.has(c[a])) a++;
  if (end) while (b > a && set.has(c[b - 1])) b--;
  return c.slice(a, b).join('');
}

gn('FunctionNodeTrimString', 'converter', {
  exec: (ctx) => ({ String: trimString(ctx.string('String'), ctx.string('Characters'), ctx.bool('Whitespace'), ctx.bool('Start'), ctx.bool('End')) }),
});

/** First (or last) occurrence index in code points (0 when absent) and non-overlapping count. */
export function findInString(s: string, search: string, fromEnd: boolean): { first: number; count: number } {
  if (!search) return { first: 0, count: 0 };
  let count = 0;
  for (let i = s.indexOf(search); i >= 0; i = s.indexOf(search, i + search.length)) count++;
  const at = fromEnd ? s.lastIndexOf(search) : s.indexOf(search);
  return { first: at < 0 ? 0 : cps(s.slice(0, at)).length, count };
}

gn(
  'FunctionNodeFindInString',
  'converter',
  {
    exec: (ctx) => {
      const r = findInString(ctx.string('String'), ctx.string('Search'), sprop(ctx.node, 'Mode') === 'From End');
      return { 'First Found': r.first, Count: r.count };
    },
  },
  {
    menus: {
      Mode: [
        ['From Start', 'From Start'],
        ['From End', 'From End'],
      ],
    },
  },
);

gn('FunctionNodeStringLength', 'converter', {
  exec: (ctx) => ({ Length: cps(ctx.string('String')).length }),
});

// ---------------------------------------------------------------------------
// Number ↔ text

gn(
  'FunctionNodeValueToString',
  'converter',
  {
    exec: (ctx) => {
      if (sprop(ctx.node, 'data_type') === 'INT') return { String: intToString(ctx.int('Value'), ctx.int('Base'), ctx.int('Padding')) };
      const v = Math.fround(ctx.float('Value'));
      const d = Math.max(0, ctx.int('Decimals'));
      const neg = v < 0 || Object.is(v, -0);
      const body = Number.isFinite(v) ? toFixedExact(Math.abs(v), d) : shortestFloat(Math.abs(v));
      return { String: (neg ? '-' : '') + body };
    },
  },
  {
    propPatch: { data_type: { noLabel: true } },
    dynamicSockets: (node) => {
      const isInt = sprop(node, 'data_type') === 'INT';
      const inputs: SocketDef[] = isInt
        ? [
            { name: 'Value', identifier: 'Value', type: 'INT', default: 0 },
            { name: 'Base', identifier: 'Base', type: 'INT', default: 10, min: 2, max: 36 },
            { name: 'Padding', identifier: 'Padding', type: 'INT', default: 0, min: 0 },
          ]
        : [
            { name: 'Value', identifier: 'Value', type: 'FLOAT', default: 0 },
            { name: 'Decimals', identifier: 'Decimals', type: 'INT', default: 0, min: 0 },
          ];
      return { inputs, outputs: [{ name: 'String', identifier: 'String', type: 'STRING', default: '' }] };
    },
  },
);

gn(
  'FunctionNodeStringToValue',
  'converter',
  {
    exec: (ctx) => {
      const s = ctx.string('String');
      const r = sprop(ctx.node, 'data_type') === 'INT' ? parseIntPrefix(s, ctx.int('Base')) : parseFloatPrefix(s);
      return { Value: r.value, Length: r.length };
    },
  },
  {
    propPatch: { data_type: { noLabel: true } },
    dynamicSockets: (node) => {
      const isInt = sprop(node, 'data_type') === 'INT';
      return {
        inputs: [
          { name: 'String', identifier: 'String', type: 'STRING', default: '' },
          ...(isInt ? [{ name: 'Base', identifier: 'Base', type: 'INT', default: 10, min: 2, max: 36 } as SocketDef] : []),
        ],
        outputs: [
          { name: 'Value', identifier: 'Value', type: isInt ? 'INT' : 'FLOAT', default: 0 },
          { name: 'Length', identifier: 'Length', type: 'INT', default: 0 },
        ],
      };
    },
  },
);

gn('FunctionNodeInputSpecialCharacters', 'input', {
  exec: () => ({ 'Line Break': '\n', Tab: '\t' }),
});

void prop;
