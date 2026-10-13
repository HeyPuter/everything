/**
 * Text layout for point, area, vertical and path type with per-character
 * style runs.
 *
 * Layout works in a "flow space": u runs along a line (left to right for
 * horizontal type, top to bottom for vertical type, along the path for type
 * on a path) and v is the line's baseline position across lines. The
 * layout's frame maps flow space to the node's local space (before its
 * transform). Every consumer (canvas drawing, hit testing, the caret,
 * selection highlights and outline conversion) reads the same per-character
 * positions, so what you see, what you click and what Create Outlines
 * produces agree.
 *
 * Measurement uses a shared Canvas 2D context (the same engine that draws),
 * caching per-character advances and kerning pairs per font. Without a
 * canvas (tests, workers) it measures with registered opentype.js fonts,
 * and falls back to an approximation.
 */
import { styledRuns, paragraphRanges, paraAt, baseStyle } from './text-runs.js';
import { flattenPath, pathBounds } from './bezier.js';
import { hyphenationOf, hyphenPoints } from './hyphenate.js';

// ---- font hooks and caches ----

/**
 * Hooks set by the type feature:
 *   ensureFont(style)  starts loading a font a layout uses (called once per
 *                      font per generation).
 *   shape(style, text, start, end, chars, key)
 *                      applies OpenType substitutions to a run: may set
 *                      chars.glyph[i] (a glyph index, or -1 for a character
 *                      merged into the ligature before it) and adjust adv, gw
 *                      and kern. Returns true when it shaped anything.
 *   glyphPath(style, glyph, size)
 *                      Path2D of a glyph index (origin on the baseline, y down)
 *                      or null while the font's outlines are not available.
 *   story(node)        the threaded frames of an area type node (first frame,
 *                      which holds the text, first; `node` itself in its
 *                      place), or null.
 *   wraps(node)        text wrap obstacles for an area type node:
 *                      { deps: [nodes they come from], list: [{ polys (in the
 *                      node's local space), offset, invert }] }, or null.
 *   opticalKern(style, a, b)
 *                      kerning between characters a and b judged from their
 *                      outlines, in px at 100px (null while the font loads).
 */
export const textHooks = { ensureFont: null, shape: null, glyphPath: null, story: null, wraps: null, opticalKern: null };

let generation = 0;
let layoutCache = new WeakMap();
let storyCache = new WeakMap(); // first frame of a threaded story -> layouts of every frame
const widthCache = new Map(); // font key -> Map(char -> width at 100px)
const kernCache = new Map(); // font key -> Map(pair -> kerning at 100px)
const metricCache = new Map(); // font key -> { ascent, descent, capHeight, xHeight } at 100px
const ensured = new Set();
const otFonts = new Map(); // family (lower case) -> [{ weight, style, font }]

/** Fonts changed (a face finished loading): drop measurement and layout caches. */
export function invalidateTextLayout() {
  generation++;
  layoutCache = new WeakMap();
  storyCache = new WeakMap();
  widthCache.clear();
  kernCache.clear();
  metricCache.clear();
  ensured.clear();
}

export function fontGeneration() {
  return generation;
}

/** Register a parsed opentype.js font for measuring without a canvas. */
export function registerMeasureFont(family, weight, style, font) {
  const k = family.toLowerCase();
  const list = otFonts.get(k) || [];
  list.push({ weight: Number(weight) || 400, style: style || 'normal', font });
  otFonts.set(k, list);
  invalidateTextLayout();
}

function otFontFor(style) {
  const list = otFonts.get(String(style.fontFamily || '').toLowerCase());
  if (!list || !list.length) return null;
  const w = Number(style.fontWeight) || 400;
  const italic = style.fontStyle === 'italic';
  let best = null;
  let bestD = Infinity;
  for (const f of list) {
    const d = Math.abs(f.weight - w) + ((f.style === 'italic') === italic ? 0 : 1000);
    if (d < bestD) {
      bestD = d;
      best = f.font;
    }
  }
  return best;
}

let measureCtx = null;
let triedCtx = false;

function ctx() {
  if (measureCtx || triedCtx) return measureCtx;
  triedCtx = true;
  try {
    if (typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    else if (typeof document !== 'undefined' && !(typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || ''))) {
      measureCtx = document.createElement('canvas').getContext('2d');
    }
  } catch {
    measureCtx = null;
  }
  return measureCtx || null;
}

export function quoteFamily(family) {
  const f = String(family || 'sans-serif');
  return /^[a-z-]+$/i.test(f) && !/\s/.test(f) ? f : `"${f.replace(/"/g, '')}"`;
}

/** CSS font shorthand for a character style at a pixel size. */
export function cssFont(style, size = style.fontSize) {
  return `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight || 400} ${size}px ${quoteFamily(style.fontFamily)}, sans-serif`;
}

function fontKey(style) {
  return cssFont(style, 100);
}

function ensureFont(style, key) {
  if (ensured.has(key)) return;
  ensured.add(key);
  textHooks.ensureFont?.(style);
}

function width100(style, key, ch) {
  let m = widthCache.get(key);
  if (!m) {
    m = new Map();
    widthCache.set(key, m);
  }
  let w = m.get(ch);
  if (w !== undefined) return w;
  const c = ctx();
  if (c) {
    c.font = key;
    if ('letterSpacing' in c) c.letterSpacing = '0px';
    w = c.measureText(ch).width;
  } else {
    const ot = otFontFor(style);
    if (ot) {
      const g = ot.charToGlyph(ch);
      w = ((g?.advanceWidth || 0) * 100) / ot.unitsPerEm;
    } else w = ch === ' ' ? 27 : /[iljtf.,;:'!|]/.test(ch) ? 28 : /[mwMW]/.test(ch) ? 85 : /[A-Z]/.test(ch) ? 66 : 55;
  }
  m.set(ch, w);
  return w;
}

function kern100(style, key, a, b) {
  let m = kernCache.get(key);
  if (!m) {
    m = new Map();
    kernCache.set(key, m);
  }
  const pair = a + b;
  let k = m.get(pair);
  if (k !== undefined) return k;
  const c = ctx();
  if (c) {
    c.font = key;
    k = c.measureText(pair).width - width100(style, key, a) - width100(style, key, b);
    if (Math.abs(k) < 1e-3) k = 0;
  } else {
    const ot = otFontFor(style);
    k = 0;
    if (ot) {
      try {
        k = (ot.getKerningValue(ot.charToGlyph(a), ot.charToGlyph(b)) * 100) / ot.unitsPerEm;
      } catch {
        k = 0;
      }
    }
  }
  m.set(pair, k);
  return k;
}

/** Vertical metrics at 100px: { ascent, descent, capHeight, xHeight }. */
function metrics100(style, key) {
  let m = metricCache.get(key);
  if (m) return m;
  const c = ctx();
  if (c) {
    c.font = key;
    const t = c.measureText('Hxgjpq');
    const h = c.measureText('H');
    const x = c.measureText('x');
    if (t.fontBoundingBoxAscent) {
      m = { ascent: t.fontBoundingBoxAscent, descent: t.fontBoundingBoxDescent, capHeight: h.actualBoundingBoxAscent || 70, xHeight: x.actualBoundingBoxAscent || 50 };
    }
  }
  if (!m) {
    const ot = otFontFor(style);
    if (ot) {
      const s = 100 / ot.unitsPerEm;
      const os2 = ot.tables?.os2;
      m = {
        ascent: ot.ascender * s,
        descent: -ot.descender * s,
        capHeight: (os2?.sCapHeight || ot.ascender * 0.7) * s,
        xHeight: (os2?.sxHeight || ot.ascender * 0.5) * s,
      };
    }
  }
  if (!m) m = { ascent: 80, descent: 20, capHeight: 70, xHeight: 50 };
  metricCache.set(key, m);
  return m;
}

export function leadingOf(style) {
  return style.leading ?? style.fontSize * 1.2;
}

/** Ascent and descent for a style at its size. */
export function fontMetrics(style) {
  const key = fontKey(style);
  const m = metrics100(style, key);
  return { ascent: (m.ascent * style.fontSize) / 100, descent: (m.descent * style.fontSize) / 100 };
}

/** Vertical metrics for a style at its size: { ascent, descent, capHeight, xHeight } (positive distances from the baseline). */
export function glyphMetrics(style) {
  const m = metrics100(style, fontKey(style));
  const k = style.fontSize / 100;
  return { ascent: m.ascent * k, descent: m.descent * k, capHeight: m.capHeight * k, xHeight: m.xHeight * k };
}

export function applyCaps(text, style) {
  return style.caps === 'all' || style.caps === 'small' ? String(text).toUpperCase() : text;
}

/** Width of a string in one style, including kerning pairs, tracking and horizontal scale. */
export function measure(text, style) {
  const key = fontKey(style);
  ensureFont(style, key);
  const s = applyCaps(String(text), style);
  let w = 0;
  let prev = null;
  for (const ch of s) {
    w += width100(style, key, ch);
    if (prev) w += kern100(style, key, prev, ch);
    prev = ch;
  }
  const track = ((style.tracking || 0) / 1000) * style.fontSize;
  return ((w * style.fontSize) / 100) * ((style.horizontalScale ?? 100) / 100) + track * s.length;
}

// ---- per-character measurement ----

/** Plain number arrays: cheaper than typed arrays for the short-lived arrays layout makes. */
function zeros(n) {
  return new Array(n).fill(0);
}

const SMALL_CAPS = 0.7;
const SCRIPT_SIZE = 0.583;
const SCRIPT_SHIFT = 0.333;
export const TAB_WIDTH = 36;
/** Forced line break inside a paragraph (Type > Insert Break Character). */
export const LINE_SEP = '\u2028';
/** Discretionary hyphen. */
export const SHY = '\u00ad';

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\u3000' || c === '\u00a0';
}

function isCJK(c) {
  if (!c) return false;
  const n = c.charCodeAt(0);
  return (n >= 0x3040 && n <= 0x30ff) || (n >= 0x3400 && n <= 0x9fff) || (n >= 0xac00 && n <= 0xd7af) || (n >= 0xf900 && n <= 0xfaff) || (n >= 0xff00 && n <= 0xffef);
}

/** Display character and size factor for a character in a style (caps, small caps, super/subscript). */
export function displayOf(ch, style) {
  let c = ch;
  let scale = 1;
  if (style.caps === 'all') c = ch.toUpperCase();
  else if (style.caps === 'small') {
    const up = ch.toUpperCase();
    if (up !== ch && up.length === 1) {
      c = up;
      scale = SMALL_CAPS;
    }
  }
  if (c.length !== 1) c = ch;
  if (style.position === 'super' || style.position === 'sub') scale *= SCRIPT_SIZE;
  return { c, scale };
}

