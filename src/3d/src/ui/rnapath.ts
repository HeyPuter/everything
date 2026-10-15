// Find where a property owner lives in the document: the data-block that holds it, the data path
// from that data-block, and (when it can be animated) the object + path used by F-Curves and
// drivers. Used by the generic property button operations.
import type { DocumentData, ObjectData } from '../data/types';

export interface OwnerLoc {
  /** data-block table ('objects', 'meshes', …, 'scenes' for the scene) */
  table: string;
  /** data-block id ('scene' for the scene) */
  id: string;
  idName: string;
  /** data path from the data-block to the owner ('' when the owner is the data-block itself) */
  path: string;
}

const TABLES = [
  'objects',
  'meshes',
  'curves',
  'lights',
  'cameras',
  'armatures',
  'lattices',
  'materials',
  'worlds',
  'collections',
  'images',
  'actions',
  'node_groups',
  'particles',
  'texts',
  'brushes',
  'grease_pencils',
];
const DATA_TABLE: Record<string, string> = {
  MESH: 'meshes',
  CURVE: 'curves',
  FONT: 'curves',
  LIGHT: 'lights',
  CAMERA: 'cameras',
  ARMATURE: 'armatures',
  LATTICE: 'lattices',
  GREASEPENCIL: 'grease_pencils',
};

const isIdent = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
const q = (s: string) => JSON.stringify(s);

function join(path: string, seg: string) {
  if (!path) return seg.startsWith('[') ? seg : seg;
  return seg.startsWith('[') ? path + seg : `${path}.${seg}`;
}

/** Map our storage keys to the scripting-style names used in data paths. */
function segName(parentKey: string, key: string) {
  if (parentKey === '' && key === 'tree') return 'node_tree';
  return key;
}

let cache: { doc: DocumentData; rev: number; map: Map<object, OwnerLoc> } | null = null;

function buildIndex(doc: DocumentData): Map<object, OwnerLoc> {
  const map = new Map<object, OwnerLoc>();
  const walk = (v: unknown, loc: Omit<OwnerLoc, 'path'>, path: string, parentKey: string, depth: number) => {
    if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || depth > 6) return;
    if (map.has(v)) return;
    if (Array.isArray(v)) {
      if (!v.length || typeof v[0] !== 'object' || v.length > 1024) return;
      v.forEach((x, i) => {
        if (!x || typeof x !== 'object') return;
        const name = (x as { name?: unknown }).name;
        walk(x, loc, path + (typeof name === 'string' ? `[${q(name)}]` : `[${i}]`), '', depth + 1);
      });
      return;
    }
    map.set(v, { ...loc, path });
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!x || typeof x !== 'object' || ArrayBuffer.isView(x)) continue;
      if (k === 'animation_data' || k === 'shape_keys_data') continue;
      if (parentKey === '' && depth === 0 && k === 'pose' && loc.table === 'objects') {
        for (const [bone, pb] of Object.entries(x as Record<string, unknown>)) walk(pb, loc, join(path, `pose.bones[${q(bone)}]`), '', depth + 2);
        continue;
      }
      const seg = segName(depth === 0 ? '' : parentKey, k);
      walk(x, loc, isIdent(seg) ? join(path, seg) : `${path}[${q(seg)}]`, k, depth + 1);
    }
  };
  walk(doc.scene, { table: 'scenes', id: 'scene', idName: doc.scene.name }, '', '', 0);
  for (const t of TABLES) {
    const rec = (doc as unknown as Record<string, Record<string, { id: string; name: string }> | undefined>)[t];
    if (!rec) continue;
    for (const item of Object.values(rec)) walk(item, { table: t, id: item.id, idName: item.name }, '', '', 0);
  }
  return map;
}

/** Where `owner` lives (cached per document revision). */
export function locateOwner(doc: DocumentData, owner: object, revision = 0): OwnerLoc | null {
  if (!cache || cache.doc !== doc || cache.rev !== revision) cache = { doc, rev: revision, map: buildIndex(doc) };
  return cache.map.get(owner) ?? null;
}

/** Full scripting path: bpy.data.objects["Cube"].location[0] */
export function fullDataPath(loc: OwnerLoc, key: string, index?: number): string {
  const base = loc.table === 'scenes' ? `bpy.data.scenes[${q(loc.idName)}]` : `bpy.data.${loc.table}[${q(loc.idName)}]`;
  const p = relDataPath(loc, key);
  return `${base}${p.startsWith('[') ? '' : '.'}${p}${index !== undefined && index >= 0 ? `[${index}]` : ''}`;
}

/** Data path relative to the data-block, e.g. modifiers["Subdivision"].levels */
export function relDataPath(loc: OwnerLoc, key: string): string {
  // node socket values: inputs["Roughness"].default_value
  if (/(^|\.)(inputs|outputs)$/.test(loc.path)) return `${loc.path}[${q(key)}].default_value`;
  return join(loc.path, isIdent(key) ? key : `[${q(key)}]`);
}

/**
 * Object and object-relative path that animate a property, or null when it can't be animated
 * (only object properties and the data / active material / pose bones of an object can).
 */
export function animTarget(doc: DocumentData, loc: OwnerLoc, key: string, prefer?: ObjectData | null): { ob: ObjectData; path: string } | null {
  const rel = relDataPath(loc, key);
  if (loc.table === 'objects') {
    const ob = doc.objects[loc.id];
    return ob ? { ob, path: rel } : null;
  }
  const obs = Object.values(doc.objects);
  const order = prefer ? [prefer, ...obs.filter((o) => o !== prefer)] : obs;
  if (DATA_TABLE_VALUES.has(loc.table)) {
    const ob = order.find((o) => o.data === loc.id && DATA_TABLE[o.type] === loc.table);
    return ob ? { ob, path: `data.${rel}` } : null;
  }
  if (loc.table === 'materials') {
    // only the active material of an object is addressable from the object
    const ob = order.find((o) => {
      const d = o.data ? (doc as unknown as Record<string, Record<string, { materials?: (string | null)[] }>>)[DATA_TABLE[o.type]]?.[o.data] : undefined;
      const mid = d?.materials?.[o.active_material_index] ?? d?.materials?.[0];
      return mid === loc.id;
    });
    if (!ob) return null;
    return { ob, path: `material.${rel.replace(/^node_tree\./, '')}` };
  }
  return null;
}

const DATA_TABLE_VALUES = new Set(Object.values(DATA_TABLE));
