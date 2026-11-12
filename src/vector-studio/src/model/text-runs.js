/**
 * Rich text model: per-character style runs and per-paragraph overrides.
 *
 * A text node's `char` is its default character style and its fill, stroke
 * and strokeWidth are the default paint. `runs` (optional) is a list of
 * `{ len, ...overrides }` that covers the text from the start; each run
 * overrides some of those keys for `len` characters. Absent `runs` means the
 * whole text uses the defaults, so documents written before runs existed
 * still load unchanged. `paras` (optional) holds per-paragraph overrides of
 * `para`, indexed by paragraph.
 *
 * All functions are pure: they take nodes and return new values, never
 * mutating their input, so they fit the immutable document model.
 */
import { DEFAULT_CHAR, DEFAULT_PARA } from './nodes.js';

export const CHAR_KEYS = Object.keys(DEFAULT_CHAR);
export const PAINT_KEYS = ['fill', 'stroke', 'strokeWidth'];
export const RUN_KEYS = [...CHAR_KEYS, ...PAINT_KEYS];
export const PARA_KEYS = Object.keys(DEFAULT_PARA);
export const MIXED = 'mixed';

const baseCache = new WeakMap();
const styledCache = new WeakMap();

function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == b; // eslint-disable-line eqeqeq
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The default (whole-object) style of a text node: character keys plus paint. */
export function baseStyle(node) {
  let s = baseCache.get(node);
  if (!s) {
    s = { ...DEFAULT_CHAR, ...(node.char || {}), fill: node.fill ?? null, stroke: node.stroke ?? null, strokeWidth: node.strokeWidth ?? 0 };
    baseCache.set(node, s);
  }
  return s;
}

/** Overrides of one run (the run without its length). */
export function overridesOf(run) {
  const o = {};
  for (const k in run) if (k !== 'len') o[k] = run[k];
  return o;
}

/** Runs that exactly cover the node's text. */
export function runsOf(node) {
  const len = String(node.text ?? '').length;
  if (!node.runs || !node.runs.length) return [{ len }];
  const out = [];
  let total = 0;
  for (const r of node.runs) {
    if (!(r.len > 0) || total >= len) continue;
    const n = Math.min(r.len, len - total);
    out.push(n === r.len ? r : { ...r, len: n });
    total += n;
  }
  if (total < len) out.push({ len: len - total });
  if (!out.length) out.push({ ...(node.runs[node.runs.length - 1] || {}), len: 0 });
  return out;
}

/**
 * Resolved runs: [{ start, end, style }] where style is the full character
 * style plus paint. Style objects are shared between calls for the same node.
 */
export function styledRuns(node) {
  let r = styledCache.get(node);
  if (r) return r;
  const base = baseStyle(node);
  r = [];
  let start = 0;
  for (const run of runsOf(node)) {
    const o = overridesOf(run);
    const style = Object.keys(o).length ? { ...base, ...o } : base;
    r.push({ start, end: start + run.len, style });
    start += run.len;
  }
  styledCache.set(node, r);
  return r;
}

