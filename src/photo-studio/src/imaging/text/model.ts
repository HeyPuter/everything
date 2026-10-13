// Text layer model and pure editing operations for the Type tool.
//
// Indices address the plain text (UTF-16 code units) where paragraphs are
// joined by a single '\n', so a caret index means the same thing to the
// editor, the layout and the history. Every operation returns new content and
// leaves its input untouched, which keeps undo snapshots cheap and safe.

export type RGB = [number, number, number];
export type Kerning = 'metrics' | 'optical' | 'none';
export type CharStyle = {
  family: string;
  weight: number; // 100-900
  italic: boolean;
  size: number; // points
  leading: 'auto' | number; // points; auto = 120% of the largest size on the line
  tracking: number; // 1/1000 em
  kerning: Kerning;
  baselineShift: number; // points, positive raises
  scaleX: number; // percent
  scaleY: number; // percent
  color: RGB;
  fauxBold: boolean;
  fauxItalic: boolean;
  allCaps: boolean;
  smallCaps: boolean;
  superscript: boolean;
  subscript: boolean;
  underline: boolean;
  strikethrough: boolean;
  ligatures: boolean;
  language: string;
  // Optional (absent in older documents; undefined and '' mean none):
  // the linked character style's ID and enabled OpenType features, as a
  // space-separated list of feature tags such as "dlig onum".
  charStyle?: string;
  features?: string;
  // Digit shapes for Arabic-script text (undefined: Western digits).
  digits?: '' | 'arabic' | 'persian';
  // Vertical text: Latin and digits upright (undefined or ''), rotated
  // sideways, or short runs combined horizontally in one cell ('combine').
  vertical?: '' | 'rotate' | 'combine';
};
export type Align = 'left' | 'center' | 'right' | 'justify-left' | 'justify-center' | 'justify-right' | 'justify-all';
export type ParagraphStyle = {
  align: Align;
  indentLeft: number; // points
  indentRight: number;
  indentFirst: number;
  spaceBefore: number;
  spaceAfter: number;
  hyphenate: boolean;
  // Optional: linked paragraph style ID, and the paragraph's base direction
  // (undefined: left to right).
  paragraphStyle?: string;
  direction?: 'ltr' | 'rtl';
};
export type TextRun = { text: string; style: CharStyle };
export type Paragraph = { runs: TextRun[]; style: ParagraphStyle };
export type TextContent = { paragraphs: Paragraph[] };
export type WarpStyle =
  | 'none' | 'arc' | 'arc-lower' | 'arc-upper' | 'arch' | 'bulge' | 'shell-lower' | 'shell-upper'
  | 'flag' | 'wave' | 'fish' | 'rise' | 'fisheye' | 'inflate' | 'squeeze' | 'twist';
export type Warp = {
  style: WarpStyle;
  bend: number; // -100..100
  horizontal: number; // -100..100
  vertical: number; // -100..100
  axis: 'horizontal' | 'vertical';
};
export type AntiAlias = 'none' | 'sharp' | 'crisp' | 'strong' | 'smooth';
// Text that follows a path ('path': along its outline) or fills a closed
// path ('area'). Knots use the shared cubic layout [inX, inY, x, y, outX,
// outY] in the text's local space. `start` and `end` are fractions of the
// path length bounding path text; `flip` runs it the other way, on the other
// side. Area text keeps `inset` pixels from the outline.
export type ArcPreset = 'arch' | 'circle' | 'bow' | 'wave';
export type TypePath = {
  kind: 'path' | 'area';
  knots: number[][];
  closed: boolean;
  start: number;
  end: number;
  flip: boolean;
  inset?: number;
  // Shape made by Convert to Arc Text (centered on x, y, `width` long), so
  // its options can be adjusted later.
  arc?: { preset: ArcPreset; bend: number; x: number; y: number; width: number };
};
export type TextLayerData = {
  content: TextContent;
  mode: 'point' | 'paragraph';
  box?: { width: number; height: number }; // document pixels, paragraph mode
  origin: { x: number; y: number }; // document pixels: first baseline (point) or box top-left (paragraph)
  orientation: 'horizontal' | 'vertical';
  antiAlias: AntiAlias;
  warp?: Warp;
  // Path or area text (horizontal only; warp does not apply).
  path?: TypePath;
  // Block text (horizontal point text): every line scaled to `width` pixels
  // and stacked with `gap` pixels between lines (imaging/text/block-text.ts).
  block?: { width: number; gap: number };
};

