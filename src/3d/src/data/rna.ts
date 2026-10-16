// Data path resolution for animation, drivers and the scripting API.
// Paths use the familiar RNA syntax: `location`, `pose.bones["Bone"].rotation_quaternion`,
// `data.energy`, `modifiers["Subdivision"].levels`, `data.shape_keys.key_blocks["Key 1"].value`,
// `material.nodes["Principled BSDF"].inputs["Roughness"].default_value`.
import type { DocumentData, ObjectData } from './types';

type Token = { kind: 'prop'; name: string } | { kind: 'key'; key: string } | { kind: 'index'; index: number };

const tokenCache = new Map<string, Token[]>();

export function tokenize(path: string): Token[] {
  const cached = tokenCache.get(path);
  if (cached) return cached;
  const out: Token[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      i++;
      continue;
    }
    if (c === '[') {
      const end = path.indexOf(']', i);
      if (end < 0) throw new Error(`Bad path: ${path}`);
      const inner = path.slice(i + 1, end).trim();
      if (inner.startsWith('"') || inner.startsWith("'")) out.push({ kind: 'key', key: inner.slice(1, -1).replace(/\\"/g, '"') });
      else out.push({ kind: 'index', index: Number(inner) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    out.push({ kind: 'prop', name: path.slice(i, j) });
    i = j;
  }
  tokenCache.set(path, out);
  return out;
}

export interface Resolved {
  owner: Record<string, unknown>;
  key: string;
}

function findByName<T extends { name: string }>(list: T[] | undefined, name: string) {
  return list?.find((x) => x.name === name);
}

/** Resolve the owner/key pair addressed by `path` relative to an object. */
export function resolve(doc: DocumentData, ob: ObjectData, path: string): Resolved | null {
  const tokens = tokenize(path);
  let cur: unknown = ob;
  let ctx: 'object' | 'pose' | 'shape_keys' | 'tree' | 'node' | 'generic' = 'object';
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t],
      last = t === tokens.length - 1;
    if (cur == null) return null;
    if (tok.kind === 'prop') {
      if (ctx === 'object' && tok.name === 'data') {
        cur = dataBlock(doc, ob);
        ctx = 'generic';
        continue;
      }
      if (ctx === 'object' && tok.name === 'pose') {
        cur = ob.pose;
        ctx = 'pose';
        continue;
      }
      if (ctx === 'pose' && tok.name === 'bones') continue;
      if (tok.name === 'shape_keys') {
        ctx = 'shape_keys';
        continue;
      }
      if (ctx === 'shape_keys' && tok.name === 'key_blocks') {
        cur = (cur as { shape_keys: unknown }).shape_keys;
        continue;
      }
      if (ctx === 'object' && tok.name === 'material') {
        const me = dataBlock(doc, ob) as { materials?: (string | null)[] } | null;
        const mid = me?.materials?.[ob.active_material_index] ?? me?.materials?.[0];
        cur = mid ? doc.materials[mid] : null;
        ctx = 'generic';
        continue;
      }
      if (tok.name === 'nodes' && cur && typeof cur === 'object' && 'tree' in (cur as object)) {
        cur = (cur as { tree: { nodes: unknown } }).tree.nodes;
        ctx = 'tree';
        continue;
      }
      if (ctx === 'node' && tok.name === 'inputs') {
        cur = (cur as { inputs: unknown }).inputs;
        ctx = 'generic';
        // the following ["Name"] token selects a key; `.default_value` is then a no-op
        const next = tokens[t + 1];
        if (next?.kind === 'key') {
          t++;
          if (t === tokens.length - 1 || tokens[t + 1]?.kind === 'prop') {
            const after = tokens[t + 1];
            if (!after || (after.kind === 'prop' && after.name === 'default_value'))
              return { owner: cur as Record<string, unknown>, key: next.key };
          }
        }
        continue;
      }
      if (last) return { owner: cur as Record<string, unknown>, key: tok.name };
      cur = (cur as Record<string, unknown>)[tok.name];
      continue;
    }
    if (tok.kind === 'key') {
      if (ctx === 'pose') {
        const pb = (cur as Record<string, unknown>)[tok.key];
        if (last) return { owner: cur as Record<string, unknown>, key: tok.key };
        cur = pb;
        ctx = 'generic';
        continue;
      }
      if (ctx === 'tree') {
        cur = findByName(cur as { name: string }[], tok.key);
        ctx = 'node';
        continue;
      }
      if (Array.isArray(cur)) {
        cur = findByName(cur as { name: string }[], tok.key);
        continue;
      }
      if (last) {
        // ["name"] on a data-block or struct addresses its custom property
        const rec = cur as Record<string, unknown>;
        const custom = rec.custom as Record<string, unknown> | undefined;
        if (!(tok.key in rec) && custom && typeof custom === 'object' && tok.key in custom) return { owner: custom, key: tok.key };
        return { owner: rec, key: tok.key };
      }
      cur = (cur as Record<string, unknown>)[tok.key];
      continue;
    }
    if (tok.kind === 'index') {
      if (last) return { owner: cur as Record<string, unknown>, key: String(tok.index) };
      cur = (cur as unknown[])[tok.index];
    }
  }
  return null;
}

export function dataBlock(doc: DocumentData, ob: ObjectData): Record<string, unknown> | null {
  if (!ob.data) return null;
  const table: Record<string, Record<string, unknown>> = {
    MESH: doc.meshes,
    CURVE: doc.curves,
    FONT: doc.curves,
    LIGHT: doc.lights,
    CAMERA: doc.cameras,
    ARMATURE: doc.armatures,
    LATTICE: doc.lattices,
  } as unknown as Record<string, Record<string, unknown>>;
  return (table[ob.type]?.[ob.data] as Record<string, unknown>) ?? null;
}

export function getValue(doc: DocumentData, ob: ObjectData, path: string, index = -1): unknown {
  const r = resolve(doc, ob, path);
  if (!r) return undefined;
  const v = r.owner[r.key];
  if (index >= 0 && v && typeof v === 'object') return (v as ArrayLike<unknown>)[index];
  return v;
}

export function setValue(doc: DocumentData, ob: ObjectData, path: string, index: number, value: unknown): boolean {
  const r = resolve(doc, ob, path);
  if (!r) return false;
  const cur = r.owner[r.key];
  if (index >= 0 && cur && typeof cur === 'object') {
    (cur as unknown[])[index] = value;
    return true;
  }
  if (typeof cur === 'boolean') r.owner[r.key] = typeof value === 'number' ? value >= 0.5 : !!value;
  else if (typeof cur === 'number' && typeof value === 'number' && Number.isInteger(cur) && isIntProp(r.key)) r.owner[r.key] = Math.round(value);
  else r.owner[r.key] = value;
  return true;
}

const intProps = new Set(['levels', 'render_levels', 'iterations', 'count', 'segments', 'resolution_u', 'bevel_resolution']);
function isIntProp(key: string) {
  return intProps.has(key);
}

/** Human readable label for an F-Curve channel, e.g. "X Location". */
export function channelLabel(path: string, index: number): string {
  const xyz = ['X', 'Y', 'Z', 'W'];
  const wxyz = ['W', 'X', 'Y', 'Z'];
  const rgba = ['R', 'G', 'B', 'A'];
  const tail = path.split('.').pop() ?? path;
  const nice: Record<string, [string, string[]]> = {
    location: ['Location', xyz],
    rotation_euler: ['Euler Rotation', xyz],
    rotation_quaternion: ['Quaternion Rotation', wxyz],
    rotation_axis_angle: ['Axis-Angle Rotation', ['W', 'X', 'Y', 'Z']],
    scale: ['Scale', xyz],
    delta_location: ['Delta Location', xyz],
    color: ['Color', rgba],
    energy: ['Power', []],
    lens: ['Focal Length', []],
    value: ['Value', []],
    default_value: ['Default Value', rgba],
  };
  const m = /\["([^"]+)"\]/.exec(path);
  const prefix = m ? `${m[1]} ` : '';
  const entry = nice[tail.replace(/\[.*$/, '')];
  if (entry) return `${entry[1][index] ? entry[1][index] + ' ' : ''}${prefix}${entry[0]}`.trim();
  const name = tail.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${index >= 0 && path !== 'hide_viewport' ? (xyz[index] ?? index) + ' ' : ''}${prefix}${name}`.trim();
}