/** Baseline offset (positive = up) for a style: baseline shift plus super/subscript position. */
export function riseOf(style) {
  let r = style.baselineShift || 0;
  if (style.position === 'super') r += style.fontSize * SCRIPT_SHIFT;
  else if (style.position === 'sub') r -= style.fontSize * SCRIPT_SHIFT;
  return r;
}

/**
 * Per-character arrays for a text: display char, style, draw size, advance,
 * glyph width, natural kerning and manual kerning before the character, and
 * vertical metrics.
 */
function measureChars(node, text, vertical) {
  const n = text.length;
  const out = {
    disp: new Array(n),
    sty: new Array(n),
    size: zeros(n),
    adv: zeros(n),
    gw: zeros(n),
    kern: zeros(n),
    manual: zeros(n),
    asc: zeros(n),
    desc: zeros(n),
    lead: zeros(n),
    glyph: null, // shaped glyph indices (see textHooks.shape)
    gs: null, // extra horizontal glyph scale per character (paragraph glyph scaling), or null
    shaped: false,
    perGlyph: false, // spacing the canvas cannot reproduce from strings: draw glyph by glyph
    vertical,
  };
  for (const run of styledRuns(node)) {
    const st = run.style;
    const key = fontKey(st);
    ensureFont(st, key);
    const m = metrics100(st, key);
    const hs = (st.horizontalScale ?? 100) / 100;
    const vs = (st.verticalScale ?? 100) / 100;
    const track = ((st.tracking || 0) / 1000) * st.fontSize;
    const manual = ((st.kerning || 0) / 1000) * st.fontSize;
    const lead = leadingOf(st);
    const asc = ((m.ascent * st.fontSize) / 100) * vs;
    const desc = ((m.descent * st.fontSize) / 100) * vs;
    let prev = null;
    let prevScale = 0;
    for (let i = run.start; i < run.end && i < n; i++) {
      const ch = text[i];
      const d = displayOf(ch, st);
      const size = st.fontSize * d.scale;
      out.disp[i] = d.c;
      out.sty[i] = st;
      out.size[i] = size;
      out.lead[i] = lead;
      out.asc[i] = vertical ? (st.fontSize * hs) / 2 : asc;
      out.desc[i] = vertical ? (st.fontSize * hs) / 2 : desc;
      out.manual[i] = manual;
      if (ch === '\n' || ch === LINE_SEP || ch === SHY) {
        // Breaks take no room; a discretionary hyphen shows only where a line breaks at it.
        out.adv[i] = 0;
        if (ch !== '\n') out.disp[i] = '';
        if (ch !== SHY) prev = null;
        continue;
      }
      const w = (width100(st, key, d.c) * size) / 100;
      out.gw[i] = w * hs;
      if (vertical) {
        out.adv[i] = st.fontSize * vs + track;
      } else {
        out.adv[i] = w * hs + track;
        if (prev && prevScale === d.scale) out.kern[i] = ((kern100(st, key, prev, d.c) * size) / 100) * hs;
      }
      prev = d.c;
      prevScale = d.scale;
    }
    if (textHooks.shape && run.end > run.start && textHooks.shape(st, text, run.start, Math.min(run.end, n), out, key)) out.shaped = true;
  }
  if (!vertical) applySpacing(node, text, out);
  return out;
}

// ---- kerning modes, whole-point widths and paragraph spacing ----

export const JUSTIFICATION_DEFAULTS = Object.freeze({
  wordMin: 80, // word spacing, % of the font's space
  wordDesired: 100,
  wordMax: 133,
  letterMin: 0, // letter spacing, % of a space added between characters
  letterDesired: 0,
  letterMax: 0,
  glyphMin: 100, // glyph scaling, % of the glyph width
  glyphDesired: 100,
  glyphMax: 100,
  autoLeading: 120, // auto leading, % of the type size
  singleWord: 'justify', // a justified line holding one word: justify | left | center | right
});

/** Justification settings of a paragraph with the defaults filled in. */
export function justificationOf(para) {
  return { ...JUSTIFICATION_DEFAULTS, ...(para?.justification || {}) };
}

const spaceCache = new WeakMap();

/** Width of a space in a style at a draw size. */
function spaceWidth(st, size) {
  let w = spaceCache.get(st);
  if (w === undefined) {
    w = width100(st, fontKey(st), ' ') * ((st.horizontalScale ?? 100) / 100);
    spaceCache.set(st, w);
  }
  return (w * size) / 100;
}

const isBreakChar = (c) => c === '\n' || c === LINE_SEP || c === SHY || c === '\t';

/**
 * Character settings the canvas cannot apply by itself (kerning mode,
 * whole-point advances) and a paragraph's desired word, letter and glyph
 * spacing and auto leading.
 */
function applySpacing(node, text, out) {
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const st = out.sty[i];
    if (!st) continue;
    const km = st.kernMode;
    if ((km === 'none' || km === 'optical') && i > 0) {
      out.perGlyph = true;
      if (km === 'none') out.kern[i] = 0;
      else if (out.sty[i - 1] === st && out.adv[i] > 0 && out.adv[i - 1] > 0 && !isBreakChar(text[i]) && !isBreakChar(text[i - 1]) && textHooks.opticalKern) {
        const k = textHooks.opticalKern(st, out.disp[i - 1], out.disp[i]);
        if (k != null) out.kern[i] = ((k * out.size[i]) / 100) * ((st.horizontalScale ?? 100) / 100);
      }
    }
    if (st.fractionalWidths === false && out.adv[i]) {
      out.adv[i] = Math.round(out.adv[i]);
      out.kern[i] = Math.round(out.kern[i]);
      out.perGlyph = true;
    }
  }
  const ranges = paragraphRanges(text);
  for (let pi = 0; pi < ranges.length; pi++) {
    const para = paraAt(node, pi);
    if (!para.justification) continue;
    const J = justificationOf(para);
    const wd = J.wordDesired / 100;
    const ld = J.letterDesired / 100;
    const gd = J.glyphDesired / 100;
    const al = J.autoLeading / 100;
    if (wd !== 1 || ld || gd !== 1) out.perGlyph = true;
    const pr = ranges[pi];
    for (let i = pr.start; i < pr.end && i < n; i++) {
      const st = out.sty[i];
      if (st.leading == null) out.lead[i] = st.fontSize * al;
      const c = text[i];
      if (!out.adv[i] || isBreakChar(c)) continue;
      if (c === ' ' || c === '\u3000') {
        out.adv[i] *= wd;
        continue;
      }
      if (gd !== 1) {
        if (!out.gs) out.gs = new Array(n).fill(1);
        out.adv[i] += out.gw[i] * (gd - 1);
        out.gw[i] *= gd;
        out.gs[i] = gd;
      }
      if (ld) out.adv[i] += spaceWidth(st, out.size[i]) * ld;
    }
  }
}

// ---- tabs, lists and margins ----

/**
 * Advance of the tab at i, `x` along the line (from the line start). Tab
 * stops are measured from the frame's left edge; `tc.origin` is where the
 * line starts relative to it. Center, right and decimal stops align the
 * text up to the next tab (decimal: up to its decimal character). Past the
 * last stop, default stops repeat every TAB_WIDTH.
 */
function tabAdvance(text, ch, i, x, tc, end) {
  const abs = (tc?.origin || 0) + x;
  let stop = null;
  if (tc?.stops) {
    for (const s of tc.stops) {
      if (s.pos > abs + 0.01) {
        stop = s;
        break;
      }
    }
  }
  if (!stop) {
    const next = (Math.floor(abs / TAB_WIDTH + 1e-6) + 1) * TAB_WIDTH;
    return { adv: next - abs, stop: null };
  }
  const align = stop.align || 'left';
  if (align === 'left') return { adv: stop.pos - abs, stop };
  const dec = stop.decimal || '.';
  let w = 0;
  let before = null;
  for (let j = i + 1; j < end; j++) {
    const c = text[j];
    if (c === '\t' || c === '\n' || c === LINE_SEP) break;
    if (align === 'decimal' && before === null && c === dec) before = w;
    if (j > i + 1) w += ch.kern[j] + ch.manual[j];
    w += ch.adv[j];
  }
  const lead = align === 'right' ? w : align === 'center' ? w / 2 : (before ?? w);
  return { adv: Math.max(0, stop.pos - abs - lead), stop };
}

/** Sorted tab stops of a paragraph (or null). */
function tabStops(para) {
  const t = para.tabs;
  if (!Array.isArray(t) || !t.length) return null;
  return t.slice().sort((a, b) => a.pos - b.pos);
}

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

/** A list number in a format: '1' decimal, '01' zero padded, 'a'/'A' letters, 'i'/'I' roman. */
export function formatListNumber(n, format = '1') {
  n = Math.max(0, Math.round(n));
  if (format === 'a' || format === 'A') {
    let s = '';
    let k = Math.max(1, n);
    while (k > 0) {
      k--;
      s = String.fromCharCode(97 + (k % 26)) + s;
      k = Math.floor(k / 26);
    }
    return format === 'A' ? s.toUpperCase() : s;
  }
  if (format === 'i' || format === 'I') {
    if (n <= 0 || n >= 4000) return String(n);
    let s = '';
    let k = n;
    for (const [v, r] of ROMAN) {
      while (k >= v) {
        s += r;
        k -= v;
      }
    }
    return format === 'I' ? s.toUpperCase() : s;
  }
  if (format === '01') return String(n).padStart(2, '0');
  return String(n);
}

/**
 * List marker text per paragraph (null where a paragraph is not in a list).
 * Consecutive numbered paragraphs count up; any other paragraph restarts
 * the count (at list.start, default 1).
 */
export function listLabels(node, text = String(node.text ?? '')) {
  const n = paragraphRanges(text).length;
  const out = new Array(n).fill(null);
  let counter = 0;
  let prevNumbered = false;
  for (let pi = 0; pi < n; pi++) {
    const L = paraAt(node, pi).list;
    if (!L || (L.kind !== 'bullet' && L.kind !== 'number')) {
      prevNumbered = false;
      continue;
    }
    if (L.kind === 'number') {
      counter = prevNumbered && !L.restart ? counter + 1 : Number.isFinite(L.start) ? L.start : 1;
      out[pi] = formatListNumber(counter, L.format) + (L.suffix ?? '.');
      prevNumbered = true;
    } else {
      out[pi] = L.bullet || '\u2022';
      prevNumbered = false;
    }
  }
  return out;
}

