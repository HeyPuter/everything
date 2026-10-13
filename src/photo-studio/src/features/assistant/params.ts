// Settings schemas the Assistant shows the model and the plan editor, and the
// coercion of the model's arguments into values commands accept. Pure: no
// DOM, no editor; tests cover it directly.
import type { ParamSpec } from '../../imaging/types';

export type Param = {
  key: string;
  type: 'number' | 'integer' | 'string' | 'text' | 'boolean' | 'color' | 'enum' | 'object' | 'point' | 'layer';
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label?: string }[];
  required?: boolean;
  default?: unknown;
  description?: string;
};
export type Coerced = { value: Record<string, unknown>; notes: string[]; problems: string[] };

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500',
  purple: '#800080', violet: '#8a2be2', pink: '#ffc0cb', magenta: '#ff00ff', cyan: '#00ffff', teal: '#008080', navy: '#000080', brown: '#8b4513',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', gold: '#ffd700', beige: '#f5f5dc', maroon: '#800000', olive: '#808000',
};
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
/** "#rrggbb" for a color given as #rgb, #rrggbb, rgb(...), [r, g, b] or a basic color name; undefined otherwise. */
export function parseColor(v: unknown): string | undefined {
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))) return `#${v.slice(0, 3).map(hex2).join('')}`;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  let m = /^#?([0-9a-f]{3})$/.exec(s);
  if (m) return `#${[...m[1]].map((c) => c + c).join('')}`;
  m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => hex2(Number(x))).join('')}`;
  return undefined;
}
/** A number from a number or a numeric string ("12", "12px", "50%", "1,5"). */
export function parseNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*(?:px|%|pt|deg|°)?\s*$/i.exec(v);
  return m ? Number(m[1].replace(',', '.')) : undefined;
}
export function parseBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (['true', 'yes', 'on', '1', 'enabled'].includes(s)) return true;
  if (['false', 'no', 'off', '0', 'disabled'].includes(s)) return false;
  return undefined;
}
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** The option a value names: by value or label, ignoring case, spaces and punctuation. */
export function matchOption(options: NonNullable<Param['options']>, v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v);
  const exact = options.find((o) => o.value === s);
  if (exact) return exact.value;
  const q = squash(s);
  return (options.find((o) => squash(o.value) === q) ?? options.find((o) => o.label && squash(o.label) === q))?.value;
}
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const name = (p: Param) => p.label ?? p.key;

/** Check and convert arguments against a schema. Unknown keys are dropped
 * with a note; out-of-range numbers are clamped with a note; values that
 * cannot be understood (and missing required ones) are problems. */
export function coerceArgs(params: Param[], raw: unknown): Coerced {
  const out: Coerced = { value: {}, notes: [], problems: [] };
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) out.problems.push('The settings must be a set of named values.');
  const byKey = new Map(params.map((p) => [p.key, p]));
  // Keys match case-insensitively ("Radius" for "radius").
  const lower = new Map(params.map((p) => [p.key.toLowerCase(), p]));
  for (const [k, v] of Object.entries(given)) {
    const p = byKey.get(k) ?? lower.get(k.toLowerCase());
    if (!p) {
      out.notes.push(`Ignored the unknown setting “${k}”.`);
      continue;
    }
    if (v === undefined || v === null) continue;
    const r = coerceValue(p, v);
    if (r.problem) out.problems.push(r.problem);
    else out.value[p.key] = r.value;
    if (r.note) out.notes.push(r.note);
  }
  for (const p of params) if (p.required && !(p.key in out.value)) out.problems.push(`${name(p)} is required.`);
  return out;
}

export function coerceValue(p: Param, v: unknown): { value?: unknown; note?: string; problem?: string } {
  switch (p.type) {
    case 'number':
    case 'integer': {
      let n = parseNumber(v);
      if (n === undefined) return { problem: `${name(p)} must be a number (got “${String(v).slice(0, 40)}”).` };
      if (p.type === 'integer') n = Math.round(n);
      if (p.min !== undefined && n < p.min) return { value: p.min, note: `${name(p)} ${fmt(n)} is below the minimum; using ${fmt(p.min)}.` };
      if (p.max !== undefined && n > p.max) return { value: p.max, note: `${name(p)} ${fmt(n)} is above the maximum; using ${fmt(p.max)}.` };
      return { value: n };
    }
    case 'boolean': {
      const b = parseBoolean(v);
      return b === undefined ? { problem: `${name(p)} must be on or off (got “${String(v).slice(0, 40)}”).` } : { value: b };
    }
    case 'color': {
      const c = parseColor(v);
      return c ? { value: c } : { problem: `${name(p)} must be a color such as #ff8800 (got “${String(v).slice(0, 40)}”).` };
    }
    case 'enum': {
      const o = matchOption(p.options ?? [], v);
      return o !== undefined ? { value: o } : { problem: `${name(p)} must be one of ${(p.options ?? []).map((x) => x.value).join(', ')} (got “${String(v).slice(0, 40)}”).` };
    }
    case 'string':
    case 'text':
    case 'layer': {
      if (typeof v === 'object') return { problem: `${name(p)} must be text.` };
      const s = String(v).trim().slice(0, p.type === 'text' ? 4000 : 400);
      return p.required && !s ? { problem: `${name(p)} is required.` } : { value: s };
    }
    case 'point': {
      const o = v as { x?: unknown; y?: unknown };
      const x = parseNumber(o?.x), y = parseNumber(o?.y);
      if (x === undefined || y === undefined) return { problem: `${name(p)} must be a point { x, y } between 0 and 1.` };
      return { value: { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) } };
    }
    case 'object':
      return v && typeof v === 'object' ? { value: v } : { problem: `${name(p)} must be a set of named values.` };
  }
}

