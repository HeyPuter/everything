/**
 * Automatic field detection for flat (non-interactive) forms, as Acrobat's Prepare Form runs it
 * when a scanned or printed form is opened: blanks drawn with underscores, rules with a label
 * beside or under them, empty boxes, small squares and empty table cells become suggested
 * fields named after their labels. Nothing is changed; the caller offers the candidates and
 * creates the accepted ones with addFormField.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFStream,
  StandardFontEmbedder,
  StandardFonts,
} from 'pdf-lib';
import { inspectPaths, pathColorHex } from './path-edit.js';
import { decode, matrix, pageSource, parseContent } from './text-edit.js';
import { annotationsOf, pageRotation } from './structure.js';
import { visibleBox } from './document.js';

const name = PDFName.of;
const get = (dict, key) => dict?.lookup?.(name(key));
const identity = [1, 0, 0, 1, 0, 0];
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* ---------- Text ---------- */

/** PDF.js text items (user space of the unrotated page), turned by `turn`, as horizontal runs. */
function fromTextContent(textContent, turn = identity) {
  const items = [];
  for (const item of textContent?.items ?? []) {
    if (typeof item.str !== 'string' || !item.str || !Array.isArray(item.transform)) continue;
    const [a, b, c, d, x, y] = matrix(turn, item.transform);
    // Rotated and vertical text is not a form label; skip it rather than guess its extent.
    if (Math.abs(b) > 1e-3 * Math.abs(a) || a <= 0 || !Number.isFinite(item.width)) continue;
    const size = Math.hypot(c, d) || item.height || 10;
    items.push({ str: item.str, x, y, width: item.width, size });
  }
  return items;
}

const standardNames = new Set(Object.values(StandardFonts));
const metricsCache = new WeakMap();
/** Glyph advances (thousandths of an em) of a simple font, or a two-byte font's code width. */
function fontMetrics(font) {
  if (!(font instanceof PDFDict)) return { twoByte: false, width: () => 500 };
  if (metricsCache.has(font)) return metricsCache.get(font);
  const subtype = get(font, 'Subtype')?.decodeText?.();
  let metrics;
  if (subtype === 'Type0') metrics = { twoByte: true, width: () => 1000 };
  else {
    const first = get(font, 'FirstChar')?.asNumber?.() ?? 0;
    const widths = get(font, 'Widths');
    const values =
      widths instanceof PDFArray
        ? widths.asArray().map((w) => font.context.lookup(w)?.asNumber?.())
        : [];
    const missing = get(get(font, 'FontDescriptor'), 'MissingWidth')?.asNumber?.();
    const base = get(font, 'BaseFont')
      ?.decodeText?.()
      .replace(/^[A-Z]{6}\+/, '');
    let standard;
    try {
      standard = standardNames.has(base) ? StandardFontEmbedder.for(base) : undefined;
    } catch {
      standard = undefined;
    }
    metrics = {
      twoByte: false,
      width: (code) => {
        const own = values[code - first];
        if (Number.isFinite(own)) return own;
        if (standard)
          try {
            return standard.widthOfTextAtSize(String.fromCharCode(code), 1000);
          } catch {
            // A code outside the font's encoding advances like an average glyph.
          }
        return missing ?? 500;
      },
    };
  }
  metricsCache.set(font, metrics);
  return metrics;
}

/**
 * A small text reader for when no PDF.js text is supplied: positions and simple-font text
 * from the content stream, including form XObjects. Two-byte fonts give positions only.
 */
