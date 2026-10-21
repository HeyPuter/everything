// Shared conversion state for the .blend importer.
import type { DocumentData, ID } from '../../data/types';
import type { BlendFile, BStruct } from './reader';

/** Collects "what was skipped" messages grouped by category. */
export class Warnings {
  private groups = new Map<string, string[]>();
  add(category: string, item = '') {
    let g = this.groups.get(category);
    if (!g) this.groups.set(category, (g = []));
    if (item && !g.includes(item)) g.push(item);
  }
  get size() {
    return this.groups.size;
  }
  has(category: string) {
    return this.groups.has(category);
  }
  list(): string[] {
    const out: string[] = [];
    for (const [cat, items] of this.groups) {
      if (!items.length) out.push(cat);
      else {
        const shown = items.slice(0, 6).join(', ');
        out.push(`${cat}: ${shown}${items.length > 6 ? ` (+${items.length - 6} more)` : ''}`);
      }
    }
    return out;
  }
}

export interface Ctx {
  f: BlendFile;
  doc: DocumentData;
  warn: Warnings;
  /** file format version as a number, e.g. 502 */
  version: number;
  /** converted ID blocks: struct file offset → document id */
  ids: Map<number, ID>;
  /** object struct offset → document object id (pre-assigned before conversion) */
  objectIds: Map<number, ID>;
  /** resolve a referenced object (null if it was not imported) */
  objectRef(s: BStruct | null, what?: string): ID | null;
  image(s: BStruct | null): ID | null;
  material(s: BStruct | null): ID | null;
  collection(s: BStruct | null): ID | null;
}

export const keyOf = (s: BStruct) => s.offset;

/** Stored .blend 4x4 matrix (column-major float[4][4]) → flat array. */
export function mat4(s: BStruct, name: string): number[] | null {
  const v = s.nums(name);
  if (v.length !== 16 || v.some((x) => !Number.isFinite(x))) return null;
  return v;
}

export function finite(v: number, d = 0) {
  return Number.isFinite(v) ? v : d;
}

export function vec3(s: BStruct, name: string, d: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const v = s.nums(name, 3);
  return v.length === 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : [...d];
}
