import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Compare two versions of a PDF, the way Acrobat's Compare Files tool does: line up the pages
 * of both documents, diff their text word by word, and report what was inserted, deleted,
 * replaced or restyled, along with added, removed and moved pages and changed pictures.
 *
 *   extractComparable(pdf, { signal, onProgress, renderPage }) -> Comparable
 *   compareDocuments(oldDoc, newDoc, { signal, onProgress })    -> CompareResult
 *   buildCompareReport(result, { oldName, newName })             -> Promise<Uint8Array>
 *
 * Comparable = { pages: PageData[] }
 * PageData = { index, view: [x1, y1, x2, y2], rotate, width, height (displayed, rotation applied),
 *              words: Word[], images: { rect, w, h }[], paths: number, pathHash: number,
 *              renderHash: string | number | null }
 * Word = { text, key (normalized for matching), rect: [x1, y1, x2, y2], line, font, size }
 *
 * CompareResult = {
 *   summary: { pages: { old, new }, total, inserted, deleted, replaced, formatting,
 *              pagesAdded, pagesRemoved, pagesMoved, imageChanges, otherChanges },
 *   pages: [{ oldIndex, newIndex, status: 'same'|'changed'|'added'|'removed'|'moved',
 *             notes: string[], changes: Change[] }],
 *   geometry: { old: { view, rotate }[], new: { view, rotate }[] },
 * }
 * Change = { id, type: 'insert'|'delete'|'replace'|'format'|'image', oldText, newText,
 *            oldRects, newRects, oldPage, newPage, format?: { old, new }, detail? }
 *
 * Rectangles are in PDF user space ([x1, y1, x2, y2], y up), on the page each side names;
 * pageTransform() maps them to a rendered viewport.
 *
 * Text is diffed as one stream per document across all aligned pages, so text that reflows
 * onto the next page is not reported; moved pages are diffed against their counterpart alone.
 */

// PDF.js operator codes (pdfjs-dist 6.x; the test checks them against the installed build).
export const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  beginAnnotation: 80,
  endAnnotation: 81,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
  constructPath: 91,
};

// Helvetica advance widths (1/1000 em) for ASCII 32-126. Words are cut out of a text run by
// interpolating along its measured width; weighting each character by a typical proportional
// width keeps the boxes of narrow and wide words where they are drawn.
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
function charWidth(code) {
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32];
  // CJK, kana and full-width forms are square.
  if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)) return 1000;
  if (code >= 0xff00 && code <= 0xff60) return 1000;
  return 556;
}

const INVISIBLE = /[­​-‍⁠﻿]/g;
/** The form a word is matched by: compatibility-normalized (ligatures split) without soft hyphens. */
export const normalizeWord = (text) => text.normalize('NFKC').replace(INVISIBLE, '');
/** A subset font's name without its six-letter tag ("ABCDEF+Calibri" -> "Calibri"). */
const baseFont = (name) => String(name || '').replace(/^[A-Z]{6}\+/, '');