function extractText(doc, page, turn = identity) {
  const items = [];
  const walk = (source, resources, ctm, depth) => {
    if (depth > 8) return;
    let operations;
    try {
      operations = parseContent(source);
    } catch {
      return;
    }
    let gs = { ctm, font: null, size: 0, tc: 0, tw: 0, tz: 1, tl: 0, rise: 0 };
    const stack = [];
    let tm = identity,
      tlm = identity;
    const show = (parts) => {
      const metrics = fontMetrics(gs.font);
      const start = matrix(gs.ctm, tm);
      let text = '',
        advance = 0;
      for (const part of parts) {
        if (typeof part === 'number') {
          advance -= (part / 1000) * gs.size * gs.tz;
          continue;
        }
        const step = metrics.twoByte ? 2 : 1;
        for (let i = 0; i + step <= part.length; i += step) {
          const code = metrics.twoByte
            ? (part.charCodeAt(i) << 8) | part.charCodeAt(i + 1)
            : part.charCodeAt(i);
          if (!metrics.twoByte) text += String.fromCharCode(code);
          const space = !metrics.twoByte && code === 32 ? gs.tw : 0;
          advance += ((metrics.width(code) / 1000) * gs.size + gs.tc + space) * gs.tz;
        }
      }
      const [x, y] = apply(start, [0, gs.rise]);
      const scaleX = Math.hypot(start[0], start[1]),
        scaleY = Math.hypot(start[2], start[3]);
      if (text && Math.abs(start[1]) <= 1e-3 * Math.abs(start[0]) && start[0] > 0)
        items.push({
          str: text,
          x,
          y,
          width: advance * scaleX,
          size: gs.size * scaleY,
        });
      tm = matrix(tm, [1, 0, 0, 1, advance, 0]);
    };
    for (const { op, args } of operations) {
      const a = args.map((t) => t.value);
      if (op === 'q') stack.push({ ...gs });
      else if (op === 'Q') gs = stack.pop() ?? gs;
      else if (op === 'cm' && a.length === 6) gs.ctm = matrix(gs.ctm, a);
      else if (op === 'BT') tm = tlm = identity;
      else if (op === 'Tf') {
        gs.font = get(get(resources, 'Font'), a[0]) ?? null;
        gs.size = a[1] || 0;
      } else if (op === 'Tc') gs.tc = a[0] || 0;
      else if (op === 'Tw') gs.tw = a[0] || 0;
      else if (op === 'Tz') gs.tz = (a[0] ?? 100) / 100;
      else if (op === 'TL') gs.tl = a[0] || 0;
      else if (op === 'Ts') gs.rise = a[0] || 0;
      else if (op === 'Tm' && a.length === 6) tm = tlm = a;
      else if (op === 'Td' || op === 'TD') {
        if (op === 'TD') gs.tl = -a[1];
        tm = tlm = matrix(tlm, [1, 0, 0, 1, a[0], a[1]]);
      } else if (op === 'T*') tm = tlm = matrix(tlm, [1, 0, 0, 1, 0, -gs.tl]);
      else if (op === 'Tj') show([a[0]]);
      else if (op === 'TJ') show(Array.isArray(a[0]) ? a[0].map((t) => t.value) : []);
      else if (op === "'" || op === '"') {
        if (op === '"') {
          gs.tw = a[0];
          gs.tc = a[1];
        }
        tm = tlm = matrix(tlm, [1, 0, 0, 1, 0, -gs.tl]);
        show([a.at(-1)]);
      } else if (op === 'Do') {
        const form = get(get(resources, 'XObject'), a[0]);
        if (!(form instanceof PDFStream) || get(form.dict, 'Subtype')?.decodeText?.() !== 'Form')
          continue;
        const own = get(form.dict, 'Matrix');
        const m =
          own instanceof PDFArray ? own.asArray().map((n) => n.asNumber?.() ?? 0) : identity;
        try {
          walk(
            decode(form),
            get(form.dict, 'Resources') ?? resources,
            matrix(gs.ctm, m),
            depth + 1,
          );
        } catch {
          // An undecodable form contributes no text.
        }
      }
    }
  };
  walk(pageSource(page), page.node.Resources(), turn, 0);
  return items;
}

/**
 * Split items into underscore blanks (three or more) and label text, then join label pieces
 * that sit on one line close together into runs.
 */
