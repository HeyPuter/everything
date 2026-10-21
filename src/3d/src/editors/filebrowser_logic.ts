// File Browser helpers without DOM: categories, sorting, filtering and keyboard selection walking.

export type Category = 'project' | 'image' | 'model' | 'text' | 'other';
export type SortBy = 'ALPHA' | 'EXTENSION' | 'TIME' | 'SIZE';

export interface Entry {
  name: string;
  kind: 'dir' | 'file';
  size?: number;
  mtime?: number;
}

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg|exr|hdr|tga|tiff?)$/i;
export const TEXT_EXT = /\.(py|js|mjs|txt|md|json|glsl|osl|csv)$/i;

export function category(name: string, modelExts: string[]): Category {
  const n = name.toLowerCase();
  if (n.endsWith('.p3d') || n.endsWith('.3d.json') || n.endsWith('.blend')) return 'project';
  if (IMAGE_EXT.test(n)) return 'image';
  if (modelExts.some((x) => n.endsWith(x))) return 'model';
  if (TEXT_EXT.test(n)) return 'text';
  return 'other';
}

export const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** Folders first, then files ordered by the sort key (names as tie breaker). */
export function sortEntries<T extends Entry>(list: T[], by: SortBy, reverse = false): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const key = (a: T, b: T) => {
    if (by === 'EXTENSION') return extOf(a.name).localeCompare(extOf(b.name)) || byName(a, b);
    if (by === 'TIME') return (b.mtime ?? 0) - (a.mtime ?? 0) || byName(a, b);
    if (by === 'SIZE') return (b.size ?? 0) - (a.size ?? 0) || byName(a, b);
    return byName(a, b);
  };
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    const k = key(a, b);
    return reverse ? -k : k;
  });
}

export interface FilterOpts {
  text: string;
  showHidden: boolean;
  /** only show folders and files of these categories (null: everything) */
  categories: Set<Category> | null;
  modelExts: string[];
}

export function filterEntries<T extends Entry>(list: T[], o: FilterOpts): T[] {
  const q = o.text.trim().toLowerCase();
  // simple wildcard support: "*.png"
  const re = q.includes('*') ? new RegExp(`^${q.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : null;
  return list.filter((e) => {
    if (!o.showHidden && e.name.startsWith('.')) return false;
    if (q && !(re ? re.test(e.name.toLowerCase()) : e.name.toLowerCase().includes(q))) return false;
    if (e.kind === 'dir' || !o.categories) return true;
    return o.categories.has(category(e.name, o.modelExts));
  });
}

/**
 * Index reached by an arrow key in a grid of `cols` columns filled row by row
 * (`flow` 'row'), or in columns of `rows` items filled column by column ('column').
 */
export function walkIndex(i: number, count: number, dir: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', cols: number, flow: 'row' | 'column' = 'row', rows = 1): number {
  if (count <= 0) return -1;
  if (i < 0) return dir === 'UP' || dir === 'LEFT' ? count - 1 : 0;
  let d: number;
  if (flow === 'row') d = dir === 'LEFT' ? -1 : dir === 'RIGHT' ? 1 : dir === 'UP' ? -cols : cols;
  else d = dir === 'UP' ? -1 : dir === 'DOWN' ? 1 : dir === 'LEFT' ? -rows : rows;
  const j = i + d;
  if (j < 0 || j >= count) return i;
  return j;
}

/** A name not used in `taken`: "New Folder", "New Folder 2", … */
export function uniqueEntryName(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export function formatSize(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

/** Move an entry of a list (bookmarks) up, down, to the top or bottom; returns its new index. */
export function moveInList<T>(list: T[], i: number, dir: 'TOP' | 'UP' | 'DOWN' | 'BOTTOM'): number {
  if (i < 0 || i >= list.length) return i;
  const j = dir === 'TOP' ? 0 : dir === 'BOTTOM' ? list.length - 1 : dir === 'UP' ? Math.max(0, i - 1) : Math.min(list.length - 1, i + 1);
  const [x] = list.splice(i, 1);
  list.splice(j, 0, x);
  return j;
}