/**
 * List markers per paragraph, measured in the style of the paragraph's
 * first character: { str, w, gap, style, size } or null.
 */
function listMarkers(node, text, ch) {
  const labels = listLabels(node, text);
  if (!labels.some((l) => l != null)) return null;
  const ranges = paragraphRanges(text);
  return labels.map((str, pi) => {
    if (str == null) return null;
    const pr = ranges[pi];
    const src = ch.sty[pr.start] || (pr.start > 0 ? ch.sty[pr.start - 1] : null) || baseStyle(node);
    const style = { ...src, underline: false, strike: false, rotation: 0, caps: 'normal', position: 'normal', baselineShift: 0, altGlyph: null };
    return { str, w: measure(str, style), gap: style.fontSize * 0.5, style, size: style.fontSize };
  });
}

/** Left indent of a line; a list paragraph's first line starts after its marker (a hanging indent). */
function lineLeft(para, first, marker) {
  const base = (para.indentLeft || 0) + (first ? para.indentFirst || 0 : 0);
  if (!first || !marker) return base;
  return Math.max(para.indentLeft || 0, base + marker.w + marker.gap);
}

/** How far a character hangs outside the margin with optical margin alignment (fraction of its advance). */
function hangOf(c) {
  if (!c) return 0;
  if ('.,\'"‘’“”‚„:;'.includes(c)) return c === ':' || c === ';' ? 0.5 : 1;
  if ('-‐‑­'.includes(c)) return 0.75;
  if ('–—*•'.includes(c)) return 0.5;
  if ('«»‹›'.includes(c)) return 0.5;
  if ('AJTVWYvwyTt'.includes(c)) return 0.05;
  return 0;
}

/** How far a character hangs outside the margin with hanging punctuation (fraction of its advance). */
function hangFull(c) {
  return c && '.,\'"‘’“”‚„:;-‐–—«»‹›'.includes(c) ? 1 : 0;
}

// ---- line breaking ----

/** Whether a line may break before index b (no-break text on both sides keeps together). */
function canBreak(ch, b, pe) {
  return !(b < pe && b > 0 && ch.sty[b - 1]?.noBreak && ch.sty[b]?.noBreak);
}

const isLetter = (c) => Boolean(c) && /\p{L}/u.test(c);
const isDash = (c) => c === '-' || c === SHY || c === '‐' || c === '–' || c === '—' || c === '/';

/** Width of a hyphen drawn after the character at i. */
function hyphenWidth(ch, i) {
  const st = ch.sty[i];
  return st ? measure('-', st) * (ch.size[i] / st.fontSize || 1) : 0;
}

/**
 * Greedy line fill from `from` within `maxW`; returns the end index
 * (exclusive). `opt.shrink` is the fraction of each space justified text
 * may give up to fit; `opt.hy` ({ s: settings, count: hyphenated lines
 * just before }) turns on automatic hyphenation, and `ch.lastHyphen` then
 * says whether the line ends at an automatic hyphen.
 */
function fillLine(text, ch, from, pe, maxW, tc = null, opt = null) {
  ch.lastHyphen = false;
  const shrinkK = opt?.shrink || 0;
  let x = 0;
  let sh = 0;
  let lastBreak = -1;
  let lastBreakX = 0;
  let wordStart = from;
  const wx = []; // content width before each character of the current word
  for (let i = from; i < pe; i++) {
    const c = text[i];
    if (c === LINE_SEP) return i + 1;
    const pre = x;
    if (i > from) x += ch.kern[i] + ch.manual[i];
    const a = c === '\t' ? tabAdvance(text, ch, i, x, tc, pe).adv : ch.adv[i];
    if (isSpace(c)) {
      if (!isSpace(text[i - 1]) || i === from) lastBreakX = pre;
      x += a;
      sh += a * shrinkK;
      if (canBreak(ch, i + 1, pe)) lastBreak = i + 1;
      wordStart = i + 1;
      wx.length = 0;
      continue;
    }
    wx[i - wordStart] = pre;
    if (x + a - sh > maxW + 1e-6 && i > from) {
      if (opt?.hy) {
        const b = hyphenBreak(text, ch, from, pe, i, wordStart, wx, maxW + sh, lastBreak > from ? maxW - lastBreakX : Infinity, shrinkK > 0, opt.hy);
        if (b > from) {
          ch.lastHyphen = true;
          return b;
        }
      }
      if (lastBreak > from) return lastBreak;
      return i;
    }
    x += a;
    if ((isDash(c) || isCJK(c) || isCJK(text[i + 1])) && canBreak(ch, i + 1, pe)) {
      lastBreak = i + 1;
      lastBreakX = x;
      if (isDash(c)) {
        wordStart = i + 1;
        wx.length = 0;
      }
    }
  }
  return pe;
}

/**
 * The best automatic hyphen break for a line that overflows at character i
 * inside the word starting at wordStart, or -1. `room` is the width the line
 * may use; `gap` how far from the margin it would end without hyphenating.
 */
function hyphenBreak(text, ch, from, pe, i, wordStart, wx, room, gap, justified, hy) {
  const s = hy.s;
  if (s.limit > 0 && hy.count >= s.limit) return -1;
  // Unjustified text hyphenates only when the line would otherwise end far from the margin.
  if (!justified && gap < (s.zone || 0)) return -1;
  let ls = wordStart;
  while (ls < i && !isLetter(text[ls])) ls++;
  let we = ls;
  while (we < pe && isLetter(text[we])) we++;
  if (we - ls < 2) return -1;
  for (let k = ls; k < we; k++) if (ch.sty[k]?.noBreak || ch.glyph?.[k] === -1) return -1;
  const pts = hyphenPoints(text.slice(ls, we), s, ch.sty[ls]?.language);
  for (let p = pts.length - 1; p >= 0; p--) {
    const b = ls + pts[p];
    if (b > i || b <= from) continue;
    if (ch.glyph?.[b] === -1) continue; // inside a ligature
    if (wx[b - wordStart] + hyphenWidth(ch, b - 1) <= room + 1e-6) return b;
  }
  return -1;
}

/** Positions (relative to the line start) of each caret index in [start, end]; tabs resolved go to `tabsOut`. */
function positions(text, ch, start, end, tc = null, tabsOut = null) {
  const xs = zeros(end - start + 1);
  let x = 0;
  for (let i = start; i < end; i++) {
    if (i > start) x += ch.kern[i] + ch.manual[i];
    xs[i - start] = x;
    if (text[i] === '\t') {
      const t = tabAdvance(text, ch, i, x, tc, end);
      if (tabsOut) tabsOut.push({ i, stop: t.stop });
      x += t.adv;
    } else x += ch.adv[i];
  }
  xs[end - start] = x;
  return xs;
}

/** Max metrics over [start, end); an empty range uses the character at `start` (or before it). */
function lineMetrics(text, ch, start, end) {
  let asc = 0;
  let desc = 0;
  let lead = 0;
  let a = start;
  let b = end;
  if (b <= a) {
    a = Math.min(start, text.length - 1);
    if (a < 0) return null;
    b = a + 1;
  }
  for (let i = a; i < b; i++) {
    if (ch.asc[i] > asc) asc = ch.asc[i];
    if (ch.desc[i] > desc) desc = ch.desc[i];
    if (ch.lead[i] > lead) lead = ch.lead[i];
  }
  return { asc, desc, lead, cap: asc * 0.85, xh: asc * 0.6 };
}

function emptyMetrics(node) {
  const st = baseStyle(node);
  const { ascent, descent } = fontMetrics(st);
  const vs = (st.verticalScale ?? 100) / 100;
  return { asc: ascent * vs, desc: descent * vs, lead: leadingOf(st), cap: ascent * 0.85, xh: ascent * 0.6 };
}

/**
 * Build a line: alignment, indents, tabs, list marker, optical margins and
 * justification within a slot that starts at x0 and is `avail` wide (point
 * type passes the anchor and no width). `opts.cellLeft` is the frame's left
 * edge (tab stops count from it), `opts.marker` the paragraph's list marker.
 */