function textLayout(items) {
  const blanks = [],
    pieces = [];
  for (const item of items) {
    const perChar = item.width / Math.max(1, item.str.length);
    const pattern = /_{3,}/g;
    let last = 0,
      match;
    const piece = (from, to) => {
      const str = item.str.slice(from, to);
      if (str.trim())
        pieces.push({
          str,
          x: item.x + from * perChar,
          y: item.y,
          width: (to - from) * perChar,
          size: item.size,
        });
    };
    while ((match = pattern.exec(item.str))) {
      piece(last, match.index);
      blanks.push({
        x: item.x + match.index * perChar,
        y: item.y,
        width: match[0].length * perChar,
        size: item.size,
      });
      last = match.index + match[0].length;
    }
    piece(last, item.str.length);
  }
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const runs = [];
  for (const piece of pieces) {
    const run = runs.find(
      (r) =>
        Math.abs(r.y - piece.y) < 0.35 * Math.max(r.size, piece.size) &&
        piece.x >= r.x &&
        piece.x - (r.x + r.width) < 0.9 * Math.max(r.size, piece.size) &&
        !blanks.some(
          (b) =>
            b.x >= r.x + r.width - 1 &&
            b.x + b.width <= piece.x + 1 &&
            Math.abs(b.y - piece.y) < r.size,
        ),
    );
    if (run) {
      const gap = piece.x - (run.x + run.width);
      run.str +=
        (gap > 0.15 * run.size && !/\s$/.test(run.str) && !/^\s/.test(piece.str) ? ' ' : '') +
        piece.str;
      run.width = Math.max(run.width, piece.x + piece.width - run.x);
      run.size = Math.max(run.size, piece.size);
    } else runs.push({ ...piece });
  }
  for (const run of runs) {
    run.str = run.str.replace(/\s+/g, ' ').trim();
    // Glyph boxes: descenders a quarter em below the baseline, capitals about 0.75 above.
    run.bottom = run.y - 0.25 * run.size;
    run.top = run.y + 0.8 * run.size;
    run.right = run.x + run.width;
  }
  return { blanks, runs: runs.filter((r) => r.str) };
}

