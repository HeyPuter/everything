// Row filters, sorting and text export for the spreadsheet (pure functions, no DOM).
import type { Column } from './data';

export type FilterOp = 'EQUAL' | 'GREATER' | 'LESS';

export interface RowFilter {
  enabled: boolean;
  /** UI: rule box expanded */
  expanded: boolean;
  column: string;
  operation: FilterOp;
  /** numeric value (one entry per component; rotations in radians) */
  value: number[];
  /** text pattern for string columns (* and ? wildcards) */
  text: string;
  bool: boolean;
  /** tolerance of EQUAL on float values (distance for vectors and colors) */
  threshold: number;
}

export function newRowFilter(column = ''): RowFilter {
  return { enabled: true, expanded: true, column, operation: 'EQUAL', value: [0, 0, 0, 1], text: '', bool: true, threshold: 0.01 };
}

export interface SortSpec {
  column: string;
  /** 1 ascending, -1 descending */
  dir: 1 | -1;
  /** component to sort vectors by; -1 sorts by length */
  comp: number;
}

const isFloatType = (t: Column['type']) => t === 'FLOAT' || t === 'FLOAT2' || t === 'FLOAT_VECTOR' || t === 'FLOAT_COLOR' || t === 'QUATERNION' || t === 'FLOAT4X4';

/** Operations a column supports in a filter. */
export function filterOps(c: Column): FilterOp[] {
  if (c.type === 'BOOLEAN' || c.type === 'STRING' || c.type === 'FLOAT4X4') return ['EQUAL'];
  return ['EQUAL', 'GREATER', 'LESS'];
}

function globToRegExp(p: string): RegExp {
  const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** A predicate for one rule on one column, or null when the rule can't apply to it. */
export function rowPredicate(c: Column, f: RowFilter): ((i: number) => boolean) | null {
  if (c.type === 'STRING') {
    const data = c.data as string[];
    if (!f.text) return null;
    const re = /[*?]/.test(f.text) ? globToRegExp(f.text) : null;
    return re ? (i) => re.test(data[i] ?? '') : (i) => (data[i] ?? '') === f.text;
  }
  const d = c.data as ArrayLike<number>;
  const n = c.comps;
  if (c.type === 'BOOLEAN') {
    const want = f.bool;
    return (i) => !!d[i] === want;
  }
  const v = f.value;
  const op = f.operation;
  if (n === 1) {
    const x = v[0] ?? 0;
    if (op === 'GREATER') return (i) => d[i] > x;
    if (op === 'LESS') return (i) => d[i] < x;
    if (isFloatType(c.type)) {
      const t = Math.max(0, f.threshold);
      return (i) => Math.abs(d[i] - x) <= t;
    }
    return (i) => d[i] === x;
  }
  if (op === 'GREATER' || op === 'LESS') {
    const gt = op === 'GREATER';
    return (i) => {
      for (let k = 0; k < n; k++) {
        const a = d[i * n + k],
          b = v[k] ?? 0;
        if (gt ? !(a > b) : !(a < b)) return false;
      }
      return true;
    };
  }
  if (!isFloatType(c.type)) {
    return (i) => {
      for (let k = 0; k < n; k++) if (d[i * n + k] !== (v[k] ?? 0)) return false;
      return true;
    };
  }
  const t2 = Math.max(0, f.threshold) ** 2;
  return (i) => {
    let s = 0;
    for (let k = 0; k < n; k++) {
      const e = d[i * n + k] - (v[k] ?? 0);
      s += e * e;
    }
    return s <= t2;
  };
}

/**
 * Indices of the rows that pass every enabled filter whose column exists, in `base` order
 * (all rows when base is null).
 */
export function filterRows(cols: Column[], count: number, filters: RowFilter[], base: Int32Array | null = null): Int32Array {
  const preds: ((i: number) => boolean)[] = [];
  for (const f of filters) {
    if (!f.enabled) continue;
    const c = cols.find((x) => x.name === f.column);
    if (!c) continue;
    const p = rowPredicate(c, f);
    if (p) preds.push(p);
  }
  if (!preds.length) {
    if (base) return base;
    const all = new Int32Array(count);
    for (let i = 0; i < count; i++) all[i] = i;
    return all;
  }
  const out = new Int32Array(base ? base.length : count);
  let m = 0;
  const n = base ? base.length : count;
  outer: for (let r = 0; r < n; r++) {
    const i = base ? base[r] : r;
    for (const p of preds) if (!p(i)) continue outer;
    out[m++] = i;
  }
  return out.slice(0, m);
}

/** Sort key per row for a column (component or length for vectors; text order for strings). */
export function sortRows(rows: Int32Array, c: Column, spec: SortSpec): Int32Array {
  const out = Int32Array.from(rows);
  const dir = spec.dir;
  if (c.type === 'STRING') {
    const data = c.data as string[];
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const idx = Array.from(out);
    idx.sort((a, b) => dir * coll.compare(data[a] ?? '', data[b] ?? '') || a - b);
    return Int32Array.from(idx);
  }
  const d = c.data as ArrayLike<number>;
  const n = c.comps;
  const comp = Math.min(spec.comp, n - 1);
  const key = new Float64Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r];
    if (comp < 0) {
      let s = 0;
      for (let k = 0; k < n; k++) s += d[i * n + k] ** 2;
      key[r] = Math.sqrt(s);
    } else key[r] = d[i * n + comp];
  }
  const order = new Int32Array(rows.length);
  for (let r = 0; r < order.length; r++) order[r] = r;
  // stable: ties keep their original order
  order.sort((a, b) => dir * (key[a] - key[b]) || a - b);
  for (let r = 0; r < order.length; r++) out[r] = rows[order[r]];
  return out;
}

