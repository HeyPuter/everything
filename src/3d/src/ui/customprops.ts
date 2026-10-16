// Custom properties of data-blocks: the "Custom Properties" panel (New, value rows with edit and
// remove buttons) and the wm.properties_* operators. Values live in the data-block's `custom`
// record (scripts reach them as `ob["prop"]`); their settings (type, limits, default, subtype,
// description) in `custom_ui`, so both save with the file and undo like any edit.
import { h, type Child } from './h';
import { icon } from './icons';
import { app, registerOperators, type PropDef } from '../app/app';
import { num, bool, textProp, vecProp, splitRow } from './props';
import { promptText } from './menu';
import { operatorDialog } from './opdialog';
import { contextObject } from '../ops/wm_context';
import type { Unit } from './widgets';

type Rec = Record<string, unknown>;

export { customPropMeta, setCustomPropMeta, type CustomPropMeta, type CustomPropType } from './custommeta';
import { customPropMeta, setCustomPropMeta, type CustomPropMeta, type CustomPropType } from './custommeta';

/** Type of a stored value (the settings decide between float and int). */
export function typeOf(v: unknown, meta: CustomPropMeta = {}): CustomPropType {
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = Array.from(v as ArrayLike<unknown>);
    if (a.every((x) => typeof x === 'boolean')) return 'BOOL_ARRAY';
    if (a.every((x) => typeof x === 'number')) return meta.type === 'INT_ARRAY' ? 'INT_ARRAY' : 'FLOAT_ARRAY';
    return 'PYTHON';
  }
  if (typeof v === 'boolean') return 'BOOL';
  if (typeof v === 'string') return 'STRING';
  if (typeof v === 'number') return meta.type === 'INT' ? 'INT' : 'FLOAT';
  return 'PYTHON';
}

const UNITS: Record<string, Unit> = { DISTANCE: 'distance', ANGLE: 'angle', FACTOR: 'factor', PERCENTAGE: 'percentage', PIXEL: 'pixel', TIME_ABSOLUTE: 'time', TIME: 'time' };

/** A value of the given type made from another (keeps what it can). */
export function convertValue(v: unknown, type: CustomPropType, length = 3): unknown {
  const first = Array.isArray(v) || ArrayBuffer.isView(v) ? (v as ArrayLike<unknown>)[0] : v;
  const asNum = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'boolean' ? Number(x) : Number.isFinite(Number(x)) ? Number(x) : 0);
  const arr = (f: (x: unknown) => unknown) => {
    const src = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<unknown>) : [v];
    return Array.from({ length }, (_, i) => f(src[i] ?? src[src.length - 1] ?? 0));
  };
  switch (type) {
    case 'FLOAT':
      return asNum(first);
    case 'INT':
      return Math.round(asNum(first));
    case 'BOOL':
      return !!asNum(first);
    case 'STRING':
      return typeof v === 'string' ? v : first === undefined ? '' : String(first);
    case 'FLOAT_ARRAY':
      return arr(asNum);
    case 'INT_ARRAY':
      return arr((x) => Math.round(asNum(x)));
    case 'BOOL_ARRAY':
      return arr((x) => !!asNum(x));
  }
  return v;
}

/** Name not used yet in the record ("prop", "prop1", …). */
export function uniquePropName(custom: Rec, base = 'prop'): string {
  let i = 0;
  while (`${base}${i ? i : ''}` in custom) i++;
  return `${base}${i ? i : ''}`;
}

// ---------------------------------------------------------------------------
// operators

function blockAt(dataPath: unknown): Rec | null {
  const b = contextObject(String(dataPath ?? ''));
  return b && typeof b === 'object' ? (b as Rec) : null;
}