function makeLine(text, ch, start, end, pi, para, firstInPara, lastInPara, slot, m, point, opts = {}) {
  let contentEnd = end;
  while (contentEnd > start && (isSpace(text[contentEnd - 1]) || text[contentEnd - 1] === LINE_SEP)) contentEnd--;
  const marker = firstInPara ? opts.marker || null : null;
  const left = lineLeft(para, firstInPara, marker);
  const right = para.indentRight || 0;
  const tabs = [];
  const tc = { stops: tabStops(para), origin: (point ? 0 : slot.x0 - (opts.cellLeft ?? slot.x0)) + left };
  const rel = positions(text, ch, start, end, tc, tabs);
  // A line ending at a discretionary or automatic hyphen shows a hyphen after its last character.
  const hyphen = !lastInPara && end > start && (opts.hyphen || text[end - 1] === SHY);
  const hyW = hyphen ? hyphenWidth(ch, end - 1) : 0;
  const width = rel[contentEnd - start] + hyW;
  let hangL = 0;
  let hangR = 0;
  if (contentEnd > start) {
    if (para.opticalMargin) {
      hangL = hangOf(text[start]) * ch.adv[start];
      hangR = hangOf(text[contentEnd - 1]) * ch.adv[contentEnd - 1];
    } else if (para.hangingPunctuation) {
      hangL = hangFull(text[start]) * ch.adv[start];
      hangR = hyphen ? hyW : hangFull(text[contentEnd - 1]) * ch.adv[contentEnd - 1];
    }
  }
  const visible = width - hangL - hangR;
  let align = para.align || 'left';
  let spaces = 0;
  for (let i = start; i < contentEnd; i++) if (text[i] === ' ' || text[i] === '\u3000') spaces++;
  const J = align.startsWith('justify') ? justificationOf(para) : null;
  // A justified line holding a single word follows the single word setting.
  if (J && !spaces && !lastInPara && J.singleWord !== 'justify' && contentEnd > start) align = J.singleWord;
  let offset;
  let extra = 0;
  if (point) {
    if (align === 'center' || align === 'justify-center') offset = slot.x0 - visible / 2 + (left - right) / 2 - hangL;
    else if (align === 'right' || align === 'justify-right') offset = slot.x0 - visible - right - hangL;
    else offset = slot.x0 + left - hangL;
  } else {
    const avail = slot.x1 - slot.x0 - left - right;
    const justify = align.startsWith('justify') && (!lastInPara || align === 'justify-all');
    // Justified lines stretch to the margins; one squeezed in by tighter word spacing gives the room back.
    if ((justify && avail > visible) || (J && spaces && visible > avail + 1e-6)) {
      extra = avail - visible;
      offset = slot.x0 + left - hangL;
    } else {
      let a = align;
      if (a === 'justify' || a === 'justify-all') a = 'left';
      else if (a === 'justify-center') a = 'center';
      else if (a === 'justify-right') a = 'right';
      offset = slot.x0 + left - hangL + (a === 'center' ? (avail - visible) / 2 : a === 'right' ? avail - visible : 0);
    }
  }
  const xs = zeros(rel.length);
  let gscale = 1;
  let spread = false;
  if (extra !== 0) {
    const d = distribute(text, ch, start, contentEnd, extra, spaces, J || justificationOf(para));
    gscale = d.glyph;
    spread = d.letter !== 0 || d.glyph !== 1;
    let add = 0;
    for (let k = 0; k < rel.length; k++) {
      xs[k] = offset + rel[k] + add;
      const i = start + k;
      if (i >= contentEnd) continue;
      if (text[i] === ' ' || text[i] === '\u3000') add += d.space;
      else {
        add += ch.gw[i] * (d.glyph - 1);
        if (i < contentEnd - 1) add += d.letter;
      }
    }
  } else {
    for (let k = 0; k < rel.length; k++) xs[k] = offset + rel[k];
  }
  // Drawn extras: the list marker, tab leaders and the hyphen of a line broken at a discretionary hyphen.
  let extras = null;
  const pushExtra = (e) => (extras || (extras = [])).push(e);
  if (marker) {
    const hanging = align === 'left' || align === 'justify' || align === 'justify-all';
    const mu = hanging ? slot.x0 + (para.indentLeft || 0) + (para.indentFirst || 0) : xs[0] - marker.w - marker.gap;
    pushExtra({ str: marker.str, u: mu, style: marker.style, size: marker.size, w: marker.w });
  }
  for (const t of tabs) {
    const L = t.stop?.leader;
    if (!L || !L.trim()) continue;
    const st = ch.sty[t.i];
    const lw = measure(L, st);
    if (!(lw > 0.5)) continue;
    const u0 = xs[t.i - start];
    const u1 = xs[t.i - start + 1];
    const origin = point ? slot.x0 : opts.cellLeft ?? slot.x0;
    for (let u = origin + Math.ceil((u0 - origin) / lw - 1e-6) * lw; u + lw <= u1 + 0.01; u += lw) pushExtra({ str: L, u, style: st, size: st.fontSize, w: lw });
  }
  if (hyphen) {
    const st = ch.sty[end - 1];
    pushExtra({ str: '-', u: xs[contentEnd - start], style: st, size: ch.size[end - 1], w: hyW });
  }
  return {
    start,
    end,
    contentEnd,
    xs,
    x: xs[0],
    width: xs[contentEnd - start] - xs[0],
    y: 0,
    asc: m.asc,
    desc: m.desc,
    lead: m.lead,
    para: pi,
    justified: extra !== 0,
    spread, // letters spaced or glyphs scaled to justify: drawn glyph by glyph
    gscale, // glyph scaling of the line's characters (justification)
    hyphen,
    text: text.slice(start, end),
    extras,
  };
}

/**
 * Share `extra` width (negative to squeeze) between word spaces, letter
 * spacing and glyph scaling within a paragraph's justification limits:
 * word spaces first, then letters, then glyphs; what is left goes to the
 * word spaces (or the letters of a line without spaces). Returns the
 * amount per space, per letter gap and the glyph scale factor.
 */
function distribute(text, ch, start, end, extra, spaces, J) {
  let spaceW = 0;
  let glyphW = 0;
  let gaps = 0;
  let ref = 0;
  for (let i = start; i < end; i++) {
    if (text[i] === ' ' || text[i] === '\u3000') spaceW += ch.adv[i];
    else if (ch.adv[i]) {
      glyphW += ch.gw[i];
      if (!ref && ch.sty[i]) ref = spaceWidth(ch.sty[i], ch.size[i]);
    }
    if (i < end - 1 && text[i] !== ' ') gaps++;
  }
  const out = { space: 0, letter: 0, glyph: 1 };
  const grow = extra > 0;
  let rest = Math.abs(extra);
  const take = (cap) => {
    const v = Math.max(0, Math.min(rest, cap));
    rest -= v;
    return v;
  };
  const wd = J.wordDesired || 100;
  const gd = J.glyphDesired || 100;
  const capWord = spaces ? (spaceW * (grow ? J.wordMax - wd : wd - J.wordMin)) / wd : 0;
  const capLetter = gaps * ref * ((grow ? J.letterMax - J.letterDesired : J.letterDesired - J.letterMin) / 100);
  const capGlyph = (glyphW * (grow ? J.glyphMax - gd : gd - J.glyphMin)) / gd;
  const sign = grow ? 1 : -1;
  let w = take(capWord);
  const l = take(capLetter);
  const g = take(capGlyph);
  // Stretching past the limits goes to the word spaces; squeezing never goes past them.
  if (grow && rest > 0) {
    if (spaces) w += rest;
    else if (gaps) out.letter += rest / gaps;
    rest = 0;
  }
  if (spaces) out.space = (sign * w) / spaces;
  if (gaps) out.letter += (sign * l) / gaps;
  if (glyphW) out.glyph = 1 + (sign * g) / glyphW;
  return out;
}

// ---- frames ----

function polyIntervals(poly, y) {
  const xs = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
  }
  xs.sort((p, q) => p - q);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2) out.push({ x0: xs[k], x1: xs[k + 1] });
  return out;
}

function intersectIntervals(a, b) {
  const out = [];
  for (const p of a) {
    for (const q of b) {
      const x0 = Math.max(p.x0, q.x0);
      const x1 = Math.min(p.x1, q.x1);
      if (x1 > x0) out.push({ x0, x1 });
    }
  }
  return out.sort((p, q) => p.x0 - q.x0);
}

/** Horizontal extent of a polygon within the band a <= y <= b (null when it does not reach the band). */
function bandExtent(poly, a, b) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[j];
    const q = poly[i];
    if (Math.max(p.y, q.y) < a || Math.min(p.y, q.y) > b) continue;
    for (const v of [p, q]) {
      if (v.y >= a && v.y <= b) {
        if (v.x < lo) lo = v.x;
        if (v.x > hi) hi = v.x;
      }
    }
    for (const yy of [a, b]) {
      if ((p.y - yy) * (q.y - yy) < 0) {
        const x = p.x + ((q.x - p.x) * (yy - p.y)) / (q.y - p.y);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
  }
  return lo <= hi ? { x0: lo, x1: hi } : null;
}

/** Slots minus (or, inverted, within) a text wrap object, for a line band y0..y1. */
function wrapSlots(slots, w, y0, y1) {
  const off = w.offset || 0;
  if (w.invert) {
    let inside = [];
    for (const poly of w.polys) {
      let s = polyIntervals(poly, y0);
      s = intersectIntervals(s, polyIntervals(poly, (y0 + y1) / 2));
      s = intersectIntervals(s, polyIntervals(poly, y1));
      inside = inside.concat(s.map((p) => ({ x0: p.x0 + off, x1: p.x1 - off })).filter((p) => p.x1 > p.x0));
    }
    return intersectIntervals(slots, inside);
  }
  let out = slots;
  for (const poly of w.polys) {
    const ext = bandExtent(poly, y0 - off, y1 + off);
    if (!ext) continue;
    const x0 = ext.x0 - off;
    const x1 = ext.x1 + off;
    const next = [];
    for (const s of out) {
      if (x1 <= s.x0 || x0 >= s.x1) {
        next.push(s);
        continue;
      }
      if (x0 > s.x0) next.push({ x0: s.x0, x1: x0 });
      if (x1 < s.x1) next.push({ x0: x1, x1: s.x1 });
    }
    out = next;
  }
  return out;
}

/** Whether an area frame sizes its height to its text (one row and column, a box, horizontal, not threaded). */
export function autoSized(node) {
  const o = node.areaOptions;
  return Boolean(o?.autoSize) && node.kind === 'area' && !node.vertical && !(node.areaPath && node.areaPath.length > 2) && !(node.threadNext || node.threadPrev) && (o.rows || 1) <= 1 && (o.columns || 1) <= 1;
}

/** Area frame cells: rows and columns of the box, or the container shape. */
function areaCells(node, vertical) {
  const o = node.areaOptions || {};
  const inset = Math.max(0, o.inset || 0);
  if (node.areaPath && node.areaPath.length > 2 && !vertical) {
    const poly = flattenPath(node.areaPath, true, 0.5);
    const b = pathBounds(node.areaPath, true) || { x: node.x, y: node.y, w: node.width, h: node.height };
    return { cells: [{ x: b.x, y: b.y, w: b.w, h: b.h, poly }], inset };
  }
  // Flow space for vertical type: u down the column, v from the right edge leftward.
  const W = vertical ? node.height : node.width;
  // Auto-sized frames grow with their text: lay out without a bottom.
  const H = vertical ? node.width : autoSized(node) ? 1e7 : node.height;
  const X = vertical ? 0 : node.x;
  const Y = vertical ? 0 : node.y;
  const rows = Math.max(1, Math.round(o.rows || 1));
  const cols = Math.max(1, Math.round(o.columns || 1));
  const rg = rows > 1 ? Math.max(0, o.rowGutter ?? 18) : 0;
  const cg = cols > 1 ? Math.max(0, o.columnGutter ?? 18) : 0;
  const cw = Math.max(1, (W - cg * (cols - 1)) / cols);
  const rh = Math.max(1, (H - rg * (rows - 1)) / rows);
  const cells = [];
  const byCols = o.flow === 'columns';
  for (let a = 0; a < (byCols ? cols : rows); a++) {
    for (let b = 0; b < (byCols ? rows : cols); b++) {
      const r = byCols ? b : a;
      const c = byCols ? a : b;
      cells.push({ x: X + c * (cw + cg), y: Y + r * (rh + rg), w: cw, h: rh, poly: null });
    }
  }
  return { cells, inset };
}

