// Units and numbers as the assistant sees them. The document stores
// millimetres and degrees; the model reads and writes lengths in the part's
// display unit (mm, cm, m or in), so a tool argument of 25 in an inch part is
// 25 inches. Parameters may also be expressions ("=Width/2") or values with an
// explicit unit ("12mm", "0.5in").

import type { Vec2, Vec3 } from '../math/vec';
import type { DocStore } from '../model/document';
import { ExprError, evaluate, evaluateVariables } from '../model/expr';
import type { Param } from '../model/types';
import { UNIT_SYSTEMS } from '../model/units';

export type Kind = 'length' | 'angle' | 'count';

/** Thrown for arguments the model must correct; the message is sent back to it. */
export class ToolError extends Error {}

/** Shortest decimal text, at most `digits` decimals, never "-0". */
export function num(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return String(v);
  const s = Number(v.toFixed(digits)).toString();
  return s === '-0' ? '0' : s;
}

/** Like num, but a value under 1 keeps six significant digits (a part's volume in m³ is not 0). */
export function qty(v: number, digits: number): string {
  return Math.abs(v) >= 1 || v === 0 || !Number.isFinite(v) ? num(v, digits) : String(Number(v.toPrecision(6)));
}

export class Units {
  /** Told when an expression over variables is taken as its value now (coordinates and shape sizes do not stay linked). */
  onUnlinked: ((what: string, expr: string, mm: number) => void) | null = null;

  constructor(private store: DocStore) {}

  get scale(): number {
    return UNIT_SYSTEMS[this.store.doc.units].scale;
  }

  get unit(): string {
    return UNIT_SYSTEMS[this.store.doc.units].length;
  }

  /** A length in mm as display-unit text. */
  len(mm: number, withUnit = false): string {
    // A ten-thousandth of a millimetre in every unit (metres need 7 decimals, not 5).
    const s = num(mm / this.scale, 4 + Math.max(0, Math.round(Math.log10(this.scale))));
    return withUnit ? `${s} ${this.unit}` : s;
  }

  area(mm2: number): string {
    return `${qty(mm2 / this.scale ** 2, 3)} ${this.unit}²`;
  }

  volume(mm3: number): string {
    return `${qty(mm3 / this.scale ** 3, 3)} ${this.unit}³`;
  }

  pt(p: Vec3 | Vec2): string {
    return `(${p.map((v) => this.len(v)).join(', ')})`;
  }

  /** Unit vector text; axis-aligned ones as ±X/±Y/±Z. */
  dir(v: Vec3): string {
    const names = ['X', 'Y', 'Z'];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(Math.abs(v[i]) - 1) < 1e-6) return `${v[i] > 0 ? '+' : '-'}${names[i]}`;
    }
    return `(${v.map((x) => num(x, 4)).join(', ')})`;
  }

  /** A stored parameter as the model sees it: a number in display units (or degrees), or the expression. */
  param(p: Param, kind: Kind): number | string {
    if (typeof p === 'string') return p;
    return kind === 'length' ? Number(num(p / this.scale, 6)) : Number(num(p, 6));
  }

  /** Evaluated value of a stored parameter, as display text with unit. */
  paramText(p: Param, kind: Kind): string {
    let v: number;
    try {
      v = this.store.evalParam(p, kind);
    } catch (e) {
      return `error (${(e as Error).message})`;
    }
    const shown = kind === 'length' ? this.len(v, true) : kind === 'angle' ? `${num(v)}°` : String(v);
    return typeof p === 'string' ? `${shown} (${p})` : shown;
  }

  /**
   * A parameter from a tool argument: numbers are display units (degrees for
   * angles); strings are expressions over the global variables or values with
   * a unit. Expressions that use variables are kept so they stay linked.
   */
  parseParam(v: unknown, kind: Kind, what: string): Param {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new ToolError(`${what}: not a finite number`);
      if (kind === 'count') return Math.round(v);
      return kind === 'length' ? v * this.scale : v;
    }
    if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${what}: expected a number or an expression`);
    const text = v.trim().replace(/^=\s*/, '');
    const evalKind = kind === 'count' ? 'none' : kind;
    const bareScale = kind === 'length' ? this.scale : 1;
    // Plain values ("12", "12mm", "0.5in", "2*pi") need no variables.
    try {
      const r = evaluate(text, { kind: evalKind, bareScale });
      return kind === 'count' ? Math.round(r) : r;
    } catch { /* may use variables */ }
    const { values, errors } = evaluateVariables(this.store.doc.variables);
    try {
      evaluate(text, { kind: evalKind, bareScale, lookup: (n) => values.get(n) });
    } catch (e) {
      const bad = [...errors.keys()];
      throw new ToolError(`${what}: ${(e as ExprError).message}${bad.length ? ` (variables with errors: ${bad.join(', ')})` : ''}`);
    }
    return `=${text}`;
  }

  /** A coordinate in display units to mm. */
  coord(v: unknown, what: string): number {
    if (typeof v === 'string' && v.trim()) {
      const p = this.parseParam(v, 'length', what);
      if (typeof p === 'number') return p;
      const mm = this.store.evalParam(p, 'length');
      this.onUnlinked?.(what, p, mm);
      return mm;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`${what}: expected a number`);
    return v * this.scale;
  }

  /** A point [x, y] (sketch) or [x, y, z] (world), converted to mm. */
  point(v: unknown, what: string): number[] {
    let arr: unknown[] | null = null;
    if (Array.isArray(v)) arr = v;
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      arr = 'z' in o ? [o.x, o.y, o.z] : [o.x, o.y];
    }
    if (!arr || (arr.length !== 2 && arr.length !== 3)) throw new ToolError(`${what}: expected [x, y] in sketch coordinates or [x, y, z] in world coordinates`);
    return arr.map((c, i) => this.coord(c, `${what}[${i}]`));
  }

  /** A positive length in display units to mm (not an expression). */
  size(v: unknown, what: string): number {
    const mm = this.coord(v, what);
    if (!(mm > 0)) throw new ToolError(`${what}: must be greater than zero`);
    return mm;
  }
}
