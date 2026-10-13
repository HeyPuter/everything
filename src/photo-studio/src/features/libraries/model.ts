// Libraries: named collections of reusable items (colors, gradients,
// patterns, text and layer styles, brushes and graphics) shared by every
// document. Pure data: the index format, the edit operations that change it
// (replayed on the newest stored index, so concurrent edits from other tabs
// or devices merge instead of overwriting each other), validation, search and
// the single-file export format. Binary content (pattern tiles, graphics,
// thumbnails) lives in content-addressed assets named by their SHA-256.

export const ITEM_TYPES = ['color', 'gradient', 'pattern', 'character-style', 'paragraph-style', 'layer-style', 'brush', 'graphic'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const TYPE_LABELS: Record<ItemType, string> = {
  color: 'Colors',
  gradient: 'Gradients',
  pattern: 'Patterns',
  'character-style': 'Character Styles',
  'paragraph-style': 'Paragraph Styles',
  'layer-style': 'Layer Styles',
  brush: 'Brushes',
  graphic: 'Graphics',
};
export const TYPE_SINGULAR: Record<ItemType, string> = {
  color: 'Color',
  gradient: 'Gradient',
  pattern: 'Pattern',
  'character-style': 'Character Style',
  'paragraph-style': 'Paragraph Style',
  'layer-style': 'Layer Style',
  brush: 'Brush',
  graphic: 'Graphic',
};

export type LibraryItem = {
  id: string;
  type: ItemType;
  name: string;
  // ISO 8601 times.
  created: string;
  modified: string;
  // Type-specific settings (JSON): { hex } for colors, { gradient },
  // { width, height } for patterns, { def } for text styles, { style } for
  // layer styles, { preset } for brushes, { width, height, kind, sourceName }
  // for graphics.
  data: Record<string, unknown>;
  // Asset hashes by role: "content" (pattern tile PNG, graphic project or
  // image) and "thumb" (a small PNG preview).
  assets?: Record<string, string>;
  // When the item was last moved or reordered (ISO time): an older move
  // replayed later never undoes a newer one.
  moved?: string;
};
export type Library = {
  id: string;
  name: string;
  created: string;
  modified: string;
  items: LibraryItem[];
  // Times of the last rename and the last reorder (see `LibraryItem.moved`).
  named?: string;
  moved?: string;
};
export type LibraryIndex = {
  version: 1;
  // Incremented on every stored write; `writer` identifies the last writer.
  revision: number;
  writer?: string;
  libraries: Library[];
  // Deleted library and item IDs (with the time), so a stale copy elsewhere
  // does not bring them back when it syncs.
  deleted: Record<string, string>;
};
export const emptyIndex = (): LibraryIndex => ({ version: 1, revision: 0, libraries: [], deleted: {} });

/** One edit. Operations are idempotent and refer to IDs only, so replaying
 * them on a newer index than the one they were made on merges both edits. */
export type LibraryOp =
  | { op: 'create-library'; library: Library }
  | { op: 'rename-library'; id: string; name: string; at: string }
  | { op: 'delete-library'; id: string; at: string }
  | { op: 'move-library'; id: string; before?: string; at?: string }
  | { op: 'put-item'; library: string; item: LibraryItem; before?: string }
  | { op: 'delete-item'; library: string; id: string; at: string }
  | { op: 'move-item'; from: string; to: string; id: string; before?: string; at: string };
export type QueuedOp = LibraryOp & { opId: string };

export const MAX_LIBRARIES = 200;
export const MAX_ITEMS = 2000;
const MAX_TOMBSTONES = 5000;

function insertBefore<T extends { id: string }>(list: T[], value: T, before?: string) {
  const at = before ? list.findIndex((x) => x.id === before) : -1;
  if (at < 0) list.push(value);
  else list.splice(at, 0, value);
}
function tomb(index: LibraryIndex, id: string, at: string) {
  index.deleted[id] = at;
  const keys = Object.keys(index.deleted);
  if (keys.length > MAX_TOMBSTONES) for (const k of keys.sort((a, b) => index.deleted[a].localeCompare(index.deleted[b])).slice(0, keys.length - MAX_TOMBSTONES)) delete index.deleted[k];
}

/** Apply operations to a copy of `index` (in order). */
export function applyOps(index: LibraryIndex, ops: readonly LibraryOp[]): LibraryIndex {
  const out: LibraryIndex = structuredClone(index);
  for (const o of ops) applyOp(out, o);
  return out;
}
function applyOp(index: LibraryIndex, o: LibraryOp) {
  const lib = (id: string) => index.libraries.find((l) => l.id === id);
  // Item IDs are unique across libraries: every operation finds an item
  // wherever it is now, so replaying an edit never makes a second copy.
  const locate = (id: string) => {
    for (const l of index.libraries) {
      const i = l.items.findIndex((x) => x.id === id);
      if (i >= 0) return { l, i };
    }
  };
  switch (o.op) {
    case 'create-library': {
      if (index.deleted[o.library.id] || lib(o.library.id) || index.libraries.length >= MAX_LIBRARIES) return;
      const copy = structuredClone(o.library);
      copy.items = copy.items.filter((i) => !index.deleted[i.id] && !locate(i.id));
      index.libraries.push(copy);
      return;
    }
    case 'rename-library': {
      const l = lib(o.id);
      // The later rename wins.
      if (l && o.at >= (l.named ?? '')) Object.assign(l, { name: o.name, named: o.at, modified: maxTime(l.modified, o.at) });
      return;
    }
    case 'delete-library': {
      index.libraries = index.libraries.filter((l) => l.id !== o.id);
      tomb(index, o.id, o.at);
      return;
    }
    case 'move-library': {
      const l = lib(o.id);
      if (!l || o.before === o.id) return;
      // The later move wins; replaying one already applied changes nothing.
      if (o.at !== undefined) {
        if (l.moved !== undefined && o.at <= l.moved) return;
        l.moved = o.at;
      }
      index.libraries = index.libraries.filter((x) => x !== l);
      insertBefore(index.libraries, l, o.before);
      return;
    }
    case 'put-item': {
      if (index.deleted[o.item.id]) return;
      const found = locate(o.item.id);
      if (found) {
        // Content changes where the item is now; an older copy never
        // replaces a newer one, and its placement time is kept.
        const cur = found.l.items[found.i];
        if (o.item.modified >= cur.modified) {
          const next = structuredClone(o.item);
          const moved = latest(cur.moved, o.item.moved);
          if (moved === undefined) delete next.moved;
          else next.moved = moved;
          found.l.items[found.i] = next;
        }
        found.l.modified = maxTime(found.l.modified, o.item.modified);
        return;
      }
      const l = lib(o.library);
      if (!l) return;
      if (l.items.length < MAX_ITEMS) insertBefore(l.items, structuredClone(o.item), o.before);
      l.modified = maxTime(l.modified, o.item.modified);
      return;
    }
    case 'delete-item': {
      for (const l of index.libraries) {
        if (!l.items.some((x) => x.id === o.id)) continue;
        l.items = l.items.filter((x) => x.id !== o.id);
        l.modified = maxTime(l.modified, o.at);
      }
      tomb(index, o.id, o.at);
      return;
    }
    case 'move-item': {
      const found = locate(o.id);
      const to = lib(o.to);
      if (!found || !to || o.before === o.id) return;
      const from = found.l,
        item = from.items[found.i];
      // The later move wins; replaying one already applied changes nothing.
      if (item.moved !== undefined && o.at <= item.moved) return;
      if (to !== from && to.items.length >= MAX_ITEMS) return;
      from.items = from.items.filter((x) => x !== item);
      item.moved = o.at;
      insertBefore(to.items, item, o.before);
      from.modified = maxTime(from.modified, o.at);
      to.modified = maxTime(to.modified, o.at);
      return;
    }
  }
}
const latest = (a: string | undefined, b: string | undefined) => (a === undefined ? b : b === undefined ? a : maxTime(a, b));
const maxTime = (a: string, b: string) => (a > b ? a : b);

/** Every asset hash an index refers to. */
export function referencedAssets(index: LibraryIndex): Set<string> {
  const out = new Set<string>();
  for (const l of index.libraries) for (const i of l.items) for (const h of Object.values(i.assets ?? {})) out.add(h);
  return out;
}

export function findItem(index: LibraryIndex, id: string): { library: Library; item: LibraryItem } | undefined {
  for (const library of index.libraries) {
    const item = library.items.find((x) => x.id === id);
    if (item) return { library, item };
  }
}

/** Items matching a search (name, type label or color value), case-insensitive. */
export function searchItems(items: LibraryItem[], query: string): LibraryItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((i) => {
    const hay = `${i.name} ${TYPE_SINGULAR[i.type]} ${TYPE_LABELS[i.type]} ${typeof i.data.hex === 'string' ? i.data.hex : ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
/** Items grouped by type in the panel's order (empty groups omitted). */
export function groupByType(items: LibraryItem[]): [ItemType, LibraryItem[]][] {
  return ITEM_TYPES.map((t) => [t, items.filter((i) => i.type === t)] as [ItemType, LibraryItem[]]).filter(([, list]) => list.length > 0);
}
/** A name not used by `taken` ("Blue", "Blue 2", ...). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const base = name.trim() || 'Untitled';
  if (!used.has(base.toLowerCase())) return base;
  const stem = base.replace(/\s+\d+$/, '');
  for (let n = 2; ; n++) if (!used.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`;
}

// ----- Validation -----
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const isTime = (v: unknown) => str(v, 64);
const isHash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export function validItem(v: unknown): v is LibraryItem {
  if (!v || typeof v !== 'object') return false;
  const i = v as LibraryItem;
  return (
    str(i.id, 128) && !!i.id && (ITEM_TYPES as readonly string[]).includes(i.type) && str(i.name, 256) && isTime(i.created) && isTime(i.modified) && (i.moved === undefined || isTime(i.moved)) &&
    !!i.data && typeof i.data === 'object' && !Array.isArray(i.data) &&
    (i.assets === undefined || (typeof i.assets === 'object' && !!i.assets && Object.entries(i.assets).every(([k, h]) => str(k, 32) && isHash(h)))) &&
    (i.type !== 'color' || (typeof i.data.hex === 'string' && /^#[0-9a-f]{6}$/i.test(i.data.hex)))
  );
}
export function validLibrary(v: unknown): v is Library {
  if (!v || typeof v !== 'object') return false;
  const l = v as Library;
  return str(l.id, 128) && !!l.id && str(l.name, 256) && isTime(l.created) && isTime(l.modified) && (l.named === undefined || isTime(l.named)) && (l.moved === undefined || isTime(l.moved)) && Array.isArray(l.items) && l.items.length <= MAX_ITEMS && l.items.every(validItem);
}
/** A stored index, or undefined when it is not one (callers start empty). */
export function validIndex(v: unknown): LibraryIndex | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const x = v as LibraryIndex;
  if (x.version !== 1 || !Number.isInteger(x.revision) || x.revision < 0 || !Array.isArray(x.libraries) || x.libraries.length > MAX_LIBRARIES) return undefined;
  if (!x.libraries.every(validLibrary)) return undefined;
  const deleted = x.deleted && typeof x.deleted === 'object' && !Array.isArray(x.deleted) ? x.deleted : {};
  // An item ID appears once (older versions could store a replayed item
  // twice): later copies are dropped.
  const seen = new Set<string>();
  const libraries = x.libraries.map((l) => {
    const items = l.items.filter((i) => !seen.has(i.id) && !!seen.add(i.id));
    return items.length === l.items.length ? l : { ...l, items };
  });
  return { version: 1, revision: x.revision, ...(typeof x.writer === 'string' ? { writer: x.writer } : {}), libraries, deleted: Object.fromEntries(Object.entries(deleted).filter(([k, t]) => str(k, 128) && isTime(t))) };
}

// ----- Single-file export -----
export const LIBRARY_FILE_FORMAT = 'photo-studio-library';
export const LIBRARY_FILE_EXTENSION = '.pslib';
export type LibraryFile = {
  format: typeof LIBRARY_FILE_FORMAT;
  version: 1;
  exported: string;
  library: Library;
  // Asset bytes as base64 with their media type.
  assets: Record<string, { type: string; data: string }>;
};
const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function exportLibraryFile(library: Library, readAsset: (hash: string) => Promise<Blob | undefined>, now = new Date()): Promise<string> {
  const assets: LibraryFile['assets'] = {};
  for (const item of library.items)
    for (const h of Object.values(item.assets ?? {})) {
      if (assets[h]) continue;
      const blob = await readAsset(h);
      if (blob) assets[h] = { type: blob.type || 'application/octet-stream', data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
    }
  const file: LibraryFile = { format: LIBRARY_FILE_FORMAT, version: 1, exported: now.toISOString(), library, assets };
  return JSON.stringify(file);
}

/** Read a library file. The library gets new IDs (an import is a copy) and
 * assets are checked against their hashes. */
export async function importLibraryFile(text: string, hash: (bytes: Uint8Array) => Promise<string>, now = new Date()): Promise<{ library: Library; assets: Map<string, Blob>; skipped: number }> {
  let v: LibraryFile;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('This is not a library file.');
  }
  if (!v || v.format !== LIBRARY_FILE_FORMAT || v.version !== 1 || !validLibrary(v.library)) throw new Error('This is not a library file, or it was made by a newer version.');
  const assets = new Map<string, Blob>();
  for (const [h, a] of Object.entries(v.assets ?? {})) {
    if (!isHash(h) || !a || typeof a.data !== 'string' || typeof a.type !== 'string') continue;
    const bytes = fromBase64(a.data);
    if ((await hash(bytes)) === h) assets.set(h, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: a.type }));
  }
  const at = now.toISOString();
  let skipped = 0;
  const items = v.library.items.filter((i) => {
    // Items whose content did not arrive intact are left out.
    const ok = Object.values(i.assets ?? {}).every((h) => assets.has(h));
    if (!ok) skipped++;
    return ok;
  });
  const library: Library = {
    id: newId(),
    name: v.library.name,
    created: at,
    modified: at,
    items: items.map(({ moved: _moved, ...i }) => ({ ...i, id: newId(), modified: at })),
  };
  return { library, assets, skipped };
}
export const newId = () => crypto.randomUUID();