function slotsAt(cell, inset, y0, y1) {
  let s;
  if (!cell.poly) s = [{ x0: cell.x + inset, x1: cell.x + cell.w - inset }];
  else {
    s = polyIntervals(cell.poly, y0);
    s = intersectIntervals(s, polyIntervals(cell.poly, (y0 + y1) / 2));
    s = intersectIntervals(s, polyIntervals(cell.poly, y1));
    s = s.map((p) => ({ x0: p.x0 + inset, x1: p.x1 - inset })).filter((p) => p.x1 > p.x0);
  }
  if (cell.wraps) for (const w of cell.wraps) s = wrapSlots(s, w, y0, y1);
  return s;
}

function firstOffset(node, m) {
  const o = node.areaOptions || {};
  let v;
  switch (o.firstBaseline) {
    case 'leading':
      v = m.lead;
      break;
    case 'capHeight':
      v = m.cap;
      break;
    case 'xHeight':
      v = m.xh;
      break;
    case 'fixed':
      v = 0;
      break;
    default:
      v = m.asc;
  }
  return Math.max(v, o.minBaseline || 0);
}

/**
 * Flow a story through area frames: every cell (row/column) of each frame
 * in turn. `frames` are the threaded frames (the story's own node when not
 * threaded); `wraps[fi]` the text wrap obstacles in frame fi's local space.
 * Lines carry `frame` (index) and `cell`.
 */
function flowArea(node, text, ch, vertical, frames = [node], wraps = null, markers = null) {
  const cells = [];
  frames.forEach((f, fi) => {
    const ac = areaCells(f, vertical);
    const list = wraps?.[fi]?.list?.length ? wraps[fi].list : null;
    for (const c of ac.cells) cells.push({ ...c, frame: fi, inset: ac.inset, node: f, wraps: list });
  });
  const ranges = paragraphRanges(text);
  const lines = [];
  let ci = 0;
  let prevBase = null;
  let pendingSpace = 0;
  let overflow = false;
  let visibleEnd = 0;
  const empty = emptyMetrics(node);
  outer: for (let pi = 0; pi < ranges.length; pi++) {
    const pr = ranges[pi];
    const para = paraAt(node, pi);
    const stops = tabStops(para);
    const marker = markers?.[pi] || null;
    const J = (para.align || 'left').startsWith('justify') ? justificationOf(para) : null;
    const shrink = J && J.wordDesired > 0 ? Math.max(0, 1 - J.wordMin / J.wordDesired) : 0;
    const hyS = para.hyphenate ? hyphenationOf(para) : null;
    const every = para.composer === 'every' && !stops && !text.slice(pr.start, pr.end).includes('\t');
    let plan = null; // every-line composer: line start -> { end, hyph }
    let hyCount = 0; // hyphenated lines just before
    let pos = pr.start;
    let firstInPara = true;
    for (let guardRows = 0; guardRows < 100000; guardRows++) {
      if (ci >= cells.length) {
        overflow = true;
        break outer;
      }
      const cell = cells[ci];
      const inset = cell.inset;
      const top = cell.y + inset;
      const bottom = cell.y + cell.h - inset;
      const cellLeft = cell.x + inset;
      let m = lineMetrics(text, ch, pos, Math.min(pr.end, pos + 1)) || empty;
      const baseFor = (mm) => (prevBase == null ? top + firstOffset(cell.node, mm) : prevBase + mm.lead + (firstInPara ? pendingSpace + (para.spaceBefore || 0) : 0));
      let base = baseFor(m);
      let row = null;
      let rowEnd = pos;
      for (let tries = 0; tries < 2000; tries++) {
        if (base + m.desc > bottom + 0.01) break;
        const slots = slotsAt(cell, inset, base - m.asc, base + m.desc).filter((s) => s.x1 - s.x0 >= Math.min(cell.w - 2 * inset, m.lead * 0.5));
        if (!slots.length) {
          if (!cell.poly && !cell.wraps) break;
          base += Math.max(0.5, m.lead / 6);
          continue;
        }
        // Fill each slot on this row in turn.
        const build = (mm, bs) => {
          const out = [];
          let p = pos;
          let first = firstInPara;
          let hc = hyCount;
          for (const s of slots) {
            if (p >= pr.end && out.length) break;
            const left = lineLeft(para, first, first ? marker : null);
            const avail = s.x1 - s.x0 - left - (para.indentRight || 0);
            let e = p;
            let hy = false;
            if (p < pr.end) {
              let step = null;
              if (every) {
                // Composed for the width the lines get; a slot of another width (a shaped frame, a wrap) composes the rest again.
                const rest = Math.max(1, s.x1 - s.x0 - lineLeft(para, false, null) - (para.indentRight || 0));
                const width = first ? avail : rest;
                if (!plan || !plan.has(p) || Math.abs(plan.width - width) > 0.5) {
                  plan = composeParagraph(text, ch, p, pr.end, Math.max(1, avail), rest, para, hyS, hc);
                  if (plan) plan.width = width;
                }
                step = plan?.get(p) || null;
                if (step && !planFits(text, ch, p, step, avail, shrink, para)) {
                  step = null;
                  plan = null;
                }
              }
              if (step) {
                e = step.end;
                hy = step.hyph;
              } else {
                e = fillLine(text, ch, p, pr.end, Math.max(1, avail), { stops, origin: s.x0 - cellLeft + left }, { shrink, hy: hyS ? { s: hyS, count: hc } : null });
                hy = ch.lastHyphen;
              }
            }
            hc = hy ? hc + 1 : 0;
            const lm = lineMetrics(text, ch, p, e) || mm;
            out.push({ s, p, e, first, lm, hy });
            first = false;
            p = e;
          }
          return { out, p, bs, hc };
        };
        let built = build(m, base);
        let actual = built.out.reduce((acc, r) => ({ asc: Math.max(acc.asc, r.lm.asc), desc: Math.max(acc.desc, r.lm.desc), lead: Math.max(acc.lead, r.lm.lead), cap: Math.max(acc.cap, r.lm.cap), xh: Math.max(acc.xh, r.lm.xh) }), { asc: 0, desc: 0, lead: 0, cap: 0, xh: 0 });
        if (actual.asc > m.asc + 1e-6 || actual.lead > m.lead + 1e-6 || actual.desc > m.desc + 1e-6) {
          m = { asc: Math.max(m.asc, actual.asc), desc: Math.max(m.desc, actual.desc), lead: Math.max(m.lead, actual.lead), cap: Math.max(m.cap, actual.cap), xh: Math.max(m.xh, actual.xh) };
          base = Math.max(base, baseFor(m));
          if (base + m.desc > bottom + 0.01) break;
          continue;
        }
        row = built.out.map((r) => {
          const line = makeLine(text, ch, r.p, r.e, pi, para, r.first, r.e >= pr.end, r.s, m, false, { cellLeft, marker: r.first ? marker : null, hyphen: r.hy });
          line.y = base;
          line.asc = m.asc;
          line.desc = m.desc;
          line.lead = m.lead;
          line.cell = ci;
          line.frame = cell.frame;
          return line;
        });
        rowEnd = built.p;
        hyCount = built.hc;
        break;
      }
      if (!row) {
        ci++;
        prevBase = null;
        continue;
      }
      lines.push(...row);
      visibleEnd = rowEnd;
      prevBase = base;
      pos = rowEnd;
      firstInPara = false;
      if (pos >= pr.end) break;
    }
    visibleEnd = pr.end;
    pendingSpace = para.spaceAfter || 0;
  }
  if (overflow) visibleEnd = lines.length ? lines[lines.length - 1].end : 0;
  if (!vertical) alignVertically(cells, lines);
  return { lines, overflow: overflow && visibleEnd < text.length, visibleEnd, cells, inset: cells[0]?.inset || 0 };
}

/** Area type vertical alignment (areaOptions.verticalAlign: top | center | bottom | justify) in each box cell. */
function alignVertically(cells, lines) {
  cells.forEach((cell, ci) => {
    const va = cell.node.areaOptions?.verticalAlign;
    if (!va || va === 'top' || cell.poly || cell.wraps || autoSized(cell.node)) return;
    const ls = lines.filter((l) => l.cell === ci);
    if (!ls.length) return;
    const last = ls[ls.length - 1];
    const slack = cell.y + cell.h - cell.inset - (last.y + last.desc);
    if (!(slack > 0.01)) return;
    if (va === 'justify') {
      const rows = [...new Set(ls.map((l) => l.y))];
      if (rows.length < 2) return;
      const per = slack / (rows.length - 1);
      for (const l of ls) l.y += per * rows.indexOf(l.y);
      return;
    }
    const d = va === 'center' ? slack / 2 : va === 'bottom' ? slack : 0;
    for (const l of ls) l.y += d;
  });
}

/** Width of the content of [a, b) (trailing spaces left out). */
function contentWidth(text, ch, a, b) {
  while (b > a && (isSpace(text[b - 1]) || text[b - 1] === LINE_SEP)) b--;
  let w = 0;
  for (let i = a; i < b; i++) w += ch.adv[i] + (i > a ? ch.kern[i] + ch.manual[i] : 0);
  return w;
}

/** Whether a composed line still fits the room it gets (frames can narrow below the first line). */
function planFits(text, ch, a, step, avail, shrink, para) {
  let w = contentWidth(text, ch, a, step.end) + (step.hyph ? hyphenWidth(ch, step.end - 1) : 0);
  if (shrink) {
    let sp = 0;
    for (let i = a; i < step.end; i++) if (text[i] === ' ') sp += ch.adv[i];
    w -= sp * shrink;
  }
  if (para.hangingPunctuation || para.opticalMargin) w -= ch.adv[a] || 0; // hanging characters may sit outside
  return w <= avail + 0.5;
}

/**
 * Every-line composer: line breaks for the rest of a paragraph from `from`
 * chosen together, so lines come out evenly full (even word spacing in
 * justified text, an even rag otherwise) and hyphens are rare and not
 * stacked. Candidate breaks are word boundaries, dashes, forced line breaks
 * and (with hyphenation) hyphenation points; the cost of a line grows with
 * the cube of how far it stretches or squeezes, and the cheapest sequence
 * wins. Returns a Map line start -> { end, hyph }, or null when some word
 * cannot fit (the greedy filler then breaks it).
 */
