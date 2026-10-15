// Properties scripts add to data types: `bpy.types.Object.weight = bpy.props.FloatProperty(default=1)`,
// property groups (`class Settings(bpy.types.PropertyGroup)`) used through PointerProperty and
// CollectionProperty. Values are stored in the data-block's custom properties under the
// property's name, so they save with the file and undo like any edit; reading a value that was
// never set gives the declared default.
import { arrayFactories, BoundArray, NOT_DECLARED, proxify, pyError, Struct, structTypeProps, toPlain, touched, wrapField, type Raw } from './rna';
import type { ScriptProp } from './registry';

export interface TypeProp extends Omit<ScriptProp, 'type'> {
  type: ScriptProp['type'] | 'POINTER' | 'COLLECTION';
  /** POINTER / COLLECTION: the property group's name */
  group?: string;
}

/** Declared properties by struct type name (Object, Scene, Material…, or a property group's name). */
const declared = new Map<string, Map<string, TypeProp>>();

function defaultOf(p: TypeProp): unknown {
  if (p.default !== undefined && p.default !== null) return structuredClone(p.default);
  switch (p.type) {
    case 'FLOAT':
    case 'INT':
      return 0;
    case 'BOOLEAN':
      return false;
    case 'STRING':
      return '';
    case 'ENUM':
      return p.items?.[0]?.[0] ?? '';
    case 'FLOAT_VECTOR':
    case 'INT_VECTOR':
      return Array.from({ length: p.size ?? 3 }, () => 0);
    case 'BOOL_VECTOR':
      return Array.from({ length: p.size ?? 3 }, () => false);
    case 'POINTER':
      return p.group ? groupDefaults(p.group) : null;
    case 'COLLECTION':
      return [];
  }
  return null;
}

function groupDefaults(group: string): Raw {
  const out: Raw = {};
  for (const [k, p] of declared.get(group) ?? []) out[k] = defaultOf(p);
  return out;
}

export function declareTypeProp(type: string, name: string, p: TypeProp) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw pyError('ValueError', `bpy.types.${type}.${name}: not a valid property name`);
  let m = declared.get(type);
  if (!m) declared.set(type, (m = new Map()));
  m.set(name, p);
  if (p.type === 'COLLECTION' && p.group) {
    const group = p.group;
    const re = new RegExp(`\\.${name}$`);
    if (!arrayFactories.some((f) => f.match.source === re.source)) arrayFactories.push({ match: re, make: () => groupDefaults(group) });
  }
}

export function removeTypeProp(type: string, name: string) {
  declared.get(type)?.delete(name);
}

/** Declares a property group: its properties, by name. */
export function declareGroup(name: string, props: Record<string, TypeProp>) {
  const m = new Map<string, TypeProp>();
  for (const [k, p] of Object.entries(props)) m.set(k, p);
  declared.set(name, m);
}

/** Where a struct keeps script-declared values: its custom properties, or its own record for groups. */
function store(t: Struct, group: boolean): Raw {
  const raw = t.__raw;
  if (group) return raw;
  return ((raw.custom as Raw | undefined) ??= {}) as Raw;
}

const isGroupType = (type: string) => groupNames.has(type);
const groupNames = new Set<string>();
export function markGroup(name: string) {
  groupNames.add(name);
}

structTypeProps.get = (t: Struct, key: string) => {
  const p = declared.get(t.__type)?.get(key);
  if (!p) return NOT_DECLARED;
  const group = isGroupType(t.__type);
  const st = store(t, group);
  if (!(key in st)) st[key] = defaultOf(p);
  const path = `${t.__path}.${key}`;
  if (p.type === 'POINTER' && p.group) {
    const g = p.group;
    return proxify(new Struct(g, () => store(t, group)[key] as Raw, path));
  }
  if (p.type === 'COLLECTION' && p.group) return new BoundArray(p.group, path, () => store(t, group)[key] as unknown[], key);
  return wrapField(t, key, () => store(t, group));
};

structTypeProps.set = (t: Struct, key: string, v: unknown) => {
  const p = declared.get(t.__type)?.get(key);
  if (!p) return false;
  if (p.type === 'POINTER' || p.type === 'COLLECTION') throw pyError('AttributeError', `bpy_struct: attribute "${key}" from "${t.__type}" is read-only (set its members)`);
  const st = store(t, isGroupType(t.__type));
  let x = toPlain(v);
  if (p.type === 'FLOAT') x = Number(x);
  else if (p.type === 'INT') x = Math.round(Number(x));
  else if (p.type === 'BOOLEAN') x = !!x;
  else if (p.type === 'STRING') x = String(x ?? '');
  else if (p.type === 'ENUM') {
    if (p.items && !p.items.some((it) => it[0] === x)) throw pyError('TypeError', `bpy_struct: item.attr = val: enum "${x}" not found in (${p.items.map((it) => `'${it[0]}'`).join(', ')})`);
  }
  if (typeof x === 'number' && (p.min !== undefined || p.max !== undefined)) x = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, x as number));
  st[key] = x;
  touched();
  return true;
};

structTypeProps.has = (t: Struct, key: string) => !!declared.get(t.__type)?.has(key);