export const defaultCharStyle = (): CharStyle => ({
  family: 'Inter',
  weight: 400,
  italic: false,
  size: 24,
  leading: 'auto',
  tracking: 0,
  kerning: 'metrics',
  baselineShift: 0,
  scaleX: 100,
  scaleY: 100,
  color: [0, 0, 0],
  fauxBold: false,
  fauxItalic: false,
  allCaps: false,
  smallCaps: false,
  superscript: false,
  subscript: false,
  underline: false,
  strikethrough: false,
  ligatures: true,
  language: 'en-US',
});
export const defaultParagraphStyle = (): ParagraphStyle => ({
  align: 'left',
  indentLeft: 0,
  indentRight: 0,
  indentFirst: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  hyphenate: false,
});
export const defaultWarp = (): Warp => ({ style: 'none', bend: 0, horizontal: 0, vertical: 0, axis: 'horizontal' });

// Type sizes are points (1/72 in); documents are pixels at their resolution.
export const ptToPx = (pt: number, ppi: number) => (pt * ppi) / 72;
export const pxToPt = (px: number, ppi: number) => (px * 72) / ppi;

export function textLayer(text = '', style: Partial<CharStyle> = {}, opts: Partial<Omit<TextLayerData, 'content'>> = {}): TextLayerData {
  return {
    content: fromPlainText(text, { ...defaultCharStyle(), ...style }),
    mode: 'point',
    origin: { x: 0, y: 0 },
    orientation: 'horizontal',
    antiAlias: 'smooth',
    ...opts,
  };
}

// ---------------------------------------------------------------- styles

export const optionalCharKeys = ['charStyle', 'features', 'digits', 'vertical'] as const;
export const optionalParagraphKeys = ['paragraphStyle', 'direction'] as const;
const charKeys = [...Object.keys(defaultCharStyle()), ...optionalCharKeys] as (keyof CharStyle)[];
const paraKeys = [...Object.keys(defaultParagraphStyle()), ...optionalParagraphKeys] as (keyof ParagraphStyle)[];

function sameValue(a: unknown, b: unknown) {
  // Optional keys: missing and empty mean the same.
  if ((a === undefined || a === '') && (b === undefined || b === '')) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}
export function sameCharStyle(a: CharStyle, b: CharStyle) {
  return a === b || charKeys.every((k) => sameValue(a[k], b[k]));
}
export function sameParagraphStyle(a: ParagraphStyle, b: ParagraphStyle) {
  return a === b || paraKeys.every((k) => sameValue(a[k], b[k]));
}
const cloneChar = (s: CharStyle): CharStyle => ({ ...s, color: [...s.color] as RGB });

function mergeChar(s: CharStyle, patch: Partial<CharStyle>): CharStyle {
  const out = cloneChar(s);
  for (const k of charKeys) if (patch[k] !== undefined) (out as Record<string, unknown>)[k] = k === 'color' ? [...(patch.color as RGB)] : patch[k];
  // Superscript and subscript are one tri-state control.
  if (patch.superscript) out.subscript = false;
  if (patch.subscript) out.superscript = false;
  return out;
}

// ---------------------------------------------------------------- text

export const paragraphText = (p: Paragraph) => p.runs.map((r) => r.text).join('');
export const plainText = (c: TextContent) => c.paragraphs.map(paragraphText).join('\n');
export const textLength = (c: TextContent) => c.paragraphs.reduce((n, p) => n + paragraphLength(p), 0) + c.paragraphs.length - 1;
const paragraphLength = (p: Paragraph) => p.runs.reduce((n, r) => n + r.text.length, 0);