function runIndexAt(runs, i) {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (runs[mid].start <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Full style of character i (clamped to the text). */
export function styleAt(node, i) {
  const runs = styledRuns(node);
  const len = String(node.text ?? '').length;
  if (!len) return runs[0]?.style || baseStyle(node);
  return runs[runIndexAt(runs, Math.max(0, Math.min(len - 1, i)))].style;
}

/** Style that text typed at caret index i receives: the character before it, else the one after. */
export function insertionStyle(node, i) {
  return styleAt(node, i > 0 ? i - 1 : 0);
}

/** Overrides that typed text inherits from a neighbor: everything but a chosen glyph alternate. */
function inheritable(o) {
  if (!o || o.altGlyph == null) return o;
  const { altGlyph, ...rest } = o; // eslint-disable-line no-unused-vars
  return rest;
}

/** Raw run overrides for the character at i (used for inserted text). */
export function overridesAt(node, i) {
  const runs = runsOf(node);
  const len = String(node.text ?? '').length;
  let idx = Math.max(0, Math.min(len - 1, i));
  if (!len) return overridesOf(runs[0] || {});
  let start = 0;
  for (const r of runs) {
    if (idx < start + r.len) return overridesOf(r);
    start += r.len;
  }
  return overridesOf(runs[runs.length - 1]);
}

/**
 * Common style over [start, end): { key: value | MIXED }. An empty range
 * reports the insertion style at `start`.
 */
export function rangeStyle(node, start, end) {
  if (end <= start) return { ...insertionStyle(node, start) };
  const runs = styledRuns(node);
  const out = {};
  let first = true;
  for (const r of runs) {
    if (r.end <= start || r.start >= end) continue;
    if (first) {
      Object.assign(out, r.style);
      first = false;
      continue;
    }
    for (const k of RUN_KEYS) if (out[k] !== MIXED && !same(out[k], r.style[k])) out[k] = MIXED;
  }
  return first ? { ...insertionStyle(node, start) } : out;
}

/**
 * Normalize a run list for a node: drop overrides equal to the defaults,
 * merge neighbors with equal overrides and remove empty runs. Returns
 * undefined when nothing is overridden (the plain, backward-compatible form).
 */
export function normalizeRuns(runs, node) {
  const base = baseStyle(node);
  const out = [];
  let any = false;
  for (const r of runs) {
    if (!(r.len > 0)) continue;
    const clean = { len: r.len };
    for (const k in r) {
      if (k === 'len') continue;
      if (!RUN_KEYS.includes(k)) continue;
      if (same(r[k], base[k])) continue;
      clean[k] = r[k];
      any = true;
    }
    const prev = out[out.length - 1];
    if (prev && sameOverrides(prev, clean)) out[out.length - 1] = { ...prev, len: prev.len + clean.len };
    else out.push(clean);
  }
  return any ? out : undefined;
}

function sameOverrides(a, b) {
  const ka = Object.keys(a).filter((k) => k !== 'len');
  const kb = Object.keys(b).filter((k) => k !== 'len');
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same(a[k], b[k]));
}

/** Split runs so that boundaries exist at `at` offsets; returns a fresh array of run copies. */
function splitAt(runs, offsets) {
  const cuts = [...new Set(offsets)].sort((a, b) => a - b);
  const out = [];
  let start = 0;
  for (const r of runs) {
    let s = start;
    const e = start + r.len;
    for (const c of cuts) {
      if (c > s && c < e) {
        out.push({ ...r, len: c - s });
        s = c;
      }
    }
    out.push({ ...r, len: e - s });
    start = e;
  }
  return out;
}

/** New runs with `patch` applied to characters [start, end). */
export function applyRunStyle(node, start, end, patch) {
  const len = String(node.text ?? '').length;
  start = Math.max(0, Math.min(len, start));
  end = Math.max(start, Math.min(len, end));
  if (end === start) return node.runs;
  const runs = splitAt(runsOf(node), [start, end]);
  let pos = 0;
  const out = runs.map((r) => {
    const s = pos;
    pos += r.len;
    if (s >= start && s < end) {
      const next = { ...r };
      for (const k in patch) {
        if (patch[k] === undefined) delete next[k];
        else next[k] = patch[k];
      }
      return next;
    }
    return r;
  });
  return normalizeRuns(out, node);
}

/** Remove keys from every run (after the whole object took a value). */
export function stripRunKeys(node, keys) {
  if (!node.runs) return undefined;
  const out = node.runs.map((r) => {
    const n = { ...r };
    for (const k of keys) delete n[k];
    return n;
  });
  return normalizeRuns(out, { ...node, runs: undefined });
}

/**
 * Patch that applies a style to a whole text node: character keys go into
 * `char`, paint keys onto the node, and the same keys are removed from runs
 * so the whole object takes the new value.
 */
export function wholeStylePatch(node, patch) {
  const charPatch = {};
  const out = {};
  for (const k in patch) {
    if (CHAR_KEYS.includes(k)) charPatch[k] = patch[k];
    else if (PAINT_KEYS.includes(k)) out[k] = patch[k];
  }
  if (Object.keys(charPatch).length) out.char = { ...(node.char || {}), ...charPatch };
  const next = { ...node, ...out };
  const runs = node.runs ? stripRunKeys(next, Object.keys(patch)) : undefined;
  out.runs = runs;
  return out;
}

// ---- paragraphs ----

/** Paragraph ranges [{ start, end }] (end excludes the newline). */
export function paragraphRanges(text) {
  const out = [];
  let start = 0;
  const s = String(text ?? '');
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || s[i] === '\n') {
      out.push({ start, end: i });
      start = i + 1;
    }
  }
  return out;
}

