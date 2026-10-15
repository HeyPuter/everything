// Text editing kernels: body edits that keep per-character formats in sync, cursor movement by
// character / word / visual line, case and style changes, accents, Unicode input, text boxes.
import type { CharFormat, CurveData, TextBox } from '../../data/types';
import type { TextLayout } from '../../io/textlayout';

/** Per-character formats, padded to the body length. */
export function formats(cu: CurveData): CharFormat[] {
  const n = (cu.body ?? '').length;
  const f = (cu.body_format ??= []);
  while (f.length < n) f.push({});
  if (f.length > n) f.length = n;
  for (let i = 0; i < n; i++) f[i] ??= {};
  return f;
}

/** Replace body[a, b) with text; new characters get a copy of `fmt`. */
export function replaceRange(cu: CurveData, a: number, b: number, text: string, fmt: CharFormat = {}) {
  const f = formats(cu);
  const body = cu.body ?? '';
  cu.body = body.slice(0, a) + text + body.slice(b);
  const clean = { ...fmt };
  delete clean.kerning;
  f.splice(a, b - a, ...Array.from({ length: text.length }, () => ({ ...clean })));
}

const isLow = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};
export const prevChar = (s: string, i: number) => Math.max(0, i - (i > 1 && isLow(s, i - 1) ? 2 : 1));
export const nextChar = (s: string, i: number) => Math.min(s.length, i + (isLow(s, i + 1) ? 2 : 1));

const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

/** Start of the word before i (skipping separators first). */
export function prevWord(s: string, i: number) {
  let j = i;
  while (j > 0 && !wordChar(s[j - 1]) && s[j - 1] !== '\n') j--;
  if (j === i && s[j - 1] === '\n') return j - 1;
  while (j > 0 && wordChar(s[j - 1])) j--;
  return j;
}

/** End of the word after i (skipping separators first). */
export function nextWord(s: string, i: number) {
  let j = i;
  while (j < s.length && !wordChar(s[j]) && s[j] !== '\n') j++;
  if (j === i && s[j] === '\n') return j + 1;
  while (j < s.length && wordChar(s[j])) j++;
  return j;
}

/** Bounds of the word touching i (empty range on separators). */
export function wordAt(s: string, i: number): [number, number] {
  let a = i,
    b = i;
  if (!wordChar(s[i]) && wordChar(s[i - 1])) a = b = i - 1;
  if (!wordChar(s[a])) return [i, i];
  while (a > 0 && wordChar(s[a - 1])) a--;
  while (b < s.length && wordChar(s[b])) b++;
  return [a, b];
}

/** The visual (wrapped) line containing the caret. */
export function visualLine(l: TextLayout, c: number) {
  let found = l.lines[0] ?? { start: 0, end: 0, y: 0 };
  for (const ln of l.lines) if (c >= ln.start && c <= ln.end) found = ln;
  return found;
}

/** Caret index on a visual line `dir` lines away, keeping the horizontal position. */
export function verticalMove(l: TextLayout, c: number, dir: number) {
  const cur = visualLine(l, c);
  const idx = l.lines.indexOf(cur);
  const target = l.lines[Math.max(0, Math.min(l.lines.length - 1, idx + dir))];
  if (!target || target === cur) return dir < 0 ? (idx <= 0 ? 0 : c) : idx >= l.lines.length - 1 ? l.lines[l.lines.length - 1]?.end ?? c : c;
  const x = l.carets[c]?.[0] ?? 0;
  let best = target.start,
    bd = Infinity;
  for (let i = target.start; i <= target.end; i++) {
    const d = Math.abs((l.carets[i]?.[0] ?? 0) - x);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export function setCase(cu: CurveData, a: number, b: number, mode: 'UPPER' | 'LOWER') {
  const body = cu.body ?? '';
  const seg = body.slice(a, b);
  const next = mode === 'UPPER' ? seg.toUpperCase() : seg.toLowerCase();
  // case mapping can change the length (ß → SS): keep formats of the original characters
  if (next.length === seg.length) cu.body = body.slice(0, a) + next + body.slice(b);
  else {
    const f = formats(cu);
    replaceRange(cu, a, b, next, f[a] ?? {});
  }
}

export function styleKey(style: string): 'use_bold' | 'use_italic' | 'use_underline' | 'use_small_caps' {
  return style === 'ITALIC' ? 'use_italic' : style === 'UNDERLINE' ? 'use_underline' : style === 'SMALL_CAPS' ? 'use_small_caps' : 'use_bold';
}

export function setStyle(cu: CurveData, a: number, b: number, key: ReturnType<typeof styleKey>, on: boolean) {
  const f = formats(cu);
  for (let i = a; i < b; i++) f[i][key] = on;
}

const ACCENTS: Record<string, string> = { "'": '́', '`': '̀', '^': '̂', '~': '̃', '"': '̈', ':': '̈', ',': '̧', o: '̊', '/': '̸', '-': '̄' };

/** Combine a base character with an accent key (e + ' → é); null when there is no composed form. */
export function accentCombine(base: string, key: string): string | null {
  const mark = ACCENTS[key];
  if (!mark) return null;
  const c = (base + mark).normalize('NFC');
  return c.length === 1 ? c : null;
}

/** Character for a hex code point ("e9", "U+00E9", "0x1F600"). */
export function unicodeChar(code: string): string | null {
  const m = /^(?:u\+|0x|\\u)?([0-9a-f]{1,6})$/i.exec(code.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  if (!(n >= 0x20 && n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return null;
  return String.fromCodePoint(n);
}

export function textBoxes(cu: CurveData): TextBox[] {
  return (cu.text_boxes ??= [{ x: 0, y: 0, width: 0, height: 0 }]);
}

/** Add a text box after the last one (same size, placed to its right). */
export function addTextBox(cu: CurveData) {
  const boxes = textBoxes(cu);
  const last = boxes[boxes.length - 1];
  boxes.push({ x: last.x + (last.width > 0 ? last.width + 0.2 : 0), y: last.y, width: last.width, height: last.height });
}

export function removeTextBox(cu: CurveData, index: number) {
  const boxes = textBoxes(cu);
  if (boxes.length < 2 || index < 0 || index >= boxes.length) return false;
  boxes.splice(index, 1);
  return true;
}