export function fromPlainText(text: string, style: CharStyle = defaultCharStyle(), paragraph: ParagraphStyle = defaultParagraphStyle()): TextContent {
  return {
    paragraphs: text.split('\n').map((t) => ({ runs: [{ text: t, style: cloneChar(style) }], style: { ...paragraph } })),
  };
}
// Replaces all text, keeping the first character and paragraph styles.
export function setPlainText(c: TextContent, text: string): TextContent {
  const p = c.paragraphs[0];
  return fromPlainText(text, p?.runs[0]?.style ?? defaultCharStyle(), p?.style ?? defaultParagraphStyle());
}

// Paragraph index and offset inside it for a text index (clamped).
export function locate(c: TextContent, index: number): { p: number; offset: number } {
  let i = Math.max(0, index);
  for (let p = 0; p < c.paragraphs.length; p++) {
    const len = paragraphLength(c.paragraphs[p]);
    if (i <= len || p === c.paragraphs.length - 1) return { p, offset: Math.min(i, len) };
    i -= len + 1;
  }
  return { p: 0, offset: 0 };
}
export function paragraphStart(c: TextContent, p: number) {
  let n = 0;
  for (let i = 0; i < p; i++) n += paragraphLength(c.paragraphs[i]) + 1;
  return n;
}

// Merges equal neighbours and drops empty runs; an empty paragraph keeps one
// empty run so it still carries a style for the caret.
function normalizeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && sameCharStyle(last.style, r.style)) last.text += r.text;
    else out.push({ text: r.text, style: r.style });
  }
  if (!out.length) out.push({ text: '', style: runs[0]?.style ?? defaultCharStyle() });
  return out;
}

// Splits runs so that `offset` falls on a run boundary; returns the run index starting there.
function splitAt(runs: TextRun[], offset: number): number {
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (offset === pos) return i;
    if (offset < pos + r.text.length) {
      const k = offset - pos;
      runs.splice(i, 1, { text: r.text.slice(0, k), style: r.style }, { text: r.text.slice(k), style: r.style });
      return i + 1;
    }
    pos += r.text.length;
  }
  return runs.length;
}

function cloneContent(c: TextContent): TextContent {
  return { paragraphs: c.paragraphs.map((p) => ({ runs: p.runs.map((r) => ({ text: r.text, style: r.style })), style: p.style })) };
}

// Style a newly typed character takes at a caret: the character before it in
// the same paragraph, else the first character of the paragraph.
export function charStyleAt(c: TextContent, index: number): CharStyle {
  const { p, offset } = locate(c, index);
  const runs = c.paragraphs[p].runs;
  let pos = 0;
  for (const r of runs) {
    if (offset > pos && offset <= pos + r.text.length) return cloneChar(r.style);
    pos += r.text.length;
  }
  return cloneChar((runs.find((r) => r.text) ?? runs[0]).style);
}