/** A filter operation's parameters as Assistant parameters. Pins and paths
 * (drawn on the image) are left out: the plan cannot draw them. */
export function fromParamSpecs(specs: ParamSpec[]): Param[] {
  const out: Param[] = [];
  for (const s of specs) {
    if (s.type === 'number') out.push({ key: s.key, label: s.label, type: Number.isInteger(s.step ?? 1) && Number.isInteger(s.min) ? 'integer' : 'number', min: s.min, max: s.max, step: s.step, unit: s.unit, default: s.default });
    else if (s.type === 'select') out.push({ key: s.key, label: s.label, type: 'enum', options: s.options.map((o) => ({ value: o.value, label: o.label })), default: s.default });
    else if (s.type === 'checkbox') out.push({ key: s.key, label: s.label, type: 'boolean', default: s.default });
    else if (s.type === 'color') out.push({ key: s.key, label: s.label, type: 'color', default: s.default });
    else if (s.type === 'point') out.push({ key: s.key, label: s.label, type: 'point', default: s.default });
  }
  return out;
}

/** A compact schema line per parameter, for the model. */
export function describeParams(params: Param[]): string {
  return params
    .map((p) => {
      const range = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : '';
      const opts = p.options ? ` one of ${p.options.map((o) => o.value).join('|')}` : '';
      const def = p.default !== undefined && typeof p.default !== 'object' ? ` (default ${String(p.default)})` : '';
      return `- ${p.key}: ${p.type === 'enum' ? 'string' : p.type === 'text' ? 'string' : p.type}${range}${p.unit ? ` ${p.unit}` : ''}${opts}${p.required ? ', required' : ''}${def}${p.label && p.label.toLowerCase() !== p.key.toLowerCase() ? ` — ${p.label}` : ''}${p.description ? `. ${p.description}` : ''}`;
    })
    .join('\n');
}

/** Human-readable settings for a plan step ("Radius 4 px, Mode: Soft"). */
export function summarizeArgs(params: Param[], value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const p of params) {
    if (!(p.key in value)) continue;
    const v = value[p.key];
    let text: string;
    if (p.type === 'enum') text = p.options?.find((o) => o.value === v)?.label ?? String(v);
    else if (p.type === 'boolean') text = v ? 'on' : 'off';
    else if (p.type === 'point') text = `${Math.round((v as { x: number }).x * 100)}%, ${Math.round((v as { y: number }).y * 100)}%`;
    else if (p.type === 'object') text = compactJSON(v, 80);
    else if (p.type === 'text' || p.type === 'string') text = `“${String(v).length > 60 ? `${String(v).slice(0, 59)}…` : String(v)}”`;
    else text = `${typeof v === 'number' ? fmt(v) : String(v)}${p.unit ? ` ${p.unit}` : ''}`;
    parts.push(`${p.label ?? p.key} ${text}`);
  }
  return parts.join(', ');
}
export function compactJSON(v: unknown, max = 200) {
  let s: string;
  try {
    s = JSON.stringify(v) ?? '';
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
