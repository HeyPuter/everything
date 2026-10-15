// Asset catalogs: a tree of named folders identified by stable UUIDs. A library stores a flat
// list of { id, path } entries; every level of a path has its own entry so each folder can be
// renamed, moved and assigned to on its own. All functions here are pure list edits.
import type { AssetCatalog } from './types';

export interface CatalogNode {
  id: string;
  name: string;
  path: string;
  children: CatalogNode[];
}

export function newUUID(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/** Path components cannot contain slashes and are trimmed. */
export function cleanName(name: string) {
  return name.replace(/[/\\:]+/g, '-').trim();
}

export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const joinPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
/** One-line name of a catalog path (its components joined with dashes). */
export const simpleName = (path: string) => path.split('/').join('-');

const isUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** The catalog tree, siblings sorted by name. */
export function catalogTree(cats: AssetCatalog[]): CatalogNode[] {
  const byPath = new Map<string, CatalogNode>();
  const roots: CatalogNode[] = [];
  const sorted = [...cats].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  for (const c of sorted) {
    if (byPath.has(c.path)) continue;
    const node: CatalogNode = { id: c.id, name: nameOf(c.path), path: c.path, children: [] };
    byPath.set(c.path, node);
    const parent = byPath.get(parentOf(c.path));
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: CatalogNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

export function catalogById(cats: AssetCatalog[], id: string) {
  return cats.find((c) => c.id === id);
}

/** Make sure every level of `path` has a catalog; returns the id of the deepest one. */
export function ensureCatalogPath(cats: AssetCatalog[], path: string): string {
  const parts = path.split('/').map(cleanName).filter(Boolean);
  let cur = '';
  let id = '';
  for (const p of parts) {
    cur = joinPath(cur, p);
    let c = cats.find((x) => x.path === cur);
    if (!c) {
      c = { id: newUUID(), path: cur };
      cats.push(c);
    }
    id = c.id;
  }
  return id;
}

function uniqueSibling(cats: AssetCatalog[], parent: string, name: string, except?: string) {
  const taken = new Set(cats.filter((c) => c.id !== except && parentOf(c.path) === parent).map((c) => nameOf(c.path).toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const stem = name.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** Add a catalog under `parentPath` ('' for the top level); returns it. */
export function newCatalog(cats: AssetCatalog[], parentPath = '', name = 'Catalog'): AssetCatalog {
  if (parentPath) ensureCatalogPath(cats, parentPath);
  const c = { id: newUUID(), path: joinPath(parentPath, uniqueSibling(cats, parentPath, cleanName(name) || 'Catalog')) };
  cats.push(c);
  return c;
}

/** Rename a catalog (its sub-catalogs follow); returns the new path or null. */
export function renameCatalog(cats: AssetCatalog[], id: string, name: string): string | null {
  const c = catalogById(cats, id);
  const n = cleanName(name);
  if (!c || !n) return null;
  const parent = parentOf(c.path);
  const to = joinPath(parent, uniqueSibling(cats, parent, n, c.id));
  return reparentPaths(cats, c.path, to);
}

function reparentPaths(cats: AssetCatalog[], from: string, to: string) {
  for (const x of cats) if (isUnder(x.path, from)) x.path = to + x.path.slice(from.length);
  return to;
}

/** Move a catalog (and its sub-catalogs) under another one ('' for the top level). */
export function moveCatalog(cats: AssetCatalog[], id: string, parentId: string | ''): boolean {
  const c = catalogById(cats, id);
  if (!c) return false;
  const parent = parentId ? catalogById(cats, parentId) : null;
  if (parentId && !parent) return false;
  const parentPath = parent?.path ?? '';
  if (isUnder(parentPath, c.path) && parentPath !== '') return false;
  if (parentOf(c.path) === parentPath) return false;
  reparentPaths(cats, c.path, joinPath(parentPath, uniqueSibling(cats, parentPath, nameOf(c.path), c.id)));
  return true;
}

/** Ids of a catalog and all its sub-catalogs. */
export function catalogAndChildren(cats: AssetCatalog[], id: string): Set<string> {
  const c = catalogById(cats, id);
  if (!c) return new Set();
  return new Set(cats.filter((x) => isUnder(x.path, c.path)).map((x) => x.id));
}

/** Delete a catalog and its sub-catalogs; returns the removed ids. */
export function deleteCatalog(cats: AssetCatalog[], id: string): Set<string> {
  const gone = catalogAndChildren(cats, id);
  for (let i = cats.length - 1; i >= 0; i--) if (gone.has(cats[i].id)) cats.splice(i, 1);
  return gone;
}

/**
 * Merge catalogs from another library: entries with the same id are kept, entries with a new id
 * whose path already exists map to the existing catalog. Returns a map from the incoming ids to
 * the ids to use in `into`.
 */
export function mergeCatalogs(into: AssetCatalog[], from: AssetCatalog[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of [...from].sort((a, b) => a.path.length - b.path.length)) {
    const same = catalogById(into, c.id);
    if (same) {
      map.set(c.id, c.id);
      continue;
    }
    const byPath = into.find((x) => x.path === c.path);
    if (byPath) {
      map.set(c.id, byPath.id);
      continue;
    }
    ensureCatalogPath(into, parentOf(c.path));
    into.push({ id: c.id, path: c.path });
    map.set(c.id, c.id);
  }
  return map;
}