// Common style of a range: a key is undefined when its values are mixed.
export function charStyleOfRange(c: TextContent, start: number, end: number): Partial<CharStyle> {
  const [a, b] = start <= end ? [start, end] : [end, start];
  if (a === b) return charStyleAt(c, a);
  const styles: CharStyle[] = [];
  forEachRunInRange(c, a, b, (r) => styles.push(r.style));
  if (!styles.length) return charStyleAt(c, a);
  const out: Partial<CharStyle> = {};
  for (const k of charKeys) {
    const v = styles[0][k];
    if (styles.every((s) => sameValue(s[k], v))) (out as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}
export function paragraphStyleOfRange(c: TextContent, start: number, end: number): Partial<ParagraphStyle> {
  const styles = paragraphsInRange(c, start, end).map((p) => c.paragraphs[p].style);
  const out: Partial<ParagraphStyle> = {};
  for (const k of paraKeys) {
    const v = styles[0][k];
    if (styles.every((s) => sameValue(s[k], v))) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function forEachRunInRange(c: TextContent, a: number, b: number, fn: (r: TextRun) => void) {
  let base = 0;
  for (const p of c.paragraphs) {
    let pos = base;
    for (const r of p.runs) {
      const s = pos, e = pos + r.text.length;
      if (e > a && s < b && r.text) fn(r);
      pos = e;
    }
    base = pos + 1;
    if (base > b) break;
  }
}
export function paragraphsInRange(c: TextContent, start: number, end: number): number[] {
  const [a, b] = start <= end ? [start, end] : [end, start];
  const pa = locate(c, a).p, pb = locate(c, b).p;
  const out: number[] = [];
  for (let p = pa; p <= pb; p++) out.push(p);
  return out;
}

// ---------------------------------------------------------------- editing

export function insertText(c: TextContent, index: number, text: string, style?: CharStyle): TextContent {
  const out = cloneContent(c);
  const { p, offset } = locate(out, index);
  const st = style ? cloneChar(style) : charStyleAt(c, index);
  const para = out.paragraphs[p];
  const runs = para.runs;
  const at = splitAt(runs, offset);
  const head = runs.slice(0, at), tail = runs.slice(at);
  const parts = text.replace(/\r\n?/g, '\n').split('\n');
  if (parts.length === 1) {
    para.runs = normalizeRuns([...head, { text, style: st }, ...tail]);
    return out;
  }
  // New paragraphs inherit the style of the paragraph being split.
  const made: Paragraph[] = parts.map((t, i) => {
    const rs: TextRun[] = [{ text: t, style: st }];
    if (i === 0) rs.unshift(...head);
    if (i === parts.length - 1) rs.push(...tail);
    return { runs: normalizeRuns(rs.length ? rs : [{ text: '', style: st }]), style: { ...para.style } };
  });
  // An empty first/last fragment keeps the caret style rather than a stale one.
  if (!paragraphLength(made[0]) && head.length) made[0].runs = [{ text: '', style: head[head.length - 1].style }];
  out.paragraphs.splice(p, 1, ...made);
  return out;
}

export function deleteRange(c: TextContent, start: number, end: number): TextContent {
  const [a, b] = start <= end ? [start, end] : [end, start];
  if (a === b) return c;
  const out = cloneContent(c);
  const la = locate(out, a), lb = locate(out, b);
  const pa = out.paragraphs[la.p], pb = out.paragraphs[lb.p];
  const keepStyle = charStyleAt(c, a);
  const headRuns = pa.runs.slice(0, splitAt(pa.runs, la.offset));
  const tailRuns = pb.runs.slice(splitAt(pb.runs, lb.offset));
  // The merged paragraph keeps the first paragraph's style, like word processors.
  const merged: Paragraph = { runs: normalizeRuns([...headRuns, ...tailRuns]), style: pa.style };
  if (!paragraphLength(merged)) merged.runs = [{ text: '', style: keepStyle }];
  out.paragraphs.splice(la.p, lb.p - la.p + 1, merged);
  return out;
}

export function replaceRange(c: TextContent, start: number, end: number, text: string, style?: CharStyle): TextContent {
  const a = Math.min(start, end);
  const st = style ?? (start !== end ? charStyleAt(c, a + 1) : undefined);
  return insertText(deleteRange(c, start, end), a, text, st);
}

export function applyCharStyle(c: TextContent, start: number, end: number, patch: Partial<CharStyle>): TextContent {
  const [a, b] = start <= end ? [start, end] : [end, start];
  const out = cloneContent(c);
  if (a === b) {
    // An empty paragraph carries the caret style; restyle it so typing picks it up.
    const { p } = locate(out, a);
    const para = out.paragraphs[p];
    if (!paragraphLength(para)) para.runs = [{ text: '', style: mergeChar(para.runs[0].style, patch) }];
    return out;
  }
  let base = 0;
  for (const para of out.paragraphs) {
    const len = paragraphLength(para);
    const s = Math.max(0, a - base), e = Math.min(len, b - base);
    if (e > s || (len === 0 && a <= base && b >= base)) {
      if (len === 0) para.runs = [{ text: '', style: mergeChar(para.runs[0].style, patch) }];
      else {
        const runs = para.runs;
        const i0 = splitAt(runs, s), i1 = splitAt(runs, e);
        for (let i = i0; i < i1; i++) runs[i] = { text: runs[i].text, style: mergeChar(runs[i].style, patch) };
        para.runs = normalizeRuns(runs);
      }
    }
    base += len + 1;
    if (base > b) break;
  }
  return out;
}

export function applyParagraphStyle(c: TextContent, start: number, end: number, patch: Partial<ParagraphStyle>): TextContent {
  const out = cloneContent(c);
  for (const p of paragraphsInRange(c, start, end)) {
    const s = { ...out.paragraphs[p].style };
    for (const k of paraKeys) if (patch[k] !== undefined) (s as Record<string, unknown>)[k] = patch[k];
    out.paragraphs[p].style = s;
  }
  return out;
}

// Plain text and styles of a range, for copy and paste with formatting.
export function sliceContent(c: TextContent, start: number, end: number): TextContent {
  const [a, b] = start <= end ? [start, end] : [end, start];
  const n = textLength(c);
  return deleteRange(deleteRange(c, b, n), 0, a);
}
export function insertContent(c: TextContent, index: number, piece: TextContent): TextContent {
  // Insert plain text first so paragraphs split correctly, then restyle each run.
  const text = plainText(piece);
  let out = insertText(c, index, text);
  let pos = index;
  piece.paragraphs.forEach((p, pi) => {
    for (const r of p.runs) {
      if (r.text) out = applyCharStyle(out, pos, pos + r.text.length, r.style);
      pos += r.text.length;
    }
    if (pi < piece.paragraphs.length - 1) pos++;
  });
  return out;
}

// ---------------------------------------------------------------- navigation

type Segmenter = { segment(s: string): Iterable<{ index: number; segment: string; isWordLike?: boolean }> };
const SegmenterCtor = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter }).Segmenter;
const graphemeSeg = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: 'grapheme' }) : undefined;
const wordSeg = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: 'word' }) : undefined;