/** Paragraph index containing character index i. */
export function paragraphIndexAt(text, i) {
  let n = 0;
  const s = String(text ?? '');
  const lim = Math.min(i, s.length);
  for (let k = 0; k < lim; k++) if (s[k] === '\n') n++;
  return n;
}

/**
 * First and last paragraph index of the selection [a, b). A selection that
 * ends just after a paragraph's return (a triple-click, or Shift+Down to the
 * start of the next line) does not include the paragraph after it.
 */
export function selectedParagraphs(text, a, b) {
  const s = String(text ?? '');
  const p0 = paragraphIndexAt(s, a);
  return [p0, Math.max(p0, paragraphIndexAt(s, b > a && s[b - 1] === '\n' ? b - 1 : b))];
}

/** Full paragraph style of paragraph pi. */
export function paraAt(node, pi) {
  const o = node.paras?.[pi];
  return o ? { ...DEFAULT_PARA, ...(node.para || {}), ...o } : { ...DEFAULT_PARA, ...(node.para || {}) };
}

function normalizeParas(paras, node, count) {
  if (!paras) return undefined;
  const base = { ...DEFAULT_PARA, ...(node.para || {}) };
  const out = [];
  let any = false;
  for (let i = 0; i < count; i++) {
    const p = paras[i];
    if (!p) {
      out.push(null);
      continue;
    }
    const clean = {};
    for (const k in p) if (PARA_KEYS.includes(k) && !same(p[k], base[k])) clean[k] = p[k];
    if (Object.keys(clean).length) {
      out.push(clean);
      any = true;
    } else out.push(null);
  }
  return any ? out : undefined;
}

/** Patch applying paragraph style to paragraphs p0..p1 (inclusive); all paragraphs -> `para`. */
export function paraStylePatch(node, p0, p1, patch) {
  const count = paragraphRanges(node.text).length;
  if (p0 <= 0 && p1 >= count - 1) {
    const para = { ...(node.para || {}), ...patch };
    const paras = node.paras ? normalizeParas(node.paras.map((p) => (p ? Object.fromEntries(Object.entries(p).filter(([k]) => !(k in patch))) : p)), { ...node, para }, count) : undefined;
    return { para, paras };
  }
  const paras = [];
  for (let i = 0; i < count; i++) {
    const cur = node.paras?.[i] || null;
    paras.push(i >= p0 && i <= p1 ? { ...(cur || {}), ...patch } : cur);
  }
  return { paras: normalizeParas(paras, node, count) };
}

/** Common paragraph style over paragraphs p0..p1. */
export function rangeParaStyle(node, p0, p1) {
  const out = paraAt(node, p0);
  for (let i = p0 + 1; i <= p1; i++) {
    const p = paraAt(node, i);
    for (const k of PARA_KEYS) if (out[k] !== MIXED && !same(out[k], p[k])) out[k] = MIXED;
  }
  return out;
}

// ---- editing ----