/** A field name from a label: punctuation and dots (name separators) removed. */
function labelName(text) {
  const words = String(text ?? '')
    .replace(/[.:*_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'&/#()-]/gu, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  let result = '';
  for (const word of words) {
    if (!word) continue;
    if ((result + ' ' + word).trim().length > 40) break;
    result = (result + ' ' + word).trim();
  }
  return /[\p{L}\p{N}]/u.test(result) ? result : '';
}

/* ---------- Drawn geometry ---------- */

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** Visible rectangles, rules and the lines a table grid is drawn with, in page space. */
function pageGeometry(doc, pageIndex, turn = identity) {
  const boxes = [],
    horizontals = [],
    verticals = [];
  let paths;
  try {
    paths = inspectPaths(doc, pageIndex);
  } catch {
    paths = [];
  }
  for (const path of paths) {
    if (path.invisible) continue;
    const ctm = matrix(turn, path.ctm);
    const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
    let strokeColor = '#000000',
      fillColor = '#000000';
    try {
      if (path.stroked) strokeColor = pathColorHex(path.state.stroke);
      if (path.filled) fillColor = pathColorHex(path.state.fill);
    } catch {
      // Unreadable colors count as ink.
    }
    const stroked = path.stroked && luminance(strokeColor) < 0.95;
    const filled = path.filled && luminance(fillColor) < 0.97;
    if (!stroked && !filled) continue;
    const lineWidth = stroked ? Math.max(0.1, path.state.width * scale) : 0;
    let operations;
    try {
      operations = parseContent(path.source);
    } catch {
      continue;
    }
    const rects = [],
      segments = [];
    let start = null,
      current = null,
      points = [],
      curved = false;
    const close = () => {
      if (points.length === 5 && !curved) {
        // A closed four-sided axis-aligned polygon is drawn like a rectangle.
        const xs = points.map((p) => p[0]),
          ys = points.map((p) => p[1]);
        const axis = points
          .slice(1)
          .every(
            (p, i) => Math.abs(p[0] - points[i][0]) < 0.5 || Math.abs(p[1] - points[i][1]) < 0.5,
          );
        if (axis) rects.push(boundsOf(xs, ys));
      }
    };
    for (const { op, args } of operations) {
      const a = args.map((t) => t.value);
      if (op === 're' && a.length === 4) {
        const corners = [
          [a[0], a[1]],
          [a[0] + a[2], a[1]],
          [a[0] + a[2], a[1] + a[3]],
          [a[0], a[1] + a[3]],
        ].map((p) => apply(ctm, p));
        rects.push(
          boundsOf(
            corners.map((p) => p[0]),
            corners.map((p) => p[1]),
          ),
        );
        start = current = null;
      } else if (op === 'm') {
        start = current = apply(ctm, a);
        points = [current];
        curved = false;
      } else if (op === 'l' && current) {
        const next = apply(ctm, a);
        segments.push([current, next]);
        points.push(next);
        current = next;
      } else if (op === 'h' && current && start) {
        if (current[0] !== start[0] || current[1] !== start[1]) {
          segments.push([current, start]);
          points.push(start);
        }
        close();
        current = start;
      } else if (op === 'c' || op === 'v' || op === 'y') {
        curved = true;
        current = apply(ctm, a.slice(-2));
      }
    }
    // An open path that returns to its start (m l l l l) is also a closed rectangle.
    if (
      points.length === 5 &&
      Math.hypot(points[4][0] - points[0][0], points[4][1] - points[0][1]) < 0.5
    )
      close();
    for (const rect of rects) {
      if (rect.height <= 2.5 && rect.width >= 3)
        horizontals.push({
          x0: rect.x,
          x1: rect.x + rect.width,
          y: rect.y + rect.height / 2,
          width: rect.height,
        });
      else if (rect.width <= 2.5 && rect.height >= 3)
        verticals.push({
          y0: rect.y,
          y1: rect.y + rect.height,
          x: rect.x + rect.width / 2,
          width: rect.width,
        });
      else {
        boxes.push({
          ...rect,
          stroked,
          filled,
          fill: filled ? luminance(fillColor) : 1,
        });
        // Box sides are table lines too, but never standalone rules.
        if (stroked) {
          horizontals.push({
            x0: rect.x,
            x1: rect.x + rect.width,
            y: rect.y,
            width: lineWidth,
            edge: true,
          });
          horizontals.push({
            x0: rect.x,
            x1: rect.x + rect.width,
            y: rect.y + rect.height,
            width: lineWidth,
            edge: true,
          });
          verticals.push({
            y0: rect.y,
            y1: rect.y + rect.height,
            x: rect.x,
            width: lineWidth,
            edge: true,
          });
          verticals.push({
            y0: rect.y,
            y1: rect.y + rect.height,
            x: rect.x + rect.width,
            width: lineWidth,
            edge: true,
          });
        }
      }
    }
    if (!stroked) continue;
    for (const [p, q] of segments) {
      if (Math.abs(p[1] - q[1]) <= 0.5 && Math.abs(p[0] - q[0]) >= 3)
        horizontals.push({
          x0: Math.min(p[0], q[0]),
          x1: Math.max(p[0], q[0]),
          y: (p[1] + q[1]) / 2,
          width: lineWidth,
        });
      else if (Math.abs(p[0] - q[0]) <= 0.5 && Math.abs(p[1] - q[1]) >= 3)
        verticals.push({
          y0: Math.min(p[1], q[1]),
          y1: Math.max(p[1], q[1]),
          x: (p[0] + q[0]) / 2,
          width: lineWidth,
        });
    }
  }
  return { boxes, horizontals, verticals };
}
function boundsOf(xs, ys) {
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Cells of ruled tables: rows between neighboring horizontal lines, split by verticals. */
function tableCells(horizontals, verticals) {
  const cells = [];
  const lines = horizontals.filter((h) => h.x1 - h.x0 >= 15).slice(0, 600);
  for (const top of lines) {
    let bottom = null;
    for (const other of lines) {
      const gap = top.y - other.y;
      if (gap < 8 || gap > 120) continue;
      if (Math.min(top.x1, other.x1) - Math.max(top.x0, other.x0) < 15) continue;
      if (!bottom || other.y > bottom.y) bottom = other;
    }
    if (!bottom) continue;
    const x0 = Math.max(top.x0, bottom.x0),
      x1 = Math.min(top.x1, bottom.x1);
    const xs = verticals
      .filter(
        (v) => v.x >= x0 - 1.5 && v.x <= x1 + 1.5 && v.y0 <= bottom.y + 1.5 && v.y1 >= top.y - 1.5,
      )
      .map((v) => v.x)
      .sort((a, b) => a - b)
      .filter((x, i, all) => !i || x - all[i - 1] > 1);
    for (let i = 0; i + 1 < xs.length; i++)
      if (xs[i + 1] - xs[i] >= 15)
        cells.push({
          x: xs[i],
          y: bottom.y,
          width: xs[i + 1] - xs[i],
          height: top.y - bottom.y,
          cell: true,
        });
  }
  return cells;
}

/* ---------- Candidates ---------- */

/** Rows from the top (fields whose middles line up), each row left to right. */
function readingOrder(candidates) {
  const middle = ({ rect }) => rect.y + rect.height / 2;
  const rows = [];
  for (const candidate of candidates.slice().sort((a, b) => middle(b) - middle(a))) {
    const row = rows.at(-1);
    if (
      row &&
      Math.abs(middle(row[0]) - middle(candidate)) <
        Math.min(row[0].rect.height, candidate.rect.height) * 0.6
    )
      row.push(candidate);
    else rows.push([candidate]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.rect.x - b.rect.x));
}

/** A rectangle's bounds after `m`. */
function turned(m, { x, y, width, height }) {
  const corners = [
    [x, y],
    [x + width, y + height],
  ].map((p) => apply(m, p));
  return boundsOf(
    corners.map((p) => p[0]),
    corners.map((p) => p[1]),
  );
}
const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const inside = (rect, x, y, inset = 0) =>
  x > rect.x + inset &&
  x < rect.x + rect.width - inset &&
  y > rect.y + inset &&
  y < rect.y + rect.height - inset;
const runInside = (rect, run) =>
  inside(rect, run.x + Math.min(run.width, run.size) / 2, run.y + 0.3 * run.size, 0.5);

function widgetRects(doc, page, turn = identity) {
  const rects = [];
  for (const ref of annotationsOf(page)?.asArray() || []) {
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict) || get(dict, 'Subtype')?.decodeText?.() !== 'Widget') continue;
    const values = get(dict, 'Rect')
      ?.asArray?.()
      .map((v) => doc.context.lookup(v)?.asNumber?.());
    if (values?.length !== 4 || !values.every(Number.isFinite)) continue;
    rects.push(turned(turn, boundsOf([values[0], values[2]], [values[1], values[3]])));
  }
  return rects;
}

/**
 * Candidate fields on page `pageIndex` of a flat form. `textContent` is PDF.js's
 * `page.getTextContent()` result; without it a built-in reader takes text from the content
 * stream (simple fonts only). Returns `[{ type: 'text' | 'checkbox', rect, name, confidence,
 * multiline?, label, source }]` in reading order (top to bottom, then left to right), never
 * overlapping existing widgets or each other. `confidence` runs from 0.4 (an unlabeled line)
 * to 0.9 (a labeled underscore blank). The document is not modified.
 */
export function detectFormFields(doc, pageIndex, { textContent } = {}) {
  const page = doc.getPage(pageIndex);
  // A turned page is read as it is shown: its text runs across the screen, not across the
  // page's own coordinates. Fields are found there and turned back.
  const angle = (pageRotation(page) * Math.PI) / 180;
  const [cos, sin] = [Math.round(Math.cos(angle)), Math.round(Math.sin(angle))];
  const turn = [cos, -sin, sin, cos, 0, 0],
    back = [cos, sin, -sin, cos, 0, 0];
  const { width: pageWidth } = turned(
    turn,
    page.getMediaBox?.() ?? { x: 0, y: 0, width: 612, height: 792 },
  );
  const shown = turned(turn, visibleBox(page));
  let items;
  try {
    items = textContent ? fromTextContent(textContent, turn) : extractText(doc, page, turn);
  } catch {
    items = [];
  }
  const { blanks, runs } = textLayout(items);
  const { boxes, horizontals, verticals } = pageGeometry(doc, pageIndex, turn);
  const candidates = [];
  const add = (type, rect, label, confidence, source, extra = {}) => {
    if (!(rect.width >= 4 && rect.height >= 4)) return;
    const round = (n) => Math.round(n * 100) / 100;
    candidates.push({
      type,
      rect: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
      label: labelName(label),
      confidence,
      source,
      ...extra,
    });
  };
  // Room above a field's bottom edge before it would cover the text above it.
  const headroom = (x0, x1, bottom, wanted) => {
    let room = wanted;
    for (const run of runs)
      if (run.bottom >= bottom - 0.5 && run.x < x1 && run.right > x0)
        room = Math.min(room, run.bottom - bottom - 1);
    return room;
  };
  const leftLabel = (x, y0, y1, reach) => {
    let best = null;
    for (const run of runs) {
      const mid = run.y + 0.3 * run.size;
      if (mid < y0 || mid > y1 || run.right > x + 2 || x - run.right > reach) continue;
      if (!best || run.right > best.right) best = run;
    }
    return best;
  };
  const labelBelow = (x0, x1, y) =>
    runs.find(
      (run) => run.top <= y + 1 && y - run.top <= 14 && run.x >= x0 - 6 && run.x < x1 - 4,
    ) ?? null;
  const labelAbove = (x0, x1, y) =>
    runs.find(
      (run) =>
        run.bottom >= y - 1 &&
        run.bottom - y <= 16 &&
        run.x >= x0 - 6 &&
        run.x < x0 + (x1 - x0) / 2,
    ) ?? null;

  // Underscore blanks: "Name: ________".
  for (const blank of blanks) {
    if (blank.width < 15) continue;
    const bottom = blank.y - 0.12 * blank.size;
    const left = leftLabel(blank.x, blank.y - 0.3 * blank.size, blank.y + 0.8 * blank.size, 120);
    const below = left
      ? null
      : labelBelow(blank.x, blank.x + blank.width, bottom - 0.2 * blank.size);
    const label =
      left ?? below ?? labelAbove(blank.x, blank.x + blank.width, blank.y + 0.8 * blank.size);
    const height = headroom(blank.x, blank.x + blank.width, bottom, Math.max(12, blank.size * 1.4));
    if (height < 8) continue;
    add(
      'text',
      { x: blank.x, y: bottom, width: blank.width, height },
      label?.str,
      left ? 0.9 : label ? 0.75 : 0.6,
      'underscore',
    );
  }

  // Standalone rules: a horizontal line not part of a box or table grid.
  const grid = (h) =>
    verticals.some((v) => v.x >= h.x0 - 2 && v.x <= h.x1 + 2 && v.y0 <= h.y + 2 && v.y1 >= h.y - 2);
  for (const rule of horizontals) {
    const length = rule.x1 - rule.x0;
    if (rule.edge || length < 36 || grid(rule)) continue;
    // Text standing on the line is underlined text, not a blank.
    if (
      runs.some(
        (run) =>
          run.bottom <= rule.y + 4 &&
          run.y >= rule.y - 1 &&
          Math.min(run.right, rule.x1) - Math.max(run.x, rule.x0) > 0.4 * length,
      )
    )
      continue;
    const top = rule.y + rule.width / 2 + 0.5;
    const left = leftLabel(rule.x0, rule.y - 2, rule.y + 14, 80);
    const below = left ? null : labelBelow(rule.x0, rule.x1, rule.y - rule.width / 2);
    const above = left || below ? null : labelAbove(rule.x0, rule.x1, top + 14);
    // A long line with no label beside or under it separates sections; near the top or
    // bottom of the page it sets off the header or footer, whatever is printed by it.
    if (length > 0.6 * pageWidth) {
      if (!left && !below) continue;
      const height = (rule.y - shown.y) / shown.height;
      if (height < 0.1 || height > 0.9) continue;
    }
    const height = headroom(rule.x0, rule.x1, top, Math.max(14, (left?.size ?? 10) * 1.6));
    if (height < 8) continue;
    const label = left ?? below ?? above;
    add(
      'text',
      { x: rule.x0, y: top, width: length, height },
      label?.str,
      left ? 0.85 : below ? 0.75 : label ? 0.5 : 0.4,
      'line',
    );
  }

  // Boxes and table cells: small squares are check boxes, input-sized boxes text fields.
  const shapes = [...boxes, ...tableCells(horizontals, verticals)];
  const seen = [];
  for (const box of shapes) {
    if (
      seen.some((other) =>
        ['x', 'y', 'width', 'height'].every((k) => Math.abs(other[k] - box[k]) < 1),
      )
    )
      continue;
    seen.push(box);
    const contents = runs.filter((run) => runInside(box, run));
    const square =
      box.width >= 6 &&
      box.width <= 20 &&
      box.height >= 6 &&
      box.height <= 20 &&
      Math.abs(box.width - box.height) <= Math.max(1.5, 0.15 * box.width);
    if (square) {
      // Dark filled squares are bullets, not boxes to tick.
      if (contents.length || (box.filled && !box.stroked && box.fill < 0.6)) continue;
      const mid = box.y + box.height / 2;
      const right = runs
        .filter(
          (run) =>
            Math.abs(run.y + 0.3 * run.size - mid) < Math.max(box.height, run.size) * 0.7 &&
            run.x >= box.x + box.width - 1 &&
            run.x - (box.x + box.width) <= 30,
        )
        .sort((a, b) => a.x - b.x)[0];
      const left = right ? null : leftLabel(box.x, box.y - 2, box.y + box.height + 2, 30);
      const label = right ?? left;
      add('checkbox', box, label?.str, label ? 0.85 : 0.6, box.cell ? 'cell' : 'box');
      continue;
    }
    if (box.width < 30 || box.height < 10 || box.height > 220 || box.width > 0.95 * pageWidth)
      continue;
    // Dark filled boxes are banners and bars; nothing written in them could be read.
    if (box.filled && box.fill < 0.6) continue;
    // A frame around other boxes, lines or blanks groups them; it is not a field itself.
    const frames = (other) =>
      other !== box &&
      other.x >= box.x - 0.5 &&
      other.y >= box.y - 0.5 &&
      other.x + other.width <= box.x + box.width + 0.5 &&
      other.y + other.height <= box.y + box.height + 0.5 &&
      area(other) < area(box) - 1;
    if (shapes.some(frames)) continue;
    if (
      horizontals.some(
        (h) =>
          !h.edge &&
          h.x0 > box.x + 2 &&
          h.x1 < box.x + box.width - 2 &&
          h.y > box.y + 2 &&
          h.y < box.y + box.height - 2,
      )
    )
      continue;
    let rect = {
      x: box.x + 1,
      y: box.y + 1,
      width: box.width - 2,
      height: box.height - 2,
    };
    let label = null,
      confidence;
    if (contents.length) {
      // A caption printed in the box's top-left corner names it; the rest is the input.
      const lowest = Math.min(...contents.map((run) => run.bottom));
      const captionLike = contents.every(
        (run) => run.y > box.y + box.height * 0.45 && run.x < box.x + box.width * 0.6,
      );
      if (!captionLike || lowest - box.y < 10) continue;
      rect = { ...rect, height: lowest - box.y - 2 };
      label = contents.sort((a, b) => b.y - a.y || a.x - b.x)[0];
      confidence = 0.8;
    } else {
      label = leftLabel(box.x, box.y - 2, box.y + box.height + 2, box.cell ? 200 : 120);
      confidence = label ? 0.8 : 0;
      if (!label) {
        label = labelAbove(box.x, box.x + box.width, box.y + box.height);
        confidence = label ? 0.7 : 0.5;
      }
      if (!label && box.cell) {
        // A column heading names the cells under it.
        const heading = shapes.find(
          (other) =>
            other.cell &&
            Math.abs(other.x - box.x) < 1 &&
            Math.abs(other.width - box.width) < 1 &&
            Math.abs(other.y - (box.y + box.height)) < 1.5,
        );
        label = heading && runs.find((run) => runInside(heading, run));
        confidence = label ? 0.55 : 0.4;
      }
    }
    add(
      'text',
      rect,
      label?.str,
      confidence,
      box.cell ? 'cell' : 'box',
      rect.height > 40 ? { multiline: true } : {},
    );
  }

  // Keep the most likely of overlapping candidates, away from existing fields.
  const taken = widgetRects(doc, page, turn);
  const accepted = [];
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    const { rect } = candidate;
    // Marks outside the page as it is shown (printer's marks past the crop box) are no fields.
    if (overlap(shown, rect) < 0.5 * area(rect)) continue;
    if (taken.some((widget) => overlap(widget, rect) > 0)) continue;
    if (
      accepted.some(
        (other) => overlap(other.rect, rect) > 0.3 * Math.min(area(other.rect), area(rect)),
      )
    )
      continue;
    accepted.push(candidate);
  }
  // Acrobat-style names: the label, or Text1 / Check Box1; repeated labels get _2, _3...
  const used = new Map(),
    counters = { text: 0, checkbox: 0 };
  return readingOrder(accepted).map(({ label, ...candidate }) => {
    let base =
      label ||
      `${candidate.type === 'checkbox' ? 'Check Box' : 'Text'}${++counters[candidate.type]}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    const rect = turned(back, candidate.rect);
    return {
      ...candidate,
      rect: Object.fromEntries(
        Object.entries(rect).map(([key, n]) => [key, Math.round(n * 100) / 100]),
      ),
      name: count > 1 ? `${base}_${count}` : base,
      label: label || null,
    };
  });
}