const round = (v) => Math.round(v * 100) / 100;
const union = (a, b) => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
function boxOf(m, x0, y0, x1, y1) {
  const xs = [],
    ys = [];
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
/** A small order-independent hash: equal multisets of values give equal sums. */
function mixHash(value) {
  let h = Math.imul(value | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * The PDF.js viewport matrix for a page drawn at `scale` (the same as page.getViewport), and the
 * displayed size. Kept here so overlays can be placed before the page itself is loaded.
 */
export function pageTransform({ view, rotate = 0 }, scale = 1) {
  const rotation = (((rotate % 360) + 360) % 360) / 90;
  const [a, b, c, d] = [
    [1, 0, 0, -1],
    [0, 1, 1, 0],
    [-1, 0, 0, 1],
    [0, -1, -1, 0],
  ][rotation];
  const cx = (view[2] + view[0]) / 2,
    cy = (view[3] + view[1]) / 2;
  const sideways = a === 0;
  const width = (sideways ? view[3] - view[1] : view[2] - view[0]) * scale;
  const height = (sideways ? view[2] - view[0] : view[3] - view[1]) * scale;
  const ox = Math.abs((sideways ? cy - view[1] : cx - view[0]) * scale);
  const oy = Math.abs((sideways ? cx - view[0] : cy - view[1]) * scale);
  const transform = [
    a * scale,
    b * scale,
    c * scale,
    d * scale,
    ox - a * scale * cx - c * scale * cy,
    oy - b * scale * cx - d * scale * cy,
  ];
  return { transform, width, height };
}
/** A user-space rectangle on the viewport: { left, top, width, height } in viewport units. */
export function viewportRect(rect, transform) {
  const [x1, y1, x2, y2] = boxOf(transform, rect[0], rect[1], rect[2], rect[3]);
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
}

/** Wait for a font PDF.js has announced but may still be attaching. */
function fontObject(page, id) {
  return new Promise((resolve) => {
    try {
      if (page.commonObjs.has(id)) return resolve(page.commonObjs.get(id));
      const timer = setTimeout(() => resolve(null), 1500);
      page.commonObjs.get(id, (font) => {
        clearTimeout(timer);
        resolve(font);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Split PDF.js text items into positioned words, joining a word that runs across items. */
function wordsOf(content, fonts) {
  const words = [];
  let line = -1;
  let last = null; // the previous text item: baseline geometry and whether a word is open
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    if (!item.str) {
      if (item.hasEOL && last) last.open = false;
      continue;
    }
    const [a, b, c, d, e, f] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b);
    if (!size) continue;
    const ul = Math.hypot(a, b) || 1;
    const ux = a / ul,
      uy = b / ul,
      vx = -uy,
      vy = ux;
    const style = content.styles?.[item.fontName] || {};
    const ascent = style.ascent > 0 ? Math.min(style.ascent, 1.2) : 0.8;
    const descent = style.descent < 0 ? Math.max(style.descent, -0.5) : -0.2;
    const along = e * ux + f * uy,
      perp = e * vx + f * vy;
    const str = item.str;
    const cum = new Float64Array(str.length + 1);
    for (let i = 0; i < str.length; i++) cum[i + 1] = cum[i] + charWidth(str.charCodeAt(i));
    const unit = item.width > 0 ? item.width / (cum[str.length] || 1) : size / 1000;
    const sameLine =
      last &&
      Math.abs(last.ux - ux) < 0.01 &&
      Math.abs(last.uy - uy) < 0.01 &&
      Math.abs(perp - last.perp) < 0.5 * Math.max(size, last.size) &&
      along > last.start - size;
    if (!sameLine) line++;
    const font = fonts.get(item.fontName) || style.fontFamily || '';
    const top = perp + ascent * size,
      bottom = perp + descent * size;
    const corner = (s, t) => [s * ux + t * vx, s * uy + t * vy];
    for (const match of str.matchAll(/\S+/g)) {
      const s0 = along + cum[match.index] * unit,
        s1 = along + cum[match.index + match[0].length] * unit;
      const points = [corner(s0, bottom), corner(s1, bottom), corner(s0, top), corner(s1, top)];
      const rect = [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1])),
      ];
      // A word split over two items (a kerning break, a bold letter) continues when the item
      // starts right where the last one ended, without a space between them.
      const joins =
        match.index === 0 &&
        sameLine &&
        last.open &&
        words.length &&
        Math.abs(s0 - last.end) < 0.2 * Math.max(size, last.size);
      if (joins) {
        const word = words.at(-1);
        word.text += match[0];
        word.key = normalizeWord(word.text);
        word.rect = union(word.rect, rect);
      } else {
        const key = normalizeWord(match[0]);
        if (key)
          words.push({
            text: match[0],
            key,
            rect,
            line,
            font,
            size: round(size),
          });
      }
    }
    last = {
      ux,
      uy,
      perp,
      size,
      start: along,
      end: along + (item.width > 0 ? item.width : cum[str.length] * unit),
      open: /\S$/.test(str) && !item.hasEOL,
    };
  }
  for (const word of words) word.rect = word.rect.map(round);
  return words;
}

/** Pictures with their placement, and a cheap fingerprint of the vector drawing. */
function graphicsOf(ops) {
  const images = [];
  let paths = 0,
    pathHash = 0,
    ctm = [1, 0, 0, 1, 0, 0],
    annotation = 0;
  const stack = [];
  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i],
      args = argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
      case OPS.endGroup:
        ctm = stack.pop() || ctm;
        break;
      case OPS.transform:
        ctm = mul(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mul(ctm, args[0]);
        break;
      case OPS.beginGroup:
        stack.push(ctm);
        if (args?.[0]?.matrix) ctm = mul(ctm, args[0].matrix);
        break;
      case OPS.beginAnnotation:
        annotation++;
        break;
      case OPS.endAnnotation:
        annotation = Math.max(0, annotation - 1);
        break;
      case OPS.paintImageXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject: {
        if (annotation) break;
        const data = args?.[0];
        const w = typeof args?.[1] === 'number' ? args[1] : data?.width || 0;
        const h = typeof args?.[2] === 'number' ? args[2] : data?.height || 0;
        images.push({ rect: boxOf(ctm, 0, 0, 1, 1).map(round), w, h });
        break;
      }
      case OPS.constructPath: {
        if (annotation) break;
        paths++;
        const box = args?.[2];
        if (box?.length === 4) {
          const [x1, y1, x2, y2] = boxOf(ctm, box[0], box[1], box[2], box[3]);
          pathHash =
            (pathHash +
              mixHash(
                (Math.round(x1) * 73856093) ^
                  (Math.round(y1) * 19349663) ^
                  (Math.round(x2) * 83492791) ^
                  (Math.round(y2) * 2654435761),
              )) >>>
            0;
        }
        break;
      }
    }
  }
  return { images, paths, pathHash };
}

/**
 * Read what the comparison needs from every page of a PDF.js document. `renderPage(page, index)`
 * may return a hash of a small rendering, which tells apart pages without text or with pictures.
 */
export async function extractComparable(pdf, { signal, onProgress, renderPage } = {}) {
  const pages = new Array(pdf.numPages);
  let done = 0,
    next = 0;
  async function readPage(index) {
    const page = await pdf.getPage(index + 1);
    const [content, ops] = await Promise.all([
      page.getTextContent(),
      page.getOperatorList().catch(() => ({ fnArray: [], argsArray: [] })),
    ]);
    signal?.throwIfAborted();
    // The operator list has made PDF.js load the page's fonts, which carry their real names.
    const fonts = new Map();
    for (const id of Object.keys(content.styles || {})) {
      const font = await fontObject(page, id);
      if (font?.name) fonts.set(id, baseFont(font.name));
    }
    const view = [...page.view];
    const { width, height } = pageTransform({ view, rotate: page.rotate });
    const words = wordsOf(content, fonts);
    const graphics = graphicsOf(ops);
    pages[index] = {
      index,
      view,
      rotate: page.rotate,
      width,
      height,
      words,
      ...graphics,
      // Drawing every page would slow a long comparison down; only pages whose words cannot
      // tell them apart are drawn: those without text, and those with pictures.
      renderHash:
        renderPage && (!words.length || graphics.images.length)
          ? await renderPage(page, index)
          : null,
    };
    page.cleanup?.();
    onProgress?.({ done: ++done, total: pdf.numPages });
  }
  // A few pages in flight keep the worker busy while the main thread splits words.
  await Promise.all(
    Array.from({ length: Math.min(4, pdf.numPages) }, async () => {
      while (next < pdf.numPages) {
        signal?.throwIfAborted();
        await readPage(next++);
      }
    }),
  );
  return { pages };
}

// ---------------------------------------------------------------------------------------------
// Sequence diff

/**
 * Match two sequences of integers: returns `match` where match[i] is the index in `b` paired
 * with a[i], or -1. Common ends are trimmed, long ranges are cut at words that occur once on
 * both sides (patience anchors), and the rest goes to Myers' linear-space bisection. Past the
 * deadline, an unresolved range is left unmatched, which reads as one replacement.
 */
export function diffSequences(a, b, { deadline = Infinity } = {}) {
  const match = new Int32Array(a.length).fill(-1);
  const stack = [[0, a.length, 0, b.length]];
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop();
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) match[a0++] = b0++;
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) match[--a1] = --b1;
    if (a0 === a1 || b0 === b1) continue;
    if ((a1 - a0) * (b1 - b0) > 250000) {
      // Words that occur once on each side, else word triples (repetitive text has few
      // unique words), cut the range into independent pieces.
      let anchors = uniqueAnchors(a, b, a0, a1, b0, b1, 1);
      if (anchors.length < 8) anchors = uniqueAnchors(a, b, a0, a1, b0, b1, 3);
      if (anchors.length) {
        let pa = a0,
          pb = b0;
        for (const [i, j, size] of anchors) {
          if (i < pa || j < pb) continue; // overlaps the previous triple
          for (let t = 0; t < size; t++) match[i + t] = j + t;
          stack.push([pa, i, pb, j]);
          pa = i + size;
          pb = j + size;
        }
        stack.push([pa, a1, pb, b1]);
        continue;
      }
    }
    if (Date.now() > deadline) continue;
    const split = bisect(a, b, a0, a1, b0, b1, deadline);
    if (!split || (split[0] === a0 && split[1] === b0) || (split[0] === a1 && split[1] === b1))
      continue;
    stack.push([a0, split[0], b0, split[1]], [split[0], a1, split[1], b1]);
  }
  return match;
}