/**
 * Replace text [start, end) with `insert`. Inserted characters take
 * `overrides` when given (a pending style), else the overrides of the first
 * replaced character, or for a plain insertion the character before it (or
 * the first character). Returns a node patch
 * { text, runs, paras } that keeps runs and paragraph styles in step.
 */
export function replaceRange(node, start, end, insert, overrides = null) {
  const text = String(node.text ?? '');
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  insert = String(insert ?? '');
  const newText = text.slice(0, start) + insert + text.slice(end);
  if (!newText.length && (node.runs || overrides)) {
    // Emptied: the object keeps the style of what was deleted, so typing continues in it.
    const o = overrides || inheritable(overridesAt(node, start));
    return { text: '', paras: undefined, ...wholeStylePatch({ ...node, runs: undefined }, o) };
  }
  // Runs.
  let runs;
  if (node.runs || overrides) {
    const ins = overrides || inheritable(overridesAt(node, end > start || !start ? start : start - 1));
    const split = splitAt(runsOf(node), [start, end]);
    const out = [];
    let pos = 0;
    let inserted = false;
    for (const r of split) {
      const s = pos;
      pos += r.len;
      if (s >= start && s < end) continue; // deleted
      if (!inserted && s >= end) {
        if (insert.length) out.push({ ...ins, len: insert.length });
        inserted = true;
      }
      out.push(r);
    }
    if (!inserted && insert.length) out.push({ ...ins, len: insert.length });
    runs = normalizeRuns(out, node);
  }
  // Paragraph overrides.
  let paras = node.paras;
  if (node.paras) {
    const p0 = paragraphIndexAt(text, start);
    const p1 = paragraphIndexAt(text, end);
    const added = (insert.match(/\n/g) || []).length;
    const keep = node.paras[p0] ?? null;
    const next = [...node.paras.slice(0, p0), keep, ...Array(added).fill(keep), ...node.paras.slice(p1 + 1)];
    paras = normalizeParas(next, node, paragraphRanges(newText).length);
  }
  return { text: newText, runs, paras };
}

// ---- case conversion ----

const SENTENCE_END = /[.!?]/;

/** Change case without changing the text length (characters whose case form has another length stay). */
export function changeCase(text, mode) {
  const s = String(text ?? '');
  const up = (c) => {
    const u = c.toUpperCase();
    return u.length === c.length ? u : c;
  };
  const low = (c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  };
  const isLetter = (c) => c.toLowerCase() !== c.toUpperCase();
  let out = '';
  if (mode === 'upper') {
    for (const c of s) out += up(c);
    return out;
  }
  if (mode === 'lower') {
    for (const c of s) out += low(c);
    return out;
  }
  if (mode === 'title') {
    let prevWord = false;
    for (const c of s) {
      const letter = isLetter(c) || /\d/.test(c) || c === "'" || c === '\u2019';
      out += letter && !prevWord ? up(c) : low(c);
      prevWord = letter;
    }
    return out;
  }
  if (mode === 'sentence') {
    let start = true;
    for (const c of s) {
      if (isLetter(c)) {
        out += start ? up(c) : low(c);
        start = false;
      } else {
        out += c;
        if (SENTENCE_END.test(c) || c === '\n') start = true;
      }
    }
    return out;
  }
  return s;
}