function composeParagraph(text, ch, from, pe, availFirst, availRest, para, hyS, hyCount0 = 0) {
  if (pe - from < 2) return null;
  const align = para.align || 'left';
  const J = justificationOf(para);
  const just = align.startsWith('justify');
  const wd = J.wordDesired || 100;
  const shrinkK = just ? Math.max(0, 1 - J.wordMin / wd) : 0;
  const stretchK = Math.max(0, J.wordMax / wd - 1);
  const n = pe - from;
  // Prefix sums: widths (with kerning inside the line), space widths and glyph widths.
  const P = zeros(n + 1);
  const S = zeros(n + 1);
  const G = zeros(n + 1);
  for (let k = 0; k < n; k++) {
    const i = from + k;
    P[k + 1] = P[k] + ch.adv[i] + (k > 0 ? ch.kern[i] + ch.manual[i] : 0);
    const sp = text[i] === ' ' || text[i] === '\u3000';
    S[k + 1] = S[k] + (sp ? ch.adv[i] : 0);
    G[k + 1] = G[k] + (sp ? 0 : ch.gw[i]);
  }
  const cands = [];
  for (let i = from; i < pe; i++) {
    const c = text[i];
    if (c === LINE_SEP) cands.push({ b: i + 1, forced: true });
    else if (isSpace(c)) {
      if (i + 1 < pe && !isSpace(text[i + 1]) && canBreak(ch, i + 1, pe)) cands.push({ b: i + 1 });
    } else if ((isDash(c) || isCJK(c) || isCJK(text[i + 1])) && i + 1 < pe && canBreak(ch, i + 1, pe)) cands.push({ b: i + 1 });
  }
  if (hyS) {
    for (let i = from; i < pe; ) {
      if (!isLetter(text[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j < pe && isLetter(text[j])) j++;
      let ok = true;
      for (let k = i; k < j; k++) if (ch.sty[k]?.noBreak || ch.glyph?.[k] === -1) ok = false;
      if (ok) for (const k of hyphenPoints(text.slice(i, j), hyS, ch.sty[i]?.language)) if (ch.glyph?.[i + k] !== -1) cands.push({ b: i + k, hyph: true, ws: i });
      i = j;
    }
  }
  cands.sort((p, q) => p.b - q.b);
  cands.push({ b: pe, last: true });
  const ref = ch.sty[from] ? spaceWidth(ch.sty[from], ch.size[from]) : 3;
  const best = new Array(cands.length).fill(null);
  const startNode = { cost: 0, hyph: false, count: hyCount0 };
  for (let ai = -1; ai < cands.length - 1; ai++) {
    const A = ai < 0 ? startNode : best[ai];
    if (!A) continue;
    const a = ai < 0 ? from : cands[ai].b;
    const avail = a === from ? availFirst : availRest;
    for (let bi = ai + 1; bi < cands.length; bi++) {
      const C = cands[bi];
      let ce = C.b;
      while (ce > a && (isSpace(text[ce - 1]) || text[ce - 1] === LINE_SEP)) ce--;
      const ka = a > from && a < pe ? ch.kern[a] + ch.manual[a] : 0;
      const base = P[ce - from] - P[a - from] - ka;
      const w = base + (C.hyph ? hyphenWidth(ch, C.b - 1) : 0);
      const spW = S[ce - from] - S[a - from];
      const lastLine = Boolean(C.last);
      const justLine = just && (!lastLine || align === 'justify-all');
      // Justified paragraphs may squeeze word spaces on every line, the last one too.
      const shrink = just ? spW * shrinkK : 0;
      if (base - shrink > avail + 1e-6) break;
      if (w - shrink > avail + 1e-6) continue;
      if (C.hyph && hyS?.limit > 0 && A.count >= hyS.limit) continue;
      const slack = avail - w;
      // Unjustified text hyphenates only when the line would otherwise end farther than the zone from the margin.
      if (C.hyph && !just && hyS.zone > 0 && C.ws > a) {
        let we = C.ws;
        while (we > a && isSpace(text[we - 1])) we--;
        if (avail - (P[we - from] - P[a - from] - ka) < hyS.zone) continue;
      }
      let bad;
      if (justLine) {
        const gaps = Math.max(0, ce - a - 1);
        const stretch = spW * stretchK + gaps * ref * ((J.letterMax - J.letterDesired) / 100) + ((G[ce - from] - G[a - from]) * (J.glyphMax - (J.glyphDesired || 100))) / (J.glyphDesired || 100);
        const r = slack >= 0 ? (stretch > 0 ? slack / stretch : slack > 1 ? 10 : 0) : shrink > 0 ? -slack / shrink : 10;
        bad = 100 * Math.min(10, r) ** 3;
      } else if (lastLine) bad = slack < 0 && shrink > 0 ? 100 * Math.min(10, -slack / shrink) ** 3 : 0;
      else bad = 100 * ((3 * slack) / Math.max(1, avail)) ** 2;
      let d = (10 + bad) ** 2;
      if (C.hyph) d += A.hyph ? 13000 : 3000;
      const cost = A.cost + d;
      if (!best[bi] || cost < best[bi].cost) best[bi] = { cost, prev: ai, hyph: Boolean(C.hyph), count: C.hyph ? A.count + 1 : 0 };
      if (C.forced) break;
    }
  }
  if (!best[cands.length - 1]) return null;
  const plan = new Map();
  for (let bi = cands.length - 1; bi >= 0; ) {
    const B = best[bi];
    const a = B.prev < 0 ? from : cands[B.prev].b;
    plan.set(a, { end: cands[bi].b, hyph: B.hyph });
    bi = B.prev;
  }
  return plan;
}

function flowPoint(node, text, ch, anchorX, markers = null) {
  const ranges = paragraphRanges(text);
  const lines = [];
  const empty = emptyMetrics(node);
  let prevBase = null;
  let pendingSpace = 0;
  for (let pi = 0; pi < ranges.length; pi++) {
    const pr = ranges[pi];
    const para = paraAt(node, pi);
    // Forced line breaks split a paragraph into several lines.
    let start = pr.start;
    let first = true;
    for (;;) {
      let end = pr.end;
      for (let i = start; i < pr.end; i++) {
        if (text[i] === LINE_SEP) {
          end = i + 1;
          break;
        }
      }
      const m = lineMetrics(text, ch, start, end) || empty;
      const base = prevBase == null ? 0 : prevBase + m.lead + (first ? pendingSpace + (para.spaceBefore || 0) : 0);
      const line = makeLine(text, ch, start, end, pi, para, first, end >= pr.end, { x0: anchorX, x1: anchorX }, m, true, { marker: first ? markers?.[pi] : null });
      line.y = base;
      lines.push(line);
      prevBase = base;
      first = false;
      if (end >= pr.end) break;
      start = end;
    }
    pendingSpace = para.spaceAfter || 0;
  }
  return { lines, overflow: false, visibleEnd: text.length };
}

// ---- path frames ----

function pathFrame(node) {
  let anchors = node.pathAnchors || [];
  const opts = node.pathOptions || {};
  if (opts.flip) anchors = anchors.slice().reverse().map((p) => ({ ...p, ix: p.ox, iy: p.oy, ox: p.ix, oy: p.iy }));
  const pts = flattenPath(anchors, Boolean(node.pathClosed), 0.2);
  const cum = zeros(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const length = pts.length ? cum[pts.length - 1] : 0;
  const at = (u) => {
    if (pts.length < 2) return { x: pts[0]?.x || 0, y: pts[0]?.y || 0, tx: 1, ty: 0 };
    const uu = Math.max(0, Math.min(length, u));
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= uu) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const seg = cum[hi] - cum[lo] || 1;
    const t = (uu - cum[lo]) / seg;
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    // Extrapolate along the end tangents beyond the path ends.
    const extra = u < 0 ? u : u > length ? u - length : 0;
    return { x: a.x + (b.x - a.x) * t + tx * extra, y: a.y + (b.y - a.y) * t + ty * extra, tx, ty };
  };
  const project = (x, y) => {
    let best = { u: 0, d: Infinity };
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d < best.d) {
        const l = Math.sqrt(l2);
        const side = (dx * (y - a.y) - dy * (x - a.x)) / l; // + = right of travel (below for left-to-right)
        best = { u: cum[i] + t * l, d, v: side };
      }
    }
    return best;
  };
  let center = null;
  if (pts.length) {
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    center = { x: sx / pts.length, y: sy / pts.length };
  }
  return { pts, length, at, project, center, closed: Boolean(node.pathClosed) };
}

function flowPath(node, text, ch, frame, vertical) {
  const n = text.length;
  const empty = emptyMetrics(node);
  const m = lineMetrics(text, ch, 0, n) || empty;
  const para = paraAt(node, 0);
  const rel = positions(text, ch, 0, n);
  const start = node.pathOptions?.start || 0;
  const spacing = node.pathOptions?.spacing || 0;
  const L = frame.length;
  // Spacing evens out the gaps around bends: characters on the outside of a
  // curve move closer together, those on the inside further apart, in
  // proportion to how much the path turns between them.
  const adj = zeros(n + 1);
  if (spacing && n > 1) {
    let add = 0;
    let prev = null;
    for (let i = 0; i < n; i++) {
      const p = frame.at(start + rel[i] + add + ch.adv[i] / 2);
      if (prev) {
        const turn = prev.tx * p.ty - prev.ty * p.tx;
        add = Math.max(add - (rel[i] - rel[i - 1]) * 0.9, add - spacing * turn);
      }
      adj[i] = add;
      prev = p;
    }
    adj[n] = add;
  }
  const width = rel[n] + adj[n];
  let u0 = start;
  const align = para.align || 'left';
  if (align === 'center' || align === 'justify-center') u0 = start + (L - start - width) / 2;
  else if (align === 'right' || align === 'justify-right') u0 = L - width;
  const xs = zeros(n + 1);
  for (let k = 0; k <= n; k++) xs[k] = u0 + rel[k] + adj[k];
  // Characters whose center falls beyond the path end overflow.
  let visibleEnd = n;
  for (let i = 0; i < n; i++) {
    if (xs[i] + ch.adv[i] / 2 > L + 0.01) {
      visibleEnd = i;
      break;
    }
  }
  const alignTo = node.pathOptions?.align || 'baseline';
  const vOff = vertical ? 0 : alignTo === 'ascender' ? m.asc : alignTo === 'descender' ? -m.desc : alignTo === 'center' ? (m.asc - m.desc) / 2 : 0;
  const line = { start: 0, end: n, contentEnd: n, xs, x: xs[0], width, y: vOff, asc: m.asc, desc: m.desc, lead: m.lead, para: 0, justified: false, text, visibleEnd, extras: null };
  return { lines: [line], overflow: visibleEnd < n, visibleEnd };
}

// ---- layout ----

const ID = [1, 0, 0, 1, 0, 0];