const TYPE_ITEMS: [string, string, string?][] = [
  ['FLOAT', 'Float', 'A single decimal number'],
  ['FLOAT_ARRAY', 'Float Array', 'A list of decimal numbers'],
  ['INT', 'Integer', 'A single whole number'],
  ['INT_ARRAY', 'Integer Array', 'A list of whole numbers'],
  ['BOOL', 'Boolean', 'On or off'],
  ['BOOL_ARRAY', 'Boolean Array', 'A list of on / off values'],
  ['STRING', 'String', 'Text'],
];
const SUBTYPES: [string, string][] = [
  ['NONE', 'Plain Data'],
  ['DISTANCE', 'Distance'],
  ['ANGLE', 'Angle'],
  ['FACTOR', 'Factor'],
  ['PERCENTAGE', 'Percentage'],
  ['PIXEL', 'Pixel'],
  ['TIME_ABSOLUTE', 'Time'],
];
const isNumType = (p: Rec) => ['FLOAT', 'INT', 'FLOAT_ARRAY', 'INT_ARRAY'].includes(String(p.property_type));
const isFloat = (p: Rec) => p.property_type === 'FLOAT' || p.property_type === 'FLOAT_ARRAY';
const isArrayType = (p: Rec) => String(p.property_type).endsWith('_ARRAY');

const EDIT_PROPS: PropDef[] = [
  { id: 'data_path', label: 'Property Edit', type: 'string', default: '', hidden: true },
  { id: 'old_name', label: 'Old Name', type: 'string', default: '', hidden: true },
  { id: 'property_type', label: 'Type', type: 'enum', default: 'FLOAT', items: TYPE_ITEMS },
  { id: 'property_name', label: 'Property Name', type: 'string', default: 'prop' },
  { id: 'array_length', label: 'Array Length', type: 'int', default: 3, min: 1, max: 32, showIf: isArrayType },
  { id: 'value_float', label: 'Value', type: 'float', default: 1, showIf: (p) => p.property_type === 'FLOAT' },
  { id: 'value_int', label: 'Value', type: 'int', default: 1, showIf: (p) => p.property_type === 'INT' },
  { id: 'value_bool', label: 'Value', type: 'bool', default: false, showIf: (p) => p.property_type === 'BOOL' },
  { id: 'value_string', label: 'Value', type: 'string', default: '', showIf: (p) => p.property_type === 'STRING' },
  { id: 'default_value', label: 'Default', type: 'float', default: 0, showIf: (p) => isNumType(p) && !isArrayType(p) },
  { id: 'min', label: 'Min', type: 'float', default: 0, showIf: isNumType },
  { id: 'max', label: 'Max', type: 'float', default: 1, showIf: isNumType },
  { id: 'use_soft_limits', label: 'Soft Limits', type: 'bool', default: false, showIf: isNumType },
  { id: 'soft_min', label: 'Soft Min', type: 'float', default: 0, showIf: (p) => isNumType(p) && !!p.use_soft_limits },
  { id: 'soft_max', label: 'Soft Max', type: 'float', default: 1, showIf: (p) => isNumType(p) && !!p.use_soft_limits },
  { id: 'step', label: 'Step', type: 'float', default: 0.1, min: 0.001, showIf: isFloat },
  { id: 'precision', label: 'Precision', type: 'int', default: 3, min: 0, max: 8, showIf: isFloat },
  { id: 'subtype', label: 'Subtype', type: 'enum', default: 'NONE', items: SUBTYPES, showIf: isFloat },
  { id: 'description', label: 'Description', type: 'string', default: '' },
];

/** Operator properties describing an existing custom property (for the Edit Property dialog). */
export function editPropsFor(block: Rec, key: string, dataPath: string): Rec {
  const v = (block.custom as Rec | undefined)?.[key];
  const m = customPropMeta(block, key);
  const type = m.type ?? typeOf(v, m);
  const arr = Array.isArray(v) || ArrayBuffer.isView(v) ? (v as ArrayLike<unknown>).length : 3;
  return {
    data_path: dataPath,
    old_name: key,
    property_name: key,
    property_type: type === 'PYTHON' ? 'FLOAT' : type,
    array_length: arr,
    value_float: typeof v === 'number' ? v : 1,
    value_int: typeof v === 'number' ? Math.round(v) : 1,
    value_bool: typeof v === 'boolean' ? v : false,
    value_string: typeof v === 'string' ? v : '',
    default_value: typeof m.default === 'number' ? m.default : 0,
    min: m.min ?? (type === 'INT' || type === 'INT_ARRAY' ? 0 : 0),
    max: m.max ?? (type === 'INT' || type === 'INT_ARRAY' ? 100 : 1),
    use_soft_limits: m.soft_min !== undefined || m.soft_max !== undefined,
    soft_min: m.soft_min ?? m.min ?? 0,
    soft_max: m.soft_max ?? m.max ?? 1,
    step: m.step ?? 0.1,
    precision: m.precision ?? 3,
    subtype: m.subtype ?? 'NONE',
    description: m.description ?? '',
  };
}