/** Word boundaries around index i: [start, end). */
export function wordAt(text, i) {
  const s = String(text ?? '');
  if (!s.length) return [0, 0];
  const isWord = (c) => c !== undefined && /[\p{L}\p{M}\p{N}_'\u2019-]/u.test(c);
  let a = Math.max(0, Math.min(s.length, i));
  if (!isWord(s[a]) && isWord(s[a - 1])) a--;
  if (!isWord(s[a])) {
    // A run of spaces or punctuation selects itself.
    let b = a;
    const kind = /\s/.test(s[a] || '') ? /\s/ : /[^\s\p{L}\p{N}_]/u;
    while (a > 0 && kind.test(s[a - 1]) && s[a - 1] !== '\n') a--;
    while (b < s.length && kind.test(s[b]) && s[b] !== '\n') b++;
    return [a, Math.max(b, a + (s[a] === '\n' ? 0 : 1))];
  }
  let b = a;
  while (a > 0 && isWord(s[a - 1])) a--;
  while (b < s.length && isWord(s[b])) b++;
  return [a, b];
}

/** Index of the previous word start before i (for Cmd+Left and Option+Backspace). */
export function prevWordIndex(text, i) {
  const s = String(text ?? '');
  let k = Math.max(0, i);
  while (k > 0 && /\s/.test(s[k - 1])) k--;
  const isWord = (c) => /[\p{L}\p{M}\p{N}_'\u2019]/u.test(c);
  if (k > 0 && !isWord(s[k - 1])) return prevCharIndex(s, k);
  while (k > 0 && isWord(s[k - 1])) k--;
  return k;
}

/** Index of the next word end after i. */
export function nextWordIndex(text, i) {
  const s = String(text ?? '');
  let k = Math.min(s.length, i);
  while (k < s.length && /\s/.test(s[k])) k++;
  const isWord = (c) => /[\p{L}\p{M}\p{N}_'\u2019]/u.test(c);
  if (k < s.length && !isWord(s[k])) return nextCharIndex(s, k);
  while (k < s.length && isWord(s[k])) k++;
  return k;
}

// ---- user-perceived characters (grapheme clusters) ----

const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** [start, end) of the user-perceived character (emoji sequence, base letter plus marks...) containing index i. */
export function clusterAt(text, i) {
  const s = String(text ?? '');
  if (i < 0 || i >= s.length) return [i, i];
  if (graphemes) {
    const seg = graphemes.segment(s).containing(i);
    return [seg.index, seg.index + seg.segment.length];
  }
  // No Intl.Segmenter: keep surrogate pairs together.
  const c = s.charCodeAt(i);
  if (c >= 0xdc00 && c <= 0xdfff && i > 0 && /[\ud800-\udbff]/.test(s[i - 1])) return [i - 1, i + 1];
  if (c >= 0xd800 && c <= 0xdbff && /[\udc00-\udfff]/.test(s[i + 1] || '')) return [i, i + 2];
  return [i, i + 1];
}

/** Caret index one character after i (Right Arrow, Delete): never inside an emoji or a letter with its marks. */
export function nextCharIndex(text, i) {
  const s = String(text ?? '');
  if (i >= s.length) return s.length;
  return Math.max(i + 1, clusterAt(s, Math.max(0, i))[1]);
}

/** Caret index one character before i (Left Arrow). */
export function prevCharIndex(text, i) {
  const s = String(text ?? '');
  if (i <= 0) return 0;
  return Math.min(i - 1, clusterAt(s, Math.min(i, s.length) - 1)[0]);
}

/** Whether a caret may sit at index i (a boundary between user-perceived characters). */
export function isCaretStop(text, i) {
  const s = String(text ?? '');
  return i <= 0 || i >= s.length || clusterAt(s, i)[0] === i;
}

const EMOJI_PART = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\u20e3\ufe0f]/u;

/**
 * Start of what Backspace removes before index i: a whole emoji sequence
 * (flags, skin tones, ZWJ families, keycaps), otherwise one code point, so
 * a mistyped accent or vowel sign comes off on its own (as in the browser's
 * own text fields).
 */
export function backspaceIndex(text, i) {
  const s = String(text ?? '');
  if (i <= 0) return 0;
  const [a] = clusterAt(s, Math.min(i, s.length) - 1);
  if (a < i - 1 && EMOJI_PART.test(s.slice(a, i))) return a;
  const c = s.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i > 1 && /[\ud800-\udbff]/.test(s[i - 2]) ? i - 2 : i - 1;
}
