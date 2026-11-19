// Value parsing and commit planning for the Properties panel fields: typed
// numbers with optional units and simple arithmetic, linked width and height,
// angles and canvas resizes. Pure functions, so the rules are unit tested.
import { fromPixels, toPixels, type LengthUnit } from '../transform/math';

export const UNIT_SUFFIX: Record<LengthUnit, string> = {
  px: 'px',
  percent: '%',
  in: 'in',
  cm: 'cm',
  mm: 'mm',
  pt: 'pt',
};
export const UNIT_NAMES: [LengthUnit, string][] = [
  ['px', 'Pixels'],
  ['in', 'Inches'],
  ['cm', 'Centimeters'],
  ['mm', 'Millimeters'],
  ['pt', 'Points'],
  ['percent', 'Percent'],
];
const ALIASES: [RegExp, LengthUnit][] = [
  [/^(px|pixels?)$/i, 'px'],
  [/^(%|percent)$/i, 'percent'],
  [/^(in|inch|inches|")$/i, 'in'],
  [/^(cm|centimeters?|centimetres?)$/i, 'cm'],
  [/^(mm|millimeters?|millimetres?)$/i, 'mm'],
  [/^(pt|points?)$/i, 'pt'],
];
export const unitFromText = (s: string): LengthUnit | undefined =>
  ALIASES.find(([re]) => re.test(s.trim()))?.[1];
export const isLengthUnit = (u: unknown): u is LengthUnit =>
  typeof u === 'string' && u in UNIT_SUFFIX;

export type LengthContext = { unit: LengthUnit; ppi: number; base: number };
type Term = { value: number; unit?: string };
// A number (with optional exponent-free decimals), then an optional unit word,
// percent sign, inch mark or degree sign.
const TOKEN = /\s*(?:(\d+(?:[.,]\d*)?|[.,]\d+)\s*([a-z]+|%|"|°)?|([-+*/×÷()]))/iy;

function tokenize(text: string): (Term | string)[] | undefined {
  const out: (Term | string)[] = [];
  TOKEN.lastIndex = 0;
  const s = text.trim();
  while (TOKEN.lastIndex < s.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m || m.index !== at) return;
    if (m[1] !== undefined) out.push({ value: Number(m[1].replace(',', '.')), unit: m[2] });
    else out.push(m[3] === '×' ? '*' : m[3] === '÷' ? '/' : m[3]);
  }
  return out;
}

/** Evaluate `+ - * /` with parentheses and unary signs over terms; `toValue`
 * turns each term into the result's unit (undefined rejects the term). */
function evaluate(
  tokens: (Term | string)[],
  toValue: (t: Term) => number | undefined,
): number | undefined {
  let i = 0;
  const peek = () => tokens[i];
  function primary(): number | undefined {
    const t = tokens[i++];
    if (t === '-' || t === '+') {
      const v = primary();
      return v === undefined ? undefined : t === '-' ? -v : v;
    }
    if (t === '(') {
      const v = sum();
      if (tokens[i++] !== ')') return;
      return v;
    }
    if (t && typeof t === 'object') return toValue(t);
  }
  function product(): number | undefined {
    let v = primary();
    while (v !== undefined && (peek() === '*' || peek() === '/')) {
      const op = tokens[i++];
      // Factors and divisors are plain numbers: "100px * 2", not "* 2px".
      const t = tokens[i];
      if (t && typeof t === 'object' && t.unit) return;
      const r = t && typeof t === 'object' ? (i++, t.value) : primary();
      if (r === undefined) return;
      if (op === '/' && r === 0) return;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function sum(): number | undefined {
    let v = product();
    while (v !== undefined && (peek() === '+' || peek() === '-')) {
      const op = tokens[i++];
      const r = product();
      if (r === undefined) return;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const v = sum();
  return i === tokens.length && v !== undefined && Number.isFinite(v) ? v : undefined;
}

/** Pixels for a typed length: a number in the field's unit, or with its own
 * unit ("2 in", "50%"), with simple arithmetic ("1800 + 200", "1000/2").
 * Undefined when the text cannot be read. */
export function parseLength(text: string, ctx: LengthContext): number | undefined {
  const tokens = tokenize(text);
  if (!tokens?.length) return;
  return evaluate(tokens, (t) => {
    const unit = t.unit === undefined ? ctx.unit : unitFromText(t.unit);
    if (!unit) return;
    return toPixels(t.value, unit, ctx.ppi, ctx.base);
  });
}

/** A typed plain number (angles, percentages, resolution): arithmetic is
 * allowed and a trailing °, % or the expected unit word is ignored. */
export function parseNumber(text: string, allowUnits: string[] = ['°', '%']): number | undefined {
  const tokens = tokenize(text);
  if (!tokens?.length) return;
  return evaluate(tokens, (t) =>
    t.unit === undefined || allowUnits.some((u) => u.toLowerCase() === t.unit!.toLowerCase())
      ? t.value
      : undefined,
  );
}

/** Shortest display form with at most `decimals` decimals ("1800", "12.5"). */
export function formatNumber(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '';
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return String(Object.is(r, -0) ? 0 : r);
}
/** A pixel length shown in the field's unit (pixels whole when integral). */
export function formatLength(px: number, ctx: LengthContext): string {
  return formatNumber(
    fromPixels(px, ctx.unit, ctx.ppi, ctx.base),
    ctx.unit === 'px' ? 2 : ctx.unit === 'percent' ? 1 : 3,
  );
}

/** Width and height after editing one of them; with `linked` the other keeps
 * the aspect ratio. Results are at least `min`. */
export function linkedSize(
  w: number,
  h: number,
  key: 'width' | 'height',
  value: number,
  linked: boolean,
  round = false,
  min = round ? 1 : 0,
) {
  const r = (v: number) => Math.max(min, round ? Math.round(v) : v);
  if (key === 'width') return { width: r(value), height: r(linked && w ? (h * value) / w : h) };
  return { width: r(linked && h ? (w * value) / h : w), height: r(value) };
}

/** An angle in degrees folded into (-180, 180]. */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Object.is(a, -0) ? 0 : a;
}

export const MAX_SIDE = 8192,
  MAX_PIXELS = 24_000_000;
/** Why a document size cannot be used, or undefined when it can. */
export function canvasSizeProblem(w: number, h: number): string | undefined {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1)
    return 'Use a width and height of at least 1 pixel.';
  if (w > MAX_SIDE || h > MAX_SIDE) return `Use at most ${MAX_SIDE} pixels per side.`;
  if (w * h > MAX_PIXELS) return 'Use at most 24 megapixels.';
}

/** Canvas size for a changed width or height of the document (whole pixels),
 * keeping the aspect when linked; undefined when nothing changes. */
export function plannedCanvasSize(
  doc: { width: number; height: number },
  key: 'width' | 'height',
  px: number,
  linked: boolean,
) {
  const s = linkedSize(doc.width, doc.height, key, px, linked, true);
  if (s.width === doc.width && s.height === doc.height) return;
  return s;
}

/** Canvas size for an orientation button: the sides swap when the document is
 * not already in that orientation (square documents never change). */
export function orientedSize(w: number, h: number, orientation: 'portrait' | 'landscape') {
  if (w === h || (orientation === 'portrait') === h > w) return;
  return { width: h, height: w };
}

/** Clamp `v` into [min, max]. */
export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