// Boundaries of user-perceived characters, so the caret never lands inside
// a surrogate pair, combining sequence or emoji.
export function graphemeBoundaries(text: string): number[] {
  const out: number[] = [];
  if (graphemeSeg) for (const s of graphemeSeg.segment(text)) out.push(s.index);
  else for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) continue;
    if (/\p{M}/u.test(text[i]) && i > 0) continue;
    out.push(i);
  }
  out.push(text.length);
  return out;
}
export function nextChar(text: string, index: number): number {
  for (const b of graphemeBoundaries(text)) if (b > index) return b;
  return text.length;
}
export function prevChar(text: string, index: number): number {
  let prev = 0;
  for (const b of graphemeBoundaries(text)) {
    if (b >= index) break;
    prev = b;
  }
  return prev;
}

function words(text: string): { start: number; end: number; word: boolean }[] {
  const out: { start: number; end: number; word: boolean }[] = [];
  if (wordSeg) for (const s of wordSeg.segment(text)) out.push({ start: s.index, end: s.index + s.segment.length, word: !!s.isWordLike });
  else {
    const re = /[\p{L}\p{N}_']+|\s+|[^\p{L}\p{N}_'\s]/gu;
    for (let m; (m = re.exec(text)); ) out.push({ start: m.index, end: m.index + m[0].length, word: /[\p{L}\p{N}_]/u.test(m[0]) });
  }
  return out;
}
// Option/Ctrl+Right: end of the current or next word.
export function nextWord(text: string, index: number): number {
  for (const w of words(text)) if (w.word && w.end > index) return w.end;
  return text.length;
}
// Option/Ctrl+Left: start of the current or previous word.
export function prevWord(text: string, index: number): number {
  let best = 0;
  for (const w of words(text)) {
    if (w.start >= index) break;
    if (w.word) best = w.start;
  }
  return best;
}
// Double-click selection: the word (or the run of spaces/punctuation) at an index.
export function wordAt(text: string, index: number): { start: number; end: number } {
  const ws = words(text);
  const hit = ws.find((w) => index >= w.start && index < w.end) ?? ws.find((w) => w.end === index) ?? { start: index, end: index, word: false };
  if (!hit.word && index > 0) {
    const before = ws.find((w) => w.end === index && w.word);
    if (before) return { start: before.start, end: before.end };
  }
  return { start: hit.start, end: hit.end };
}
// Triple-click selection: the paragraph containing an index (without its '\n').
export function paragraphAt(c: TextContent, index: number): { start: number; end: number } {
  const { p } = locate(c, index);
  const start = paragraphStart(c, p);
  return { start, end: start + paragraphLength(c.paragraphs[p]) };
}
