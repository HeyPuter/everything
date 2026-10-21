// Session file store: the files import / export operators read and write by path.
//
// A browser page has no file system, but scripts written for the desktop call
// `bpy.ops.wm.obj_export(filepath="/tmp/a.obj")` and later import that path again. Every
// exported file (and every file the user picked for an import) is kept here under its path so
// those scripts work; the Python runtime mirrors the store into its own file system, so
// `open(path)` sees the same files. Paths are normalised ('\\' → '/', '//' prefix = project
// folder); lookups fall back to the file name alone, then to case-insensitive matches.

export interface StoredFile {
  path: string;
  bytes: Uint8Array;
  /** monotonically increasing write counter (newest wins for name-only lookups) */
  stamp: number;
}

const files = new Map<string, StoredFile>();
let stamp = 0;
/** Keep the store bounded: the oldest files are dropped beyond this many bytes. */
export const VFS_LIMIT = 512 * 1024 * 1024;

/** Other stores that mirror or provide files (the Python runtime's file system). */
export const vfsHooks = {
  written: [] as ((path: string, bytes: Uint8Array) => void)[],
  /** read a file the store does not have (e.g. one a Python script wrote with open()) */
  read: [] as ((path: string) => Uint8Array | null)[],
  removed: [] as ((path: string) => void)[],
};

/** The folder relative paths ('//name', 'name') resolve against. */
export const PROJECT_DIR = '/project';

export function normPath(p: string): string {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (s.startsWith('//')) s = `${PROJECT_DIR}/${s.slice(2)}`;
  else if (/^[a-zA-Z]:\//.test(s)) s = `/${s[0].toLowerCase()}${s.slice(2)}`; // C:/x → /c/x
  else if (!s.startsWith('/')) s = `${PROJECT_DIR}/${s}`;
  const out: string[] = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export const baseOf = (p: string) => normPath(p).split('/').pop() ?? '';
export const dirOf = (p: string) => normPath(p).replace(/\/[^/]*$/, '') || '/';
export const joinPath = (dir: string, name: string) => normPath(`${normPath(dir)}/${name}`);
export const stemOf = (p: string) => baseOf(p).replace(/\.[^.]*$/, '');
export const extOf = (p: string) => (/\.[^./]*$/.exec(baseOf(p))?.[0] ?? '').toLowerCase();

function total() {
  let n = 0;
  for (const f of files.values()) n += f.bytes.length;
  return n;
}

export function vfsWrite(path: string, data: Uint8Array | string): string {
  const p = normPath(path);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  files.set(p, { path: p, bytes, stamp: ++stamp });
  // drop the oldest files beyond the limit (never the one just written)
  if (total() > VFS_LIMIT) {
    const old = [...files.values()].filter((f) => f.path !== p).sort((a, b) => a.stamp - b.stamp);
    for (const f of old) {
      if (total() <= VFS_LIMIT) break;
      files.delete(f.path);
    }
  }
  for (const h of vfsHooks.written) {
    try {
      h(p, bytes);
    } catch {
      // a mirror failing must not fail the write
    }
  }
  return p;
}

/** Exact path first, then a hook (Python files), then the newest file with the same name. */
export function vfsRead(path: string): Uint8Array | null {
  const p = normPath(path);
  const hit = files.get(p);
  if (hit) return hit.bytes;
  for (const h of vfsHooks.read) {
    try {
      const b = h(p);
      if (b) return b;
    } catch {
      // not there
    }
  }
  return vfsFind(baseOf(path))?.bytes ?? null;
}

/** The newest file with this name (case-insensitive), wherever it is stored. */
export function vfsFind(name: string): StoredFile | null {
  const n = String(name ?? '').replace(/^.*[\\/]/, '').toLowerCase();
  if (!n) return null;
  let best: StoredFile | null = null;
  for (const f of files.values()) if (f.path.split('/').pop()!.toLowerCase() === n && (!best || f.stamp > best.stamp)) best = f;
  return best;
}

/** A companion file next to `mainPath` (by relative name), else anywhere by its name. */
export function vfsCompanion(mainPath: string, name: string): Uint8Array | null {
  const rel = String(name).replace(/\\/g, '/');
  if (rel.startsWith('/')) return vfsRead(rel);
  const p = joinPath(dirOf(mainPath), rel);
  return files.get(p)?.bytes ?? vfsRead(p);
}

export const vfsExists = (path: string) => vfsRead(path) !== null;

export function vfsRemove(path: string): boolean {
  const p = normPath(path);
  const ok = files.delete(p);
  if (ok) for (const h of vfsHooks.removed) h(p);
  return ok;
}

export function vfsList(dir?: string): StoredFile[] {
  const all = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (dir === undefined) return all;
  const d = normPath(dir);
  return all.filter((f) => dirOf(f.path) === d);
}

export function vfsClear() {
  files.clear();
}