function invertM(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

function applyM(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function sameList(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Text wrap obstacles for an area frame (see textHooks.wraps): { deps, list } or null. */
function wrapsOf(node, vertical) {
  if (node.kind !== 'area' || vertical || !textHooks.wraps) return null;
  return textHooks.wraps(node) || null;
}

/** Threaded frames of a node (head first), or null when it is not threaded. */
function storyFrames(node) {
  if (node.kind !== 'area' || !(node.threadNext || node.threadPrev) || !textHooks.story) return null;
  const frames = textHooks.story(node);
  return frames && frames.length > 1 ? frames : null;
}

/** Common layout record for a flow result. */
function finish(node, source, kind, vertical, text, ch, flow, toLocal, fromLocal, path, cells) {
  const { lines } = flow;
  const first = lines[0];
  const empty = first ? null : emptyMetrics(source);
  const lay = {
    kind,
    vertical,
    text,
    lines,
    chars: ch,
    overflow: Boolean(flow.overflow),
    visibleEnd: flow.visibleEnd,
    ascent: first ? first.asc : empty.asc,
    descent: first ? first.desc : empty.desc,
    leading: first ? first.lead : empty.lead,
    toLocal,
    fromLocal,
    path,
    cells,
    inset: flow.inset || 0,
    node,
    source,
  };
  lay.bounds = layoutBounds(node, lay);
  return lay;
}

function areaMapping(node, vertical) {
  if (vertical) {
    const right = node.x + node.width;
    return { toLocal: (u, v) => ({ x: right - v, y: node.y + u }), fromLocal: (x, y) => ({ u: y - node.y, v: right - x }) };
  }
  return { toLocal: (u, v) => ({ x: u, y: v }), fromLocal: (x, y) => ({ u: x, v: y }) };
}

function buildLayout(node, wraps) {
  const text = String(node.text ?? '');
  const kind = node.kind === 'path' && node.pathAnchors?.length ? 'path' : node.kind === 'area' ? 'area' : 'point';
  const vertical = Boolean(node.vertical);
  const ch = measureChars(node, text, vertical);
  const markers = kind === 'path' ? null : listMarkers(node, text, ch);
  let flow;
  let toLocal;
  let fromLocal;
  let path = null;
  let cells = null;
  if (kind === 'path') {
    path = pathFrame(node);
    flow = flowPath(node, text, ch, path, vertical);
    toLocal = (u, v) => {
      const p = path.at(u);
      return { x: p.x - p.ty * v, y: p.y + p.tx * v };
    };
    fromLocal = (x, y) => {
      const pr = path.project(x, y);
      return { u: pr.u, v: pr.v ?? 0 };
    };
  } else if (kind === 'area') {
    flow = flowArea(node, text, ch, vertical, [node], wraps ? [wraps] : null, markers);
    cells = flow.cells;
    ({ toLocal, fromLocal } = areaMapping(node, vertical));
  } else {
    flow = flowPoint(node, text, ch, vertical ? 0 : node.x, markers);
    if (vertical) {
      toLocal = (u, v) => ({ x: node.x - v, y: node.y + u });
      fromLocal = (x, y) => ({ u: y - node.y, v: node.x - x });
    } else {
      // Point type baselines start at node.y.
      for (const l of flow.lines) l.y += node.y;
      toLocal = (u, v) => ({ x: u, y: v });
      fromLocal = (x, y) => ({ u: x, v: y });
    }
  }
  return finish(node, node, kind, vertical, text, ch, flow, toLocal, fromLocal, path, cells);
}

/**
 * Layouts of every frame of a threaded story, cached on the story's first
 * frame (the node holding the text) and the identities of all frames and
 * their wrap obstacles.
 */
function storyLayouts(frames) {
  const head = frames[0];
  const vertical = Boolean(head.vertical);
  const wraps = frames.map((f) => wrapsOf(f, vertical));
  const deps = wraps.map((w) => w?.deps || null);
  const c = storyCache.get(head);
  if (c && sameList(c.frameList, frames) && c.deps.every((d, i) => sameList(d, deps[i]))) return c;
  const text = String(head.text ?? '');
  const ch = measureChars(head, text, vertical);
  const markers = listMarkers(head, text, ch);
  const flow = flowArea(head, text, ch, vertical, frames, wraps, markers);
  let end = 0;
  const layouts = frames.map((f, fi) => {
    const lines = flow.lines.filter((l) => l.frame === fi);
    if (lines.length) end = lines[lines.length - 1].end;
    const last = fi === frames.length - 1;
    const sub = { lines, overflow: last && flow.overflow, visibleEnd: last ? flow.visibleEnd : end, inset: (f.areaOptions?.inset || 0) };
    const { toLocal, fromLocal } = areaMapping(f, vertical);
    const lay = finish(f, head, 'area', vertical, text, ch, sub, toLocal, fromLocal, null, flow.cells.filter((cell) => cell.frame === fi));
    lay.story = { head, frames, index: fi, overflow: flow.overflow, visibleEnd: flow.visibleEnd, start: lines.length ? lines[0].start : end };
    return lay;
  });
  const entry = { frameList: frames, deps, frames: layouts, flow, edit: null };
  storyCache.set(head, entry);
  return entry;
}

/**
 * Lay out a text node. Returns (in the node's local space unless noted):
 *   kind, vertical, lines: [{ start, end, contentEnd, xs, x, y, width, asc, desc, lead, para, text, extras }]
 *     where xs[k] is the flow-space position of caret index start + k and
 *     y is the baseline's flow position; extras are drawn strings that are
 *     not characters of the text (list markers, tab leaders, hyphens),
 *   chars: per-character arrays (display char, style, size, advance, ...),
 *   bounds { x, y, w, h }, overflow, visibleEnd, ascent, descent, leading,
 *   toLocal(u, v) / fromLocal(x, y) flow mapping, path (for type on a path),
 *   source: the node holding the text (the first frame of a threaded story),
 *   story: { head, frames, index, ... } for threaded frames.
 * A threaded frame shows the part of the story that flows into it.
 */
export function layoutText(node) {
  const frames = storyFrames(node);
  if (frames) {
    let idx = frames.indexOf(node);
    if (idx < 0) idx = frames.findIndex((f) => f.id === node.id);
    if (idx >= 0) return storyLayouts(frames).frames[idx];
  }
  const wraps = wrapsOf(node, Boolean(node.vertical));
  const hit = layoutCache.get(node);
  if (hit && sameList(hit.wrapDeps, wraps?.deps || null)) return hit;
  const lay = buildLayout(node, wraps);
  lay.wrapDeps = wraps?.deps || null;
  layoutCache.set(node, lay);
  return lay;
}

/**
 * Layout for editing a text: the node's own layout, or for a threaded story
 * every frame's lines in one list, mapped into the first frame's local space
 * (each line carries its own toLocal/fromLocal), so carets and selections
 * move through all frames.
 */
export function editLayout(node) {
  const frames = storyFrames(node);
  if (!frames) return layoutText(node);
  const entry = storyLayouts(frames);
  if (entry.edit) return entry.edit;
  const head = frames[0];
  const hi = invertM(head.transform || ID);
  const lines = [];
  entry.frames.forEach((lay, fi) => {
    const M = mul(hi, frames[fi].transform || ID);
    const Mi = invertM(M);
    for (const l of lay.lines) {
      lines.push({
        ...l,
        frame: fi,
        toLocal: (u, v) => {
          const p = lay.toLocal(u, v);
          return applyM(M, p.x, p.y);
        },
        fromLocal: (x, y) => {
          const p = applyM(Mi, x, y);
          return lay.fromLocal(p.x, p.y);
        },
      });
    }
  });
  entry.edit = { ...entry.frames[0], lines, overflow: entry.flow.overflow, visibleEnd: entry.flow.visibleEnd, composite: true, frameLayouts: entry.frames, frames };
  return entry.edit;
}

function layoutBounds(node, lay) {
  if (lay.kind === 'area') {
    if (node.areaPath && node.areaPath.length > 2 && !lay.vertical) return pathBounds(node.areaPath, true);
    return { x: node.x, y: node.y, w: node.width, h: node.height };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  if (lay.kind === 'path') {
    const pb = pathBounds(node.pathAnchors, Boolean(node.pathClosed));
    if (pb) {
      add({ x: pb.x, y: pb.y });
      add({ x: pb.x + pb.w, y: pb.y + pb.h });
    }
    for (const g of glyphPlacements(lay)) {
      const { m } = g;
      const top = -lay.chars.asc[g.i];
      const bot = lay.chars.desc[g.i];
      const w = g.w;
      for (const [gx, gy] of [[0, top], [w, top], [w, bot], [0, bot]]) add({ x: m[0] * gx + m[2] * gy + m[4], y: m[1] * gx + m[3] * gy + m[5] });
    }
  } else {
    for (const l of lay.lines) {
      let u0 = Math.min(l.x, l.x + l.width);
      let u1 = Math.max(l.x, l.x + l.width);
      for (const e of l.extras || []) {
        u0 = Math.min(u0, e.u);
        u1 = Math.max(u1, e.u + (e.w || 0));
      }
      add(lay.toLocal(u0, l.y - l.asc));
      add(lay.toLocal(u1, l.y + l.desc));
      add(lay.toLocal(u0, l.y + l.desc));
      add(lay.toLocal(u1, l.y - l.asc));
    }
  }
  if (minX === Infinity) {
    const p = lay.toLocal(0, 0);
    return { x: p.x, y: p.y - lay.ascent, w: 0, h: lay.ascent + lay.descent };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---- glyph placement ----

const GLYPH_CACHE = new WeakMap();
const EXTRA_CACHE = new WeakMap();

/**
 * Placements of a layout's extras (list markers, tab leaders, hyphens at
 * discretionary breaks), in the form glyphPlacements() uses, with
 * `extra: true`. Horizontal and vertical area and point type only.
 */
export function extraPlacements(lay) {
  let out = EXTRA_CACHE.get(lay);
  if (out) return out;
  out = [];
  if (lay.kind !== 'path') {
    for (const line of lay.lines) {
      if (!line.extras) continue;
      for (const x of line.extras) {
        const st = x.style;
        const hs = (st.horizontalScale ?? 100) / 100;
        const vs = (st.verticalScale ?? 100) / 100;
        let m;
        if (lay.vertical) {
          const p = lay.toLocal(0, line.y);
          m = [hs, 0, 0, vs, p.x - (x.w || 0) / 2, lay.toLocal(x.u + st.fontSize * vs * 0.82, line.y).y];
        } else m = [hs, 0, 0, vs, x.u, line.y - riseOf(st)];
        out.push({ i: line.start, ch: x.str, style: st, size: x.size, adv: 0, w: (x.w || 0) / hs, m, glyph: null, extra: true });
      }
    }
  }
  EXTRA_CACHE.set(lay, out);
  return out;
}

/**
 * One entry per visible, drawable character: { i, ch (display), style,
 * size (draw size), adv, m } where m maps glyph space (origin at the
 * baseline start, x right, y down, in px at `size` with scales applied) to
 * the node's local space, followed by the layout's extras (`extra: true`).
 * Drawing and outline conversion both use it.
 */
export function glyphPlacements(lay) {
  let out = GLYPH_CACHE.get(lay);
  if (out) return out;
  out = [];
  const { chars: ch, text } = lay;
  for (const line of lay.lines) {
    const last = lay.kind === 'path' ? Math.min(line.contentEnd, line.visibleEnd ?? line.contentEnd) : line.contentEnd;
    for (let i = line.start; i < last; i++) {
      const c = text[i];
      if (c === '\n' || c === '\t' || c === ' ' || c === '　' || c === LINE_SEP || c === SHY) continue;
      const glyph = ch.glyph ? ch.glyph[i] : undefined;
      if (glyph === -1) continue; // part of the ligature drawn at an earlier character
      const st = ch.sty[i];
      const hs = (st.horizontalScale ?? 100) / 100;
      const vs = (st.verticalScale ?? 100) / 100;
      const x = line.xs[i - line.start];
      const rise = riseOf(st);
      const adv = ch.adv[i] - ((st.tracking || 0) / 1000) * st.fontSize;
      let m;
      if (lay.kind === 'path' && lay.vertical) {
        // Upright characters stacked along the path: the glyph's down axis follows the path.
        const em = st.fontSize * vs;
        const p = lay.path.at(x + adv / 2);
        const t = [p.tx, p.ty];
        const xa = [p.ty, -p.tx];
        const along = em * 0.82 - adv / 2;
        const side = ch.gw[i] / 2 - rise;
        m = [xa[0] * hs, xa[1] * hs, t[0] * vs, t[1] * vs, p.x + t[0] * along - xa[0] * side, p.y + t[1] * along - xa[1] * side];
      } else if (lay.kind === 'path') {
        const uc = x + adv / 2;
        const p = lay.path.at(uc);
        const eff = lay.node.pathOptions?.effect || 'rainbow';
        let ex = [p.tx, p.ty];
        let ey = [-p.ty, p.tx];
        if (eff === 'skew') ey = [0, Math.sign(p.tx) || 1];
        else if (eff === 'ribbon') ex = [Math.sign(p.tx) || 1, 0];
        else if (eff === 'stair') {
          ex = [1, 0];
          ey = [0, 1];
        } else if (eff === 'gravity' && lay.path.center) {
          let gx = lay.path.center.x - p.x;
          let gy = lay.path.center.y - p.y;
          const l = Math.hypot(gx, gy) || 1;
          gx /= l;
          gy /= l;
          // Keep the reading direction of the path.
          const s = gy * p.tx - gx * p.ty >= 0 ? 1 : -1;
          ey = [gx * s, gy * s];
          ex = [ey[1], -ey[0]];
        }
        const v = line.y - rise;
        const ox = p.x - (ex[0] * adv) / 2 + ey[0] * v;
        const oy = p.y - (ex[1] * adv) / 2 + ey[1] * v;
        m = [ex[0] * hs, ex[1] * hs, ey[0] * vs, ey[1] * vs, ox, oy];
      } else if (lay.vertical) {
        const top = x;
        const em = st.fontSize * vs;
        const base = top + em * 0.82;
        const p = lay.toLocal(0, line.y);
        const gw = ch.gw[i];
        m = [hs, 0, 0, vs, p.x - gw / 2 + rise, lay.toLocal(base, line.y).y];
      } else {
        // Paragraph glyph scaling (desired and justification) widens the glyph.
        const gsc = (ch.gs ? ch.gs[i] : 1) * (line.gscale || 1);
        m = [hs * gsc, 0, 0, vs, x, line.y - rise];
      }
      if (st.rotation) {
        const r = (-st.rotation * Math.PI) / 180;
        const cx = adv / hs / 2;
        const cy = -ch.size[i] * 0.35;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        // m * T(c) * R * T(-c)
        const rot = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        m = mul(m, rot);
      }
      let str = ch.disp[i];
      if (glyph != null) for (let k = i + 1; k < last && ch.glyph[k] === -1; k++) str += ch.disp[k];
      out.push({ i, ch: str, style: st, size: ch.size[i], adv: ch.adv[i], w: adv / hs, m, glyph: glyph ?? null });
    }
  }
  for (const g of extraPlacements(lay)) out.push(g);
  GLYPH_CACHE.set(lay, out);
  return out;
}

function mul(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

/** True when a layout can be drawn as horizontal line segments (the fast path). */
export function drawsAsSegments(lay) {
  if (lay.kind === 'path' || lay.vertical || lay.chars.shaped || lay.chars.perGlyph) return false;
  for (const l of lay.lines) if (l.spread) return false;
  for (const r of styledRuns(lay.source || lay.node)) if (r.style.rotation) return false;
  return true;
}

// ---- caret mapping ----

/** Line index for a caret index. */
export function lineIndexOf(lay, index) {
  const { lines } = lay;
  if (!lines.length) return -1;
  let li = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= index) li = i;
    else break;
  }
  return li;
}

/**
 * Caret geometry for an index: { x, y (baseline point), line, top, bottom }
 * in local space; top/bottom are the caret line's end points.
 */
export function caretPosition(lay, index) {
  const { lines } = lay;
  const li = lineIndexOf(lay, index);
  if (li < 0) {
    const p = lay.toLocal(lay.kind === 'point' && !lay.vertical ? lay.node.x : 0, lay.kind === 'point' && !lay.vertical ? lay.node.y : 0);
    const asc = lay.ascent;
    return { x: p.x, y: p.y, line: 0, u: 0, top: { x: p.x, y: p.y - asc }, bottom: { x: p.x, y: p.y + lay.descent } };
  }
  const l = lines[li];
  const k = Math.max(0, Math.min(l.end, index) - l.start);
  const u = l.xs[Math.min(k, l.xs.length - 1)];
  const toLocal = l.toLocal || lay.toLocal;
  const p = toLocal(u, l.y);
  return { x: p.x, y: p.y, u, line: li, top: toLocal(u, l.y - l.asc), bottom: toLocal(u, l.y + l.desc) };
}

/** Caret index in a line nearest flow position u. */
export function indexInLine(lay, li, u) {
  const l = lay.lines[li];
  if (!l) return 0;
  let best = l.start;
  let bestD = Infinity;
  const last = l.end > l.contentEnd && lay.lines[li + 1] && lay.lines[li + 1].start === l.end ? l.end - 1 : l.end;
  for (let i = l.start; i <= Math.max(l.start, last); i++) {
    const d = Math.abs(l.xs[i - l.start] - u);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Caret index from a local point. */
export function hitTestText(lay, x, y) {
  const { lines } = lay;
  if (!lines.length) return 0;
  const f0 = lay.fromLocal(x, y);
  if (lay.kind === 'path') return indexInLine(lay, 0, f0.u);
  let li = 0;
  let bestD = Infinity;
  let bestU = f0.u;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Threaded stories: each line maps the point into its own frame.
    const f = l.fromLocal ? l.fromLocal(x, y) : f0;
    const top = l.y - l.asc;
    const bot = l.y + l.desc;
    let d = f.v < top ? top - f.v : f.v > bot ? f.v - bot : 0;
    // Same row (several slots or cells): prefer the slot under u.
    const u0 = Math.min(l.xs[0], l.xs[l.xs.length - 1]);
    const u1 = Math.max(l.xs[0], l.xs[l.xs.length - 1]);
    const du = f.u < u0 ? u0 - f.u : f.u > u1 ? f.u - u1 : 0;
    d = d * 1000 + du;
    if (d < bestD) {
      bestD = d;
      li = i;
      bestU = f.u;
    }
  }
  return indexInLine(lay, li, bestU);
}

/**
 * Highlight polygons (local space) for the selection [a, b): one quad per
 * line piece (and per character on a path).
 */
export function selectionPolygons(lay, a, b) {
  const out = [];
  if (b <= a) return out;
  for (const l of lay.lines) {
    const s = Math.max(a, l.start);
    const e = Math.min(b, l.end);
    const includesBreak = b > l.end && a <= l.end && lay.text[l.end] === '\n';
    if (e < s || (e === s && !includesBreak)) continue;
    const u0 = l.xs[s - l.start];
    let u1 = l.xs[e - l.start];
    if (includesBreak) u1 += (l.asc + l.desc) * 0.3;
    if (lay.kind === 'path') {
      const steps = Math.max(1, Math.ceil(Math.abs(u1 - u0) / 4));
      const top = [];
      const bot = [];
      for (let k = 0; k <= steps; k++) {
        const u = u0 + ((u1 - u0) * k) / steps;
        top.push(lay.toLocal(u, l.y - l.asc));
        bot.push(lay.toLocal(u, l.y + l.desc));
      }
      out.push([...top, ...bot.reverse()]);
    } else {
      const toLocal = l.toLocal || lay.toLocal;
      out.push([toLocal(u0, l.y - l.asc), toLocal(u1, l.y - l.asc), toLocal(u1, l.y + l.desc), toLocal(u0, l.y + l.desc)]);
    }
  }
  return out;
}

/** Precise hit test in local space for type on a path (near the path or a glyph). */
export function hitTextLocal(lay, x, y, tol) {
  const b = lay.bounds;
  if (x < b.x - tol || x > b.x + b.w + tol || y < b.y - tol || y > b.y + b.h + tol) return false;
  if (lay.kind !== 'path') return true;
  const pr = lay.path.project(x, y);
  if (pr.d <= tol + 1) return true;
  for (const g of glyphPlacements(lay)) {
    const m = g.m;
    const det = m[0] * m[3] - m[1] * m[2] || 1;
    const dx = x - m[4];
    const dy = y - m[5];
    const gx = (m[3] * dx - m[2] * dy) / det;
    const gy = (-m[1] * dx + m[0] * dy) / det;
    if (gx >= -tol && gx <= g.w + tol && gy >= -lay.chars.asc[g.i] - tol && gy <= lay.chars.desc[g.i] + tol) return true;
  }
  return false;
}
