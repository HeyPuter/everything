// Pure helpers behind the wm.context_* operators: stepping through enum items, integers and
// arrays, scaling values and reading the text value of wm.context_set_value.

/** Next item after `cur` (previous with `reverse`); `wrap` loops past the ends. */
export function cycleItem<T>(items: readonly T[], cur: T, reverse: boolean, wrap: boolean): T | undefined {
  if (!items.length) return undefined;
  const i = items.indexOf(cur);
  if (i < 0) return items[reverse ? items.length - 1 : 0];
  let j = i + (reverse ? -1 : 1);
  if (j < 0 || j >= items.length) {
    if (!wrap) return cur;
    j = (j + items.length) % items.length;
  }
  return items[j];
}

/** An integer stepped by one; with `wrap` a value outside [min, max] continues from the other end. */
export function cycleInt(v: number, reverse: boolean, wrap: boolean, min?: number, max?: number): number {
  let n = Math.round(v) + (reverse ? -1 : 1);
  if (min !== undefined && max !== undefined && wrap) {
    if (n > max) n = min;
    else if (n < min) n = max;
  } else {
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
  }
  return n;
}

/** Rotate an array's values by one place (last to first, or first to last with `reverse`). */
export function rotateArray<T>(a: ArrayLike<T>, reverse: boolean): T[] {
  const out = Array.from(a);
  if (out.length < 2) return out;
  if (reverse) out.push(out.shift()!);
  else out.unshift(out.pop()!);
  return out;
}

/** Scale a number; for integers, `alwaysStep` moves at least one unit so small factors still change it. */
export function scaleValue(v: number, factor: number, int: boolean, alwaysStep: boolean): number {
  if (!int) return v * factor;
  const scaled = Math.round(v * factor);
  if (!alwaysStep || scaled !== Math.round(v) || factor === 1) return scaled;
  return Math.round(v) + (factor > 1 ? 1 : -1);
}

/**
 * Value of the text given to wm.context_set_value: numbers, True/False/None, quoted strings and
 * bracketed lists of these; anything else is taken as plain text.
 */
export function parseContextValue(text: string): unknown {
  const t = text.trim();
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  if (/^none$/i.test(t)) return null;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  const q = /^(['"])(.*)\1$/s.exec(t);
  if (q) return q[2];
  const list = /^[[(](.*)[\])]$/s.exec(t);
  if (list) {
    if (!list[1].trim()) return [];
    return splitTopLevel(list[1]).map((x) => parseContextValue(x));
  }
  return t;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0,
    quote = '',
    start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  const last = s.slice(start);
  if (last.trim()) out.push(last);
  return out;
}

/** "INVERSE_SQUARE" → "Inverse Square". */
export function enumLabel(v: string): string {
  return v
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