/** Apply the Edit Property settings to a data-block (pure; returns the property's final name). */
export function applyPropertyEdit(block: Rec, p: Rec): string {
  const custom = ((block.custom as Rec | undefined) ??= {});
  const old = String(p.old_name ?? '');
  let name = String(p.property_name ?? '').trim() || 'prop';
  const type = String(p.property_type) as CustomPropType;
  const prev = old && old in custom ? custom[old] : undefined;
  if (old && old !== name) {
    if (name in custom) name = uniquePropName(custom, name);
    delete custom[old];
    setCustomPropMeta(block, old, null);
  }
  const len = Math.max(1, Math.round(Number(p.array_length) || 3));
  let value: unknown;
  if (type === 'FLOAT') value = Number(p.value_float);
  else if (type === 'INT') value = Math.round(Number(p.value_int));
  else if (type === 'BOOL') value = !!p.value_bool;
  else if (type === 'STRING') value = String(p.value_string ?? '');
  else value = convertValue(prev ?? 0, type, len);
  const meta: CustomPropMeta = { type };
  if (isNumType(p)) {
    meta.min = Number(p.min);
    meta.max = Number(p.max);
    if (meta.min > meta.max) [meta.min, meta.max] = [meta.max, meta.min];
    if (p.use_soft_limits) {
      meta.soft_min = Math.max(meta.min, Number(p.soft_min));
      meta.soft_max = Math.min(meta.max, Number(p.soft_max));
    }
    const clampV = (x: number) => Math.min(meta.max!, Math.max(meta.min!, x));
    if (typeof value === 'number') value = clampV(value);
    else if (Array.isArray(value)) value = value.map((x) => clampV(Number(x)));
    if (!isArrayType(p)) meta.default = type === 'INT' ? Math.round(Number(p.default_value)) : Number(p.default_value);
  }
  if (isFloat(p)) {
    meta.step = Number(p.step);
    meta.precision = Math.round(Number(p.precision));
    if (p.subtype && p.subtype !== 'NONE') meta.subtype = String(p.subtype);
  }
  if (p.description) meta.description = String(p.description);
  custom[name] = value;
  setCustomPropMeta(block, name, meta);
  return name;
}

function changed() {
  app.graph.invalidate?.();
  app.changed('doc');
}

registerOperators([
  {
    idname: 'wm.properties_add',
    label: 'Add Property',
    description: 'Add a custom property to the data-block',
    props: [{ id: 'data_path', label: 'Property Edit', type: 'string', default: 'object' }],
    poll: () => true,
    exec: (_c, p) => {
      const block = blockAt(p.data_path);
      if (!block) return 'CANCELLED';
      const custom = ((block.custom as Rec | undefined) ??= {});
      const name = uniquePropName(custom);
      custom[name] = 1.0;
      setCustomPropMeta(block, name, { type: 'FLOAT', min: 0, max: 1, soft_min: 0, soft_max: 1, default: 1 });
      changed();
    },
  },
  {
    idname: 'wm.properties_remove',
    label: 'Remove Property',
    description: 'Remove a custom property from the data-block',
    props: [
      { id: 'data_path', label: 'Property Edit', type: 'string', default: 'object' },
      { id: 'property_name', label: 'Property Name', type: 'string', default: '' },
    ],
    exec: (_c, p) => {
      const block = blockAt(p.data_path);
      const custom = block?.custom as Rec | undefined;
      const name = String(p.property_name ?? '');
      if (!block || !custom || !(name in custom)) return 'CANCELLED';
      delete custom[name];
      setCustomPropMeta(block, name, null);
      changed();
    },
  },
  {
    idname: 'wm.properties_edit',
    label: 'Edit Property',
    description: 'Change the name, type, value, limits and description of a custom property',
    props: EDIT_PROPS,
    invoke: (_c, p) => {
      const block = blockAt(p.data_path);
      const name = String(p.property_name || p.old_name || '');
      if (!block) return 'CANCELLED';
      operatorDialog('wm.properties_edit', name && (block.custom as Rec | undefined)?.[name] !== undefined ? editPropsFor(block, name, String(p.data_path)) : p);
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const block = blockAt(p.data_path);
      if (!block) return 'CANCELLED';
      applyPropertyEdit(block, p);
      changed();
    },
  },
  {
    idname: 'wm.properties_edit_value',
    label: 'Edit Property Value',
    description: 'Type the value of a custom property as text (numbers, lists like [1, 2, 3], True / False, or text)',
    props: [
      { id: 'data_path', label: 'Property Edit', type: 'string', default: 'object' },
      { id: 'property_name', label: 'Property Name', type: 'string', default: '' },
      { id: 'value', label: 'Value', type: 'string', default: '' },
    ],
    invoke: (_c, p) => {
      const block = blockAt(p.data_path);
      const name = String(p.property_name ?? '');
      const v = (block?.custom as Rec | undefined)?.[name];
      if (!block || v === undefined) return 'CANCELLED';
      promptText(`Value of "${name}"`, JSON.stringify(Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<unknown>) : v), (t) => app.run('wm.properties_edit_value', { ...p, value: t }, { invoke: false }));
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const block = blockAt(p.data_path);
      const custom = block?.custom as Rec | undefined;
      const name = String(p.property_name ?? '');
      if (!block || !custom || !(name in custom)) return 'CANCELLED';
      const text = String(p.value ?? '').trim();
      let v: unknown;
      try {
        v = JSON.parse(text.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null').replace(/\(/g, '[').replace(/\)/g, ']'));
      } catch {
        v = text;
      }
      custom[name] = v;
      changed();
    },
  },
]);

