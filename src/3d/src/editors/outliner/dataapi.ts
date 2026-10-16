// Outliner ▸ Data API display mode: every data-block of the file and all of its properties as a
// tree, with values shown (and editable) in a column. Rows of animatable object properties can
// be added to keying sets or get drivers (outliner.keyingset_* / outliner.drivers_*).
import type { DocumentData } from '../../data/types';
import { isReadOnly } from '../../library/readonly';
import { ID_GROUPS, OB_ICON, byName, modeBuilders, type RowValue, type TreeNode } from './tree';

/** Where a Data API property row points: data-block table and id, bpy-style data path, index. */
export interface ApiPath {
  table: string;
  id: string;
  path: string;
  index: number;
}

export const encodeApiPath = (p: ApiPath) => [p.table, p.id, p.path, p.index].join('\u0001');
export function decodeApiPath(s: string | undefined): ApiPath | null {
  if (!s) return null;
  const [table, id, path, index] = s.split('\u0001');
  return table && id ? { table, id, path: path ?? '', index: Number(index ?? -1) } : null;
}

const MAX_CHILDREN = 200;
const label = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function allIds(doc: DocumentData): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, table] of ID_GROUPS) for (const r of Object.values((doc[table] ?? {}) as Record<string, { id: string; name: string }>)) out.set(r.id, r.name);
  return out;
}

function valueOf(owner: Record<string, unknown>, key: string, ro: boolean, ids: Map<string, string>): RowValue | undefined {
  const v = owner[key];
  const readonly = ro || isReadOnly(owner) || key === 'id';
  if (typeof v === 'number') return { kind: readonly ? 'readonly' : Number.isInteger(v) && !/(location|rotation|scale|factor|strength|radius|size|value|weight|energy|alpha)/.test(key) ? 'int' : 'number', get: () => owner[key], set: (x) => (owner[key] = x) };
  if (typeof v === 'boolean') return { kind: readonly ? 'readonly' : 'bool', get: () => owner[key], set: (x) => (owner[key] = x) };
  if (key === 'id' && typeof v === 'string') return { kind: 'readonly', get: () => owner[key] };
  if (typeof v === 'string') {
    // references to other data-blocks show the data-block's name and are not typed into
    if (ids.has(v)) return { kind: 'readonly', get: () => `→ ${ids.get(owner[key] as string) ?? owner[key]}` };
    return { kind: readonly ? 'readonly' : 'string', get: () => owner[key], set: (x) => (owner[key] = x) };
  }
  if (v === null || v === undefined) return { kind: 'readonly', get: () => 'None' };
  if (ArrayBuffer.isView(v)) return { kind: 'readonly', get: () => `${v.constructor.name} [${(v as unknown as ArrayLike<number>).length}]` };
  if (Array.isArray(v) && v.length <= 4 && v.every((x) => typeof x === 'number')) return { kind: 'readonly', get: () => `(${(owner[key] as number[]).map((x) => (Number.isInteger(x) ? x : x.toFixed(3))).join(', ')})` };
  if (Array.isArray(v)) return { kind: 'readonly', get: () => `${(owner[key] as unknown[]).length} items` };
  return undefined;
}

function fieldNodes(doc: DocumentData, at: Omit<ApiPath, 'index'>, owner: Record<string, unknown>, ekey: string, depth: number, ro: boolean, ids: Map<string, string>, search: boolean): TreeNode[] {
  if (depth > 12) return [];
  const out: TreeNode[] = [];
  for (const key of Object.keys(owner).slice(0, MAX_CHILDREN)) {
    const v = owner[key];
    if (typeof v === 'function') continue;
    const path = at.path ? `${at.path}.${key}` : key;
    const k = `${ekey}/${key}`;
    const value = valueOf(owner, key, ro, ids);
    let children: () => TreeNode[] = () => [];
    if (!search && v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
      if (Array.isArray(v)) {
        children = () =>
          (v as unknown[]).slice(0, MAX_CHILDREN).map((x, i) => {
            const named = x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : null;
            const sub = named ? `${path}["${named}"]` : `${path}[${i}]`;
            if (x && typeof x === 'object' && !ArrayBuffer.isView(x))
              return { ekey: `${k}/${i}`, kind: 'rna' as const, label: named ?? String(i), icon: 'dot', path: encodeApiPath({ ...at, path: sub, index: -1 }), defaultOpen: false, searchable: false, children: () => fieldNodes(doc, { ...at, path: sub }, x as Record<string, unknown>, `${k}/${i}`, depth + 1, ro || isReadOnly(v), ids, search) };
            return { ekey: `${k}/${i}`, kind: 'rna' as const, label: String(i), icon: 'dot', path: encodeApiPath({ ...at, path, index: i }), value: valueOf(v as unknown as Record<string, unknown>, String(i), ro || isReadOnly(v), ids), defaultOpen: false, searchable: false, children: () => [] };
          });
      } else children = () => fieldNodes(doc, { ...at, path }, v as Record<string, unknown>, k, depth + 1, ro || isReadOnly(v), ids, search);
    }
    const nested = !search && !!v && typeof v === 'object' && !ArrayBuffer.isView(v) && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
    out.push({ ekey: k, kind: 'rna', label: label(key), icon: v && typeof v === 'object' && !ArrayBuffer.isView(v) ? 'properties' : 'dot', path: encodeApiPath({ ...at, path, index: -1 }), value, defaultOpen: false, searchable: depth === 0, hasKids: nested, children });
  }
  return out;
}

modeBuilders.DATA_API = (doc, st) => {
  const ids = allIds(doc);
  const search = !!st.search.trim();
  const groups: TreeNode[] = [];
  const tables: [string, string, string][] = ID_GROUPS.map(([l, t, i]): [string, string, string] => [l, t as string, i]);
  tables.push(['Scenes', 'scenes', 'scene_data']);
  tables.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [lbl, table, ic] of tables) {
    const items: { id: string; name: string }[] = table === 'scenes' ? [{ id: 'scene', name: doc.scene.name }] : Object.values((doc as unknown as Record<string, Record<string, { id: string; name: string }>>)[table] ?? {}).sort(byName);
    if (!items.length) continue;
    groups.push({
      ekey: `api:${table}`,
      kind: 'rna',
      label: lbl,
      icon: ic,
      count: items.length,
      defaultOpen: false,
      hasKids: true,
      children: () =>
        items.map((it) => {
          const rec = (table === 'scenes' ? doc.scene : it) as unknown as Record<string, unknown>;
          const ob = table === 'objects' ? (it as unknown as { type: string }) : null;
          return {
            ekey: `api:${table}:${it.id}`,
            kind: 'rna' as const,
            label: it.name,
            icon: ob ? (OB_ICON[ob.type] ?? 'object') : ic,
            id: it.id,
            table,
            path: encodeApiPath({ table, id: it.id, path: '', index: -1 }),
            defaultOpen: false,
            searchable: true,
            hasKids: !search,
            children: () => fieldNodes(doc, { table, id: it.id, path: '' }, rec, `api:${table}:${it.id}`, 0, false, ids, search),
          };
        }),
    });
  }
  return [{ ekey: 'api', kind: 'rna', label: 'Project Data', icon: 'file_3d', defaultOpen: true, children: () => groups }];
};