const fmt = (v: number, digits = 3) => {
  if (!Number.isFinite(v)) return String(v);
  const s = v.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
};

/** Values of one cell as text fields (one per component). Rotations are shown in degrees. */
export function cellValues(c: Column, i: number, digits = 3): string[] {
  const d = c.data;
  if (c.type === 'STRING') return [(d as string[])[i] ?? ''];
  const a = d as ArrayLike<number>;
  if (c.type === 'BOOLEAN') return [a[i] ? 'True' : 'False'];
  if (c.type === 'INT' || c.type === 'INT8' || c.type === 'INT2') {
    const out: string[] = [];
    for (let k = 0; k < c.comps; k++) out.push(String(a[i * c.comps + k]));
    return out;
  }
  const out: string[] = [];
  for (let k = 0; k < c.comps; k++) {
    const v = a[i * c.comps + k];
    out.push(c.type === 'QUATERNION' ? `${fmt((v * 180) / Math.PI, digits)}°` : fmt(v, digits));
  }
  return out;
}

/** Component suffixes used for column headers in exported text. */
export function componentNames(c: Column): string[] {
  if (c.comps === 1) return [''];
  if (c.type === 'FLOAT_COLOR') return ['r', 'g', 'b', 'a'].slice(0, c.comps);
  if (c.type === 'FLOAT4X4') return Array.from({ length: 16 }, (_, k) => `[${k % 4}][${Math.floor(k / 4)}]`);
  if (c.type === 'INT2') return ['0', '1'];
  return ['x', 'y', 'z', 'w'].slice(0, c.comps);
}

/** Tab-separated text of a block of rows/columns (components in their own columns). */
export function toTSV(cols: Column[], rows: ArrayLike<number>, opts: { header?: boolean; index?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.header) {
    const head: string[] = opts.index ? ['index'] : [];
    for (const c of cols) for (const s of componentNames(c)) head.push(s ? `${c.name}.${s}` : c.name);
    lines.push(head.join('\t'));
  }
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r];
    const cells: string[] = opts.index ? [String(i)] : [];
    for (const c of cols) cells.push(...cellValues(c, i, c.type === 'FLOAT4X4' ? 4 : 6).map((s) => s.replace(/°$/, '')));
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}