// ---------------------------------------------------------------------------
// panel

/** Rows of the Custom Properties panel of a data-block (`dataPath` names it in the context). */
export function customPropsPanelBody(block: Rec, dataPath: string): Child {
  const custom = (block.custom as Rec | undefined) ?? {};
  const keys = Object.keys(custom).filter((k) => !k.startsWith('_'));
  return [
    h('button', { class: 'btn cp-new', 'data-op': 'wm.properties_add', 'data-op-props': JSON.stringify({ data_path: dataPath }), onclick: () => app.run('wm.properties_add', { data_path: dataPath }) }, icon('add'), 'New'),
    keys.map((k) => {
      const v = custom[k];
      const m = customPropMeta(block, k);
      const tools = h(
        'span',
        { class: 'cp-tools' },
        h('button', { class: 'icon-btn', 'data-tip': 'Edit Property', 'data-op': 'wm.properties_edit', 'data-op-props': JSON.stringify({ data_path: dataPath, property_name: k }), onclick: () => app.run('wm.properties_edit', { data_path: dataPath, property_name: k }) }, icon('preferences')),
        h('button', { class: 'icon-btn', 'data-tip': 'Remove Property', 'data-op': 'wm.properties_remove', 'data-op-props': JSON.stringify({ data_path: dataPath, property_name: k }), onclick: () => app.run('wm.properties_remove', { data_path: dataPath, property_name: k }) }, icon('x')),
      );
      const tip = m.description || undefined;
      let row: Child;
      if (typeof v === 'number') {
        const int = m.type === 'INT';
        row = num(custom, k, k, { min: m.min, max: m.max, softMin: m.soft_min, softMax: m.soft_max, step: m.step, precision: m.precision, int, unit: UNITS[m.subtype ?? ''] ?? 'none', slider: m.subtype === 'FACTOR', tip, undo: 'Edit Property' });
      } else if (typeof v === 'boolean') row = bool(custom, k, k, { tip, undo: 'Edit Property' });
      else if (typeof v === 'string') row = textProp(custom, k, k);
      else if ((Array.isArray(v) || ArrayBuffer.isView(v)) && Array.from(v as ArrayLike<unknown>).every((x) => typeof x === 'number')) row = vecProp(custom, k, k, { min: m.min, max: m.max, unit: UNITS[m.subtype ?? ''] ?? 'none', int: m.type === 'INT_ARRAY' });
      else
        row = splitRow(
          k,
          h('button', { class: 'btn cp-python', 'data-tip': 'Edit the value as text', onclick: () => app.run('wm.properties_edit_value', { data_path: dataPath, property_name: k }) }, JSON.stringify(v) ?? String(v)),
        );
      return h('div', { key: k, class: 'custom-prop' }, row, tools);
    }),
  ];
}