/**
 * Runs of `size` tokens that occur exactly once in each range, as [i, j, size], kept in an
 * order both sides agree on.
 */
function uniqueAnchors(a, b, a0, a1, b0, b1, size) {
  const key = (x, i) => {
    let h = x[i];
    for (let t = 1; t < size; t++) h = h * 1000003 + x[i + t];
    return h;
  };
  const seen = new Map(); // key -> [count in a, index in a, count in b, index in b]
  for (let i = a0; i + size <= a1; i++) {
    const k = key(a, i);
    const s = seen.get(k);
    if (s) s[0]++;
    else seen.set(k, [1, i, 0, -1]);
  }
  for (let j = b0; j + size <= b1; j++) {
    const s = seen.get(key(b, j));
    if (s) {
      s[2]++;
      s[3] = j;
    }
  }
  const pairs = [];
  for (const s of seen.values()) {
    if (s[0] !== 1 || s[2] !== 1) continue;
    // A hash of several tokens can collide; check the tokens themselves.
    let same = true;
    for (let t = 0; t < size && same; t++) same = a[s[1] + t] === b[s[3] + t];
    if (same) pairs.push([s[1], s[3], size]);
  }
  pairs.sort((p, q) => p[0] - q[0]);
  // Longest increasing run of b positions (patience sorting).
  const tails = [],
    prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out = [];
  for (let k = tails.at(-1) ?? -1; k !== -1; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

let diagonals = [new Int32Array(0), new Int32Array(0)];
/** Myers' middle snake (after diff-match-patch's diff_bisect) over a[a0..a1) and b[b0..b1). */
function bisect(a, b, a0, a1, b0, b1, deadline) {
  const n = a1 - a0,
    m = b1 - b0;
  const max = Math.ceil((n + m) / 2);
  const off = max + 1,
    len = 2 * max + 4;
  // The diagonals are shared buffers, cleared only as far out as the search has reached, so a
  // long range with few differences costs what those differences cost.
  if (diagonals[0].length < len) diagonals = [new Int32Array(len), new Int32Array(len)];
  const [v1, v2] = diagonals;
  const delta = n - m,
    front = (delta & 1) !== 0;
  let cleared = -1;
  const clear = (from, to) => {
    from = Math.max(0, from);
    to = Math.min(len, to);
    if (from < to) {
      v1.fill(-1, from, to);
      v2.fill(-1, from, to);
    }
  };
  const reach = (r) => {
    if (r <= cleared || cleared >= off + 3) return;
    if (cleared < 0) clear(off - r, off + r + 1);
    else {
      clear(off - r, off - cleared);
      clear(off + cleared + 1, off + r + 1);
    }
    cleared = r;
  };
  reach(Math.abs(delta) + 2);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  let k1start = 0,
    k1end = 0,
    k2start = 0,
    k2end = 0;
  for (let d = 0; d < max; d++) {
    if ((d & 31) === 31 && Date.now() > deadline) return null;
    reach(d + Math.abs(delta) + 2);
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const i1 = off + k1;
      let x1 = k1 === -d || (k1 !== d && v1[i1 - 1] < v1[i1 + 1]) ? v1[i1 + 1] : v1[i1 - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[a0 + x1] === b[b0 + y1]) {
        x1++;
        y1++;
      }
      v1[i1] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const i2 = off + delta - k1;
        if (i2 >= 0 && i2 < len && v2[i2] !== -1 && x1 >= n - v2[i2]) return [a0 + x1, b0 + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const i2 = off + k2;
      let x2 = k2 === -d || (k2 !== d && v2[i2 - 1] < v2[i2 + 1]) ? v2[i2 + 1] : v2[i2 - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[a1 - x2 - 1] === b[b1 - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[i2] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const i1 = off + delta - k2;
        if (i1 >= 0 && i1 < len && v1[i1] !== -1) {
          const x1 = v1[i1],
            y1 = x1 - (i1 - off);
          if (x1 >= n - x2) return [a0 + x1, b0 + y1];
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Page alignment

const MATCH_SIMILARITY = 0.15; // the least similarity for two pages to be the same page
const MOVE_SIMILARITY = 0.5; // ... and for an out-of-order page to count as moved
const REFLOW_CONTAINMENT = 0.5; // an extra page this much made of its neighbours' text is reflow

/** Word bigrams of a page (single words when it has too few), as a counted multiset. */
function shinglesOf(ids) {
  const set = new Map();
  const add = (key) => set.set(key, (set.get(key) || 0) + 1);
  if (ids.length < 3) for (const id of ids) add(-1 - id);
  else for (let i = 1; i < ids.length; i++) add(ids[i - 1] * 1048576 + ids[i]);
  let total = 0;
  for (const count of set.values()) total += count;
  return { set, total };
}
function overlap(p, q) {
  if (p.total > q.total) [p, q] = [q, p];
  let common = 0;
  for (const [key, count] of p.set) {
    const other = q.set.get(key);
    if (other) common += Math.min(count, other);
  }
  return common;
}
const graphicsKey = (page) =>
  `${page.renderHash ?? ''}|${page.paths}|${page.pathHash}|${page.images
    .map((im) => `${im.w}x${im.h}`)
    .sort()
    .join(',')}`;

function similarity(p, q) {
  if (!p.ids.length && !q.ids.length) {
    // Pages without text (scans, drawings) match on their pictures and drawing.
    if (p.renderHash != null && q.renderHash != null)
      return p.renderHash === q.renderHash ? 1 : 0.3;
    return graphicsKey(p) === graphicsKey(q) ? 0.9 : 0.3;
  }
  if (!p.ids.length || !q.ids.length) return 0;
  if (p.textHash === q.textHash) return 1;
  return (2 * overlap(p.shingles, q.shingles)) / (p.shingles.total + q.shingles.total);
}

/**
 * Pair old and new pages: an order-keeping alignment that maximizes total similarity, then
 * out-of-order pairs among the leftovers (moved pages). Returns entries in display order.
 */
function alignPages(oldPages, newPages) {
  const n = oldPages.length,
    m = newPages.length;
  // Long documents compare pages near the same relative position, plus exact copies anywhere.
  const banded = n * m > 160000;
  const exact = new Map();
  if (banded)
    for (const q of newPages) exact.set(q.textHash, [...(exact.get(q.textHash) || []), q.index]);
  const sim = new Float32Array(n * m);
  for (let i = 0; i < n; i++) {
    const centre = m > 1 && n > 1 ? Math.round((i * (m - 1)) / (n - 1)) : 0;
    const from = banded ? Math.max(0, centre - 60) : 0,
      to = banded ? Math.min(m, centre + 61) : m;
    for (let j = from; j < to; j++) sim[i * m + j] = similarity(oldPages[i], newPages[j]);
    if (banded && oldPages[i].ids.length)
      for (const j of exact.get(oldPages[i].textHash) || []) sim[i * m + j] = 1;
  }
  // Weighted LCS: score[i][j] = best total for the first i old and j new pages.
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const s = sim[(i - 1) * m + j - 1];
      let best = Math.max(score[(i - 1) * W + j], score[i * W + j - 1]);
      if (s >= MATCH_SIMILARITY) best = Math.max(best, score[(i - 1) * W + j - 1] + s);
      score[i * W + j] = best;
    }
  const steps = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    const s = i && j ? sim[(i - 1) * m + j - 1] : 0;
    if (
      i &&
      j &&
      s >= MATCH_SIMILARITY &&
      Math.abs(score[i * W + j] - (score[(i - 1) * W + j - 1] + s)) < 1e-4
    ) {
      steps.push({ o: --i, n: --j });
    } else if (j && (!i || score[i * W + j - 1] >= score[(i - 1) * W + j])) {
      steps.push({ o: null, n: --j });
    } else {
      steps.push({ o: --i, n: null });
    }
  }
  steps.reverse();
  // Within each gap, the removed pages are listed before the added ones.
  const ordered = [];
  for (let k = 0; k < steps.length;) {
    if (steps[k].o != null && steps[k].n != null) {
      ordered.push(steps[k++]);
      continue;
    }
    const gap = [];
    while (k < steps.length && (steps[k].o == null || steps[k].n == null)) gap.push(steps[k++]);
    ordered.push(...gap.filter((s) => s.o != null), ...gap.filter((s) => s.n != null));
  }
  // Moved pages: the most similar unpaired old and new pages, best first.
  const lonelyOld = ordered.filter((s) => s.n == null).map((s) => s.o);
  const lonelyNew = ordered.filter((s) => s.o == null).map((s) => s.n);
  const candidates = [];
  for (const i of lonelyOld)
    for (const j of lonelyNew) {
      const s = sim[i * m + j] || (banded ? similarity(oldPages[i], newPages[j]) : 0);
      if (s >= MOVE_SIMILARITY && (oldPages[i].ids.length || newPages[j].ids.length))
        candidates.push([s, i, j]);
    }
  candidates.sort((p, q) => q[0] - p[0]);
  const movedFrom = new Map(),
    takenOld = new Set();
  for (const [, i, j] of candidates) {
    if (takenOld.has(i) || movedFrom.has(j)) continue;
    takenOld.add(i);
    movedFrom.set(j, i);
  }
  const entries = [];
  for (const s of ordered) {
    if (s.n == null && takenOld.has(s.o)) continue;
    if (s.o == null && movedFrom.has(s.n))
      entries.push({ o: movedFrom.get(s.n), n: s.n, moved: true });
    else entries.push(s);
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Comparison

const formatOf = (word) => ({ font: word.font, size: word.size });
function formatDiffers(p, q) {
  if (p.font && q.font && p.font !== q.font) return true;
  return Math.abs(p.size - q.size) > Math.max(0.25, 0.03 * Math.max(p.size, q.size));
}
/** One rectangle per line of the given words, merged left to right. */
function rectsOf(words) {
  const rects = [];
  let line = null;
  for (const word of words) {
    if (line !== word.line || !rects.length) rects.push([...word.rect]);
    else rects[rects.length - 1] = union(rects.at(-1), word.rect);
    line = word.line;
  }
  return rects;
}
const textOf = (words) => words.map((w) => w.text).join(' ');

const isComparable = (doc) => Array.isArray(doc?.pages);

/**
 * Compare two documents, given as PDF.js documents or as extractComparable() results.
 * `onProgress({ phase: 'read' | 'compare', done, total })` reports the reading of both files.
 */
export async function compareDocuments(oldDoc, newDoc, { signal, onProgress, renderPage } = {}) {
  if (!isComparable(oldDoc) || !isComparable(newDoc)) {
    const total =
      (oldDoc.numPages || oldDoc.pages.length) + (newDoc.numPages || newDoc.pages.length);
    let base = 0;
    const read = async (doc) => {
      if (isComparable(doc)) {
        base += doc.pages.length;
        return doc;
      }
      const result = await extractComparable(doc, {
        signal,
        renderPage,
        onProgress: ({ done }) => onProgress?.({ phase: 'read', done: base + done, total }),
      });
      base += doc.numPages;
      return result;
    };
    oldDoc = await read(oldDoc);
    newDoc = await read(newDoc);
  }
  signal?.throwIfAborted();
  onProgress?.({ phase: 'compare', done: 0, total: 1 });
  const started = Date.now();

  // Words become integers, shared between both documents.
  const vocabulary = new Map();
  const prepare = (page) => {
    const ids = new Int32Array(page.words.length);
    let hash = 0;
    page.words.forEach((word, k) => {
      let id = vocabulary.get(word.key);
      if (id === undefined) vocabulary.set(word.key, (id = vocabulary.size));
      ids[k] = id;
      hash = (Math.imul(hash, 31) + id + 1) | 0;
    });
    return {
      ...page,
      ids,
      textHash: `${ids.length}:${hash}`,
      shingles: shinglesOf(ids),
    };
  };
  const oldPages = oldDoc.pages.map(prepare);
  const newPages = newDoc.pages.map(prepare);
  const aligned = alignPages(oldPages, newPages);

  const entries = aligned.map((s) => ({
    oldIndex: s.o,
    newIndex: s.n,
    status: s.moved ? 'moved' : s.o == null ? 'added' : s.n == null ? 'removed' : 'same',
    notes: [],
    changes: [],
  }));
  const entryOfOld = new Int32Array(oldPages.length).fill(-1);
  const entryOfNew = new Int32Array(newPages.length).fill(-1);
  entries.forEach((entry, k) => {
    if (entry.oldIndex != null) entryOfOld[entry.oldIndex] = k;
    if (entry.newIndex != null) entryOfNew[entry.newIndex] = k;
  });

  // An added page whose text mostly comes from the pages around it is text that reflowed;
  // it joins the text stream. Otherwise it is a new page in its own right and its text is not
  // listed word by word. The same goes for removed pages.
  const neighbours = (k, side) => {
    const near = [];
    for (const step of [-1, 1])
      for (let q = k + step; q >= 0 && q < entries.length; q += step) {
        const e = entries[q];
        if (e.status === 'moved') continue;
        const index = side === 'old' ? e.oldIndex : e.newIndex;
        if (index != null && e.oldIndex != null && e.newIndex != null) {
          near.push(index);
          break;
        }
        if (index != null) near.push(index);
      }
    return near;
  };
  const inStream = entries.map((entry, k) => {
    if (entry.status === 'moved') return false;
    if (entry.status !== 'added' && entry.status !== 'removed') return true;
    const page = entry.status === 'added' ? newPages[entry.newIndex] : oldPages[entry.oldIndex];
    const others = entry.status === 'added' ? oldPages : newPages;
    if (!page.ids.length) return false;
    let common = 0;
    const seen = new Map();
    for (const index of neighbours(k, entry.status === 'added' ? 'old' : 'new'))
      for (const [key, count] of others[index].shingles.set)
        seen.set(key, (seen.get(key) || 0) + count);
    for (const [key, count] of page.shingles.set) common += Math.min(count, seen.get(key) || 0);
    return common / page.shingles.total >= REFLOW_CONTAINMENT;
  });

  let nextId = 0;
  const add = (k, change) => entries[k].changes.push({ id: 0, ...change });

  /**
   * Diff two word streams. `oldRefs`/`newRefs` hold [page, word] per token; `entryOf*` maps a
   * page to its entry so a change that crosses pages is split between them.
   */
  function diffStreams(oldRefs, newRefs, deadline) {
    const a = Int32Array.from(oldRefs, ([p, w]) => oldPages[p].ids[w]);
    const b = Int32Array.from(newRefs, ([p, w]) => newPages[p].ids[w]);
    const match = diffSequences(a, b, { deadline });
    const oldWord = ([p, w]) => oldPages[p].words[w];
    const newWord = ([p, w]) => newPages[p].words[w];
    const emitRun = (i0, i1, j0, j1) => {
      // Split the run by entry: each entry gets the part of either side that is on its pages.
      const groups = new Map();
      const bucket = (k) => {
        if (!groups.has(k)) groups.set(k, { old: [], new: [] });
        return groups.get(k);
      };
      for (let i = i0; i < i1; i++) bucket(entryOfOld[oldRefs[i][0]]).old.push(oldWord(oldRefs[i]));
      for (let j = j0; j < j1; j++) bucket(entryOfNew[newRefs[j][0]]).new.push(newWord(newRefs[j]));
      for (const [k, g] of groups) {
        const type = g.old.length && g.new.length ? 'replace' : g.old.length ? 'delete' : 'insert';
        add(k, {
          type,
          oldText: textOf(g.old),
          newText: textOf(g.new),
          oldRects: rectsOf(g.old),
          newRects: rectsOf(g.new),
        });
      }
    };
    let pi = -1,
      pj = -1;
    let format = null; // the open run of restyled words: { k, old: [], new: [] }
    const closeFormat = () => {
      if (!format) return;
      add(format.k, {
        type: 'format',
        oldText: textOf(format.old),
        newText: textOf(format.new),
        oldRects: rectsOf(format.old),
        newRects: rectsOf(format.new),
        format: { old: formatOf(format.old[0]), new: formatOf(format.new[0]) },
      });
      format = null;
    };
    for (let i = 0; i <= a.length; i++) {
      const j = i < a.length ? match[i] : b.length;
      if (j < 0) continue;
      if (i > pi + 1 || j > pj + 1) {
        closeFormat();
        emitRun(pi + 1, i, pj + 1, j);
      }
      if (i < a.length) {
        const ow = oldWord(oldRefs[i]),
          nw = newWord(newRefs[j]);
        const k = entryOfOld[oldRefs[i][0]];
        if (formatDiffers(ow, nw) && k === entryOfNew[newRefs[j][0]]) {
          const f = formatOf(nw),
            o = formatOf(ow);
          const same =
            format &&
            format.k === k &&
            !formatDiffers(format.new.at(-1), nw) &&
            !formatDiffers(format.old.at(-1), ow) &&
            (f.font !== o.font) === (format.new[0].font !== format.old[0].font);
          if (!same) closeFormat();
          format ||= { k, old: [], new: [] };
          format.old.push(ow);
          format.new.push(nw);
        } else closeFormat();
      }
      pi = i;
      pj = j;
    }
    closeFormat();
  }

  // The main stream: every page that kept its place, in order on both sides.
  const oldRefs = [],
    newRefs = [];
  entries.forEach((entry, k) => {
    if (!inStream[k]) return;
    if (entry.oldIndex != null)
      oldPages[entry.oldIndex].words.forEach((_, w) => oldRefs.push([entry.oldIndex, w]));
    if (entry.newIndex != null)
      newPages[entry.newIndex].words.forEach((_, w) => newRefs.push([entry.newIndex, w]));
  });
  const budget = Math.max(2000, (oldRefs.length + newRefs.length) / 20);
  diffStreams(oldRefs, newRefs, started + budget);
  // Moved pages, each against its counterpart.
  entries.forEach((entry) => {
    if (entry.status !== 'moved') return;
    diffStreams(
      oldPages[entry.oldIndex].words.map((_, w) => [entry.oldIndex, w]),
      newPages[entry.newIndex].words.map((_, w) => [entry.newIndex, w]),
      Date.now() + 1000,
    );
  });

  // Pictures and page-level differences, for pages present on both sides.
  entries.forEach((entry, k) => {
    if (entry.oldIndex == null || entry.newIndex == null) return;
    const p = oldPages[entry.oldIndex],
      q = newPages[entry.newIndex];
    for (const change of compareImages(p.images, q.images)) add(k, change);
    const sized = (page) => `${Math.round(page.width)}x${Math.round(page.height)}`;
    if (sized(p) !== sized(q)) entry.notes.push('Page size changed');
    else if ((p.rotate - q.rotate) % 360) entry.notes.push('Page rotation changed');
    if (p.paths !== q.paths || p.pathHash !== q.pathHash)
      entry.notes.push('Vector graphics differ');
    if (p.renderHash != null && q.renderHash != null && p.renderHash !== q.renderHash)
      if (!entry.changes.length && !entry.notes.length) entry.notes.push('Page appearance differs');
  });

  const summary = {
    pages: { old: oldPages.length, new: newPages.length },
    total: 0,
    inserted: 0,
    deleted: 0,
    replaced: 0,
    formatting: 0,
    pagesAdded: 0,
    pagesRemoved: 0,
    pagesMoved: 0,
    imageChanges: 0,
    // Differences of a page as a whole: its size, rotation, drawing, or appearance.
    otherChanges: 0,
  };
  const counter = {
    insert: 'inserted',
    delete: 'deleted',
    replace: 'replaced',
    format: 'formatting',
    image: 'imageChanges',
  };
  for (const entry of entries) {
    // Changes within a page read top to bottom on the side that has them.
    for (const change of entry.changes) {
      change.oldPage = entry.oldIndex;
      change.newPage = entry.newIndex;
      change.id = nextId++;
      summary[counter[change.type]]++;
    }
    summary.otherChanges += entry.notes.length;
    if (entry.status === 'same' && (entry.changes.length || entry.notes.length))
      entry.status = 'changed';
    if (entry.status === 'added') summary.pagesAdded++;
    if (entry.status === 'removed') summary.pagesRemoved++;
    if (entry.status === 'moved') summary.pagesMoved++;
  }
  summary.total =
    summary.inserted +
    summary.deleted +
    summary.replaced +
    summary.formatting +
    summary.imageChanges +
    summary.pagesAdded +
    summary.pagesRemoved +
    summary.pagesMoved +
    summary.otherChanges;
  onProgress?.({ phase: 'compare', done: 1, total: 1 });
  return {
    summary,
    pages: entries,
    geometry: {
      old: oldPages.map(({ view, rotate }) => ({ view, rotate })),
      new: newPages.map(({ view, rotate }) => ({ view, rotate })),
    },
  };
}

/** Pictures added, removed or changed between two versions of a page, by size and place. */
function compareImages(oldImages, newImages) {
  const near = (p, q) => p.rect.every((v, i) => Math.abs(v - q.rect[i]) < 2);
  const leftOld = [...oldImages],
    leftNew = [];
  for (const image of newImages) {
    const k = leftOld.findIndex((o) => o.w === image.w && o.h === image.h && near(o, image));
    if (k >= 0) leftOld.splice(k, 1);
    else leftNew.push(image);
  }
  const overlaps = (p, q) =>
    p.rect[0] < q.rect[2] &&
    q.rect[0] < p.rect[2] &&
    p.rect[1] < q.rect[3] &&
    q.rect[1] < p.rect[3];
  const changes = [];
  const image = (detail, before, after) =>
    changes.push({
      type: 'image',
      detail,
      oldText: '',
      newText: '',
      oldRects: before ? [before.rect] : [],
      newRects: after ? [after.rect] : [],
    });
  for (const after of leftNew) {
    // The same picture elsewhere, else whatever picture used to be in its place.
    let k = leftOld.findIndex((o) => o.w === after.w && o.h === after.h);
    const sameSize = (o) =>
      Math.abs(o.rect[2] - o.rect[0] - (after.rect[2] - after.rect[0])) < 2 &&
      Math.abs(o.rect[3] - o.rect[1] - (after.rect[3] - after.rect[1])) < 2;
    if (k >= 0) {
      const before = leftOld.splice(k, 1)[0];
      image(sameSize(before) ? 'Image moved' : 'Image resized', before, after);
      continue;
    }
    k = leftOld.findIndex((o) => overlaps(o, after));
    if (k >= 0) image('Image changed', leftOld.splice(k, 1)[0], after);
    else image('Image added', null, after);
  }
  for (const before of leftOld) image('Image removed', before, null);
  return changes;
}

// ---------------------------------------------------------------------------------------------
// Wording shared by the view and the report

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "12 changes: 5 insertions, 4 deletions, 3 replacements" and so on, or "No differences". */
export function describeSummary(summary) {
  if (!summary.total) return 'No differences found';
  const parts = [
    summary.inserted && plural(summary.inserted, 'insertion'),
    summary.deleted && plural(summary.deleted, 'deletion'),
    summary.replaced && plural(summary.replaced, 'replacement'),
    summary.formatting && plural(summary.formatting, 'formatting change'),
    summary.imageChanges && plural(summary.imageChanges, 'image change'),
    summary.pagesAdded && plural(summary.pagesAdded, 'page inserted', 'pages inserted'),
    summary.pagesRemoved && plural(summary.pagesRemoved, 'page deleted', 'pages deleted'),
    summary.pagesMoved && plural(summary.pagesMoved, 'page moved', 'pages moved'),
    summary.otherChanges && plural(summary.otherChanges, 'other change'),
  ].filter(Boolean);
  return `${plural(summary.total, 'change')}: ${parts.join(', ')}`;
}
export const CHANGE_LABELS = {
  insert: 'Inserted',
  delete: 'Deleted',
  replace: 'Replaced',
  format: 'Formatting',
  image: 'Image',
};
const fontLabel = (f) => `${f.font ? `${f.font} ` : ''}${f.size} pt`;
/** A one-line account of a change, e.g. 'Replaced "three" with "four"'. */
export function describeChange(change, limit = 120) {
  const cut = (text) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
  };
  switch (change.type) {
    case 'insert':
      return `Inserted "${cut(change.newText)}"`;
    case 'delete':
      return `Deleted "${cut(change.oldText)}"`;
    case 'replace':
      return `Replaced "${cut(change.oldText)}" with "${cut(change.newText)}"`;
    case 'format':
      return `Formatting of "${cut(change.newText)}": ${fontLabel(change.format.old)} to ${fontLabel(change.format.new)}`;
    default:
      return change.detail || 'Image changed';
  }
}
/** "Page 3", or "Page 3 → 4" when the page moved between the versions. */
export function pageLabel(entry) {
  if (entry.newIndex == null) return `Page ${entry.oldIndex + 1} (old)`;
  if (entry.oldIndex == null || entry.oldIndex === entry.newIndex)
    return `Page ${entry.newIndex + 1}`;
  return `Page ${entry.oldIndex + 1} → ${entry.newIndex + 1}`;
}
export function describePageStatus(entry) {
  if (entry.status === 'added') return `Page ${entry.newIndex + 1} inserted`;
  if (entry.status === 'removed') return `Page ${entry.oldIndex + 1} deleted`;
  if (entry.status === 'moved')
    return `Page moved from ${entry.oldIndex + 1} to ${entry.newIndex + 1}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Report

const REPORT_COLORS = {
  insert: rgb(0.12, 0.6, 0.33),
  delete: rgb(0.84, 0.23, 0.23),
  replace: rgb(0.88, 0.63, 0),
  format: rgb(0.76, 0.49, 0.05),
  image: rgb(0.45, 0.36, 0.84),
  page: rgb(0.08, 0.45, 0.9),
};

/**
 * The comparison's date in the reader's own format, in digits the report's standard font can
 * print. A format still in another script (an Arabic comma, a Korean or Arabic AM/PM) would
 * print as question marks, so it falls back to a year-month-day date.
 */
function reportDate(date, known) {
  const local = date
    .toLocaleString(undefined, { numberingSystem: 'latn' })
    .replace(/[\u200e\u200f\u061c]/g, '')
    .replace(/\s+/g, ' ');
  if ([...local].every((ch) => known.has(ch.codePointAt(0)))) return local;
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * A printable summary of a comparison, like Acrobat's compare report: the two files, the
 * counts, and every change listed by page. Returns the PDF bytes.
 */
export async function buildCompareReport(
  result,
  { oldName = 'Old', newName = 'New', date = new Date() } = {},
) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle('Compare report');
  doc.setSubject(`${oldName} compared with ${newName}`);
  doc.setCreator('PDF editor');
  // The standard fonts speak WinAnsi only; anything else prints as a question mark.
  const known = new Set(regular.getCharacterSet());
  const safe = (text) =>
    [...String(text).replace(/\s+/g, ' ')]
      .map((ch) => (known.has(ch.codePointAt(0)) ? ch : ch === '→' ? '->' : '?'))
      .join('');
  const [W, H, M] = [612, 792, 54];
  let page, y;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const wrap = (text, font, size, width) => {
    const lines = [];
    let current = '';
    for (const word of safe(text).split(' ')) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !current) current = next;
      else {
        lines.push(current);
        current = word;
      }
      // A single word wider than the column is cut to fit.
      while (font.widthOfTextAtSize(current, size) > width && current.length > 1) {
        let cut = current.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(current.slice(0, cut), size) > width) cut--;
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    if (current) lines.push(current);
    return lines;
  };
  const write = (
    text,
    { font = regular, size = 10, color = rgb(0.1, 0.1, 0.1), indent = 0, gap = 4, marker } = {},
  ) => {
    const lines = wrap(text, font, size, W - 2 * M - indent);
    lines.forEach((line, k) => {
      if (y - size < M) newPage();
      y -= size;
      if (marker && k === 0)
        page.drawRectangle({
          x: M + indent - 12,
          y: y + 1,
          width: 7,
          height: 7,
          color: marker,
        });
      page.drawText(line, { x: M + indent, y, size, font, color });
      y -= 3;
    });
    y -= gap;
  };
  newPage();
  write('Compare report', { font: bold, size: 20, gap: 10 });
  write(`Old file: ${oldName} (${plural(result.summary.pages.old, 'page')})`);
  write(`New file: ${newName} (${plural(result.summary.pages.new, 'page')})`);
  write(`Compared: ${reportDate(date, known)}`, {
    color: rgb(0.4, 0.4, 0.4),
    gap: 12,
  });
  write(describeSummary(result.summary), { font: bold, size: 12, gap: 14 });
  for (const entry of result.pages) {
    const status = describePageStatus(entry);
    if (!status && !entry.changes.length && !entry.notes.length) continue;
    if (y - 40 < M) newPage();
    write(pageLabel(entry), { font: bold, size: 12, gap: 6 });
    if (status) write(status, { indent: 14, marker: REPORT_COLORS.page });
    for (const note of entry.notes) write(note, { indent: 14, color: rgb(0.4, 0.4, 0.4) });
    for (const change of entry.changes)
      write(describeChange(change, 400), {
        indent: 14,
        marker: REPORT_COLORS[change.type],
      });
    y -= 8;
  }
  return doc.save();
}
