/**
 * Print layout: where artwork goes on printed pages. Pure geometry, so the
 * Print dialog's preview and the printed pages always agree.
 *
 * Settings (all lengths in points):
 *   media        'artboard' | a MEDIA key | 'custom'
 *   mediaW/H     custom media size
 *   orientation  'auto' | 'portrait' | 'landscape'
 *   scaling      'none' | 'fit' | 'custom' | 'tile'
 *   scale        percent for custom and tile
 *   anchor       placement anchor: 'tl' 't' 'tr' 'l' 'c' 'r' 'bl' 'b' 'br'
 *   offsetX/Y    placement offset from the anchor
 *   overlap      tile overlap
 *   bleed        { top, right, bottom, left } printed outside the trim
 *   marks        { trim, registration, colorBars, pageInfo }
 *   markWeight   trim mark line weight
 *   markOffset   gap between the trim and the marks
 *   markType     'roman' (one line per edge) | 'japanese' (double corner marks
 *                at the trim and the bleed, and center marks)
 *
 * A page is { w, h, tiles: [{ rect (document rect to draw), clip (document
 * rect to clip to), x, y, s (page = (doc - rect.x) * s + x) }], marks:
 * [{ kind, ... }] in page coordinates }.
 */

export const MEDIA = {
  letter: { label: 'Letter', w: 612, h: 792 },
  legal: { label: 'Legal', w: 612, h: 1008 },
  tabloid: { label: 'Tabloid', w: 792, h: 1224 },
  a3: { label: 'A3', w: 841.89, h: 1190.55 },
  a4: { label: 'A4', w: 595.28, h: 841.89 },
  a5: { label: 'A5', w: 419.53, h: 595.28 },
  b5: { label: 'B5', w: 498.9, h: 708.66 },
};

export const MARK_LENGTH = 18;
const FIT_MARGIN = 18; // keep fitted artwork inside the printable area of most printers

export const DEFAULT_PRINT = Object.freeze({
  media: 'artboard',
  mediaW: 612,
  mediaH: 792,
  orientation: 'auto',
  scaling: 'none',
  scale: 100,
  anchor: 'c',
  offsetX: 0,
  offsetY: 0,
  overlap: 0,
  bleed: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
  marks: Object.freeze({ trim: false, registration: false, colorBars: false, pageInfo: false }),
  markWeight: 0.25,
  markOffset: 6,
  markType: 'roman',
});

const anyMarks = (m) => Boolean(m && (m.trim || m.registration || m.colorBars || m.pageInfo));

/** Space the marks need outside the bleed on each side. */
export function marksMargin(settings) {
  if (!anyMarks(settings.marks)) return 0;
  return (settings.markOffset || 0) + MARK_LENGTH + (settings.marks.pageInfo ? 14 : 4);
}

/** Media size for content of size (cw, ch) points. */
export function mediaSize(settings, cw, ch) {
  let w;
  let h;
  if (settings.media === 'artboard') return { w: cw, h: ch };
  if (settings.media === 'custom') {
    w = settings.mediaW;
    h = settings.mediaH;
  } else {
    const m = MEDIA[settings.media] || MEDIA.letter;
    w = m.w;
    h = m.h;
  }
  const landscape = settings.orientation === 'landscape' || (settings.orientation === 'auto' && cw > ch);
  if (landscape !== w > h) [w, h] = [h, w];
  return { w, h };
}

const ANCHOR = {
  tl: [0, 0], t: [0.5, 0], tr: [1, 0],
  l: [0, 0.5], c: [0.5, 0.5], r: [1, 0.5],
  bl: [0, 1], b: [0.5, 1], br: [1, 1],
};

function marksFor(settings, trim, bleedBox, info) {
  const m = settings.marks || {};
  const out = [];
  const o = settings.markOffset || 0;
  const L = MARK_LENGTH;
  const wgt = settings.markWeight || 0.25;
  if (m.trim && settings.markType === 'japanese') {
    // Each corner: lines at the trim and at the bleed (3 pt out when there is none), outside the bleed.
    const bl = { x: Math.min(bleedBox.x, trim.x - 3), y: Math.min(bleedBox.y, trim.y - 3) };
    const br = { x: Math.max(bleedBox.x + bleedBox.w, trim.x + trim.w + 3), y: Math.max(bleedBox.y + bleedBox.h, trim.y + trim.h + 3) };
    for (const [tx, bx, sx] of [[trim.x, bl.x, -1], [trim.x + trim.w, br.x, 1]]) {
      for (const [ty, by, sy] of [[trim.y, bl.y, -1], [trim.y + trim.h, br.y, 1]]) {
        const ex = bx + sx * o;
        const ey = by + sy * o;
        for (const x of [tx, bx]) out.push({ kind: 'line', x1: x, y1: ey, x2: x, y2: ey + sy * L, w: wgt });
        for (const y of [ty, by]) out.push({ kind: 'line', x1: ex, y1: y, x2: ex + sx * L, y2: y, w: wgt });
      }
    }
    // Center marks: a line at the middle of each side with a crossbar.
    const cx = trim.x + trim.w / 2;
    const cy = trim.y + trim.h / 2;
    for (const [y0, sy] of [[bl.y - o, -1], [br.y + o, 1]]) {
      out.push({ kind: 'line', x1: cx, y1: y0, x2: cx, y2: y0 + sy * L, w: wgt });
      out.push({ kind: 'line', x1: cx - L / 2, y1: y0 + (sy * L) / 2, x2: cx + L / 2, y2: y0 + (sy * L) / 2, w: wgt });
    }
    for (const [x0, sx] of [[bl.x - o, -1], [br.x + o, 1]]) {
      out.push({ kind: 'line', x1: x0, y1: cy, x2: x0 + sx * L, y2: cy, w: wgt });
      out.push({ kind: 'line', x1: x0 + (sx * L) / 2, y1: cy - L / 2, x2: x0 + (sx * L) / 2, y2: cy + L / 2, w: wgt });
    }
  } else if (m.trim) {
    // Each corner: one horizontal and one vertical line outside the bleed.
    for (const [cx, sx] of [[trim.x, -1], [trim.x + trim.w, 1]]) {
      for (const [cy, sy] of [[trim.y, -1], [trim.y + trim.h, 1]]) {
        const gx = sx < 0 ? Math.max(o, trim.x - bleedBox.x) : Math.max(o, bleedBox.x + bleedBox.w - (trim.x + trim.w));
        const gy = sy < 0 ? Math.max(o, trim.y - bleedBox.y) : Math.max(o, bleedBox.y + bleedBox.h - (trim.y + trim.h));
        out.push({ kind: 'line', x1: cx + sx * gx, y1: cy, x2: cx + sx * (gx + L), y2: cy, w: wgt });
        out.push({ kind: 'line', x1: cx, y1: cy + sy * gy, x2: cx, y2: cy + sy * (gy + L), w: wgt });
      }
    }
  }
  const outer = { x: bleedBox.x - o, y: bleedBox.y - o, w: bleedBox.w + 2 * o, h: bleedBox.h + 2 * o };
  if (m.registration) {
    const r = 6;
    const d = L / 2 + 2;
    for (const [x, y] of [
      [trim.x + trim.w / 2, outer.y - d],
      [trim.x + trim.w / 2, outer.y + outer.h + d],
      [outer.x - d, trim.y + trim.h / 2],
      [outer.x + outer.w + d, trim.y + trim.h / 2],
    ]) out.push({ kind: 'registration', x, y, r, w: wgt });
  }
  if (m.colorBars) {
    const colors = ['#00ffff', '#ff00ff', '#ffff00', '#000000', '#ff0000', '#00ff00', '#0000ff', '#808080', '#c0c0c0', '#404040'];
    const size = 8;
    let x = trim.x + 12;
    const y = outer.y - L / 2 - size / 2 - 1;
    for (const c of colors) {
      if (x + size > trim.x + trim.w / 2 - 14) break;
      out.push({ kind: 'swatch', x, y, w: size, h: size, color: c });
      x += size;
    }
  }
  if (m.pageInfo && info) out.push({ kind: 'text', x: trim.x, y: outer.y + outer.h + L / 2 + 6, text: info, size: 6 });
  return out;
}

/**
 * Lay out one content rect (an artboard, or the artwork bounds) onto pages.
 * `info` is the page information text for that content.
 */
export function layoutContent(rect, settings, info = '') {
  const s0 = { ...DEFAULT_PRINT, ...settings, bleed: { ...DEFAULT_PRINT.bleed, ...(settings.bleed || {}) }, marks: { ...DEFAULT_PRINT.marks, ...(settings.marks || {}) } };
  const b = s0.bleed;
  const bleedRect = { x: rect.x - b.left, y: rect.y - b.top, w: rect.w + b.left + b.right, h: rect.h + b.top + b.bottom };
  const mm = marksMargin(s0);
  // Content in document units around the trim: bleed plus room for marks (marks do not scale).
  const scaleFor = () => {
    if (s0.scaling === 'custom' || s0.scaling === 'tile') return Math.max(0.01, (s0.scale || 100) / 100);
    return 1;
  };
  let s = scaleFor();
  const contentW = (w) => bleedRect.w * w + 2 * mm;
  const contentH = (w) => bleedRect.h * w + 2 * mm;
  let media = mediaSize(s0, contentW(s), contentH(s));
  if (s0.scaling === 'fit' && s0.media !== 'artboard') {
    const availW = media.w - 2 * FIT_MARGIN - 2 * mm;
    const availH = media.h - 2 * FIT_MARGIN - 2 * mm;
    s = Math.max(0.01, Math.min(availW / bleedRect.w, availH / bleedRect.h));
  }
  if (s0.media === 'artboard') media = { w: contentW(s), h: contentH(s) };
  const cw = contentW(s);
  const ch = contentH(s);

  const place = (pageW, pageH) => {
    const [ax, ay] = ANCHOR[s0.anchor] || ANCHOR.c;
    return { x: (pageW - cw) * ax + (s0.offsetX || 0), y: (pageH - ch) * ay + (s0.offsetY || 0) };
  };

  if (s0.scaling !== 'tile' || (cw <= media.w && ch <= media.h)) {
    const at = place(media.w, media.h);
    const x = at.x + mm;
    const y = at.y + mm;
    const toPage = (r) => ({ x: x + (r.x - bleedRect.x) * s, y: y + (r.y - bleedRect.y) * s, w: r.w * s, h: r.h * s });
    return [{ w: media.w, h: media.h, tiles: [{ rect: bleedRect, clip: bleedRect, x, y, s }], marks: marksFor(s0, toPage(rect), toPage(bleedRect), info) }];
  }

  // Tile full pages: a grid of pages over the scaled content, overlapping by `overlap`.
  const ov = Math.max(0, Math.min(s0.overlap || 0, Math.min(media.w, media.h) / 2));
  const stepX = media.w - ov;
  const stepY = media.h - ov;
  const cols = Math.max(1, Math.ceil((cw - ov) / stepX));
  const rows = Math.max(1, Math.ceil((ch - ov) / stepY));
  const pages = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Content origin relative to this page.
      const x = mm - c * stepX;
      const y = mm - r * stepY;
      const toPage = (q) => ({ x: x + (q.x - bleedRect.x) * s, y: y + (q.y - bleedRect.y) * s, w: q.w * s, h: q.h * s });
      pages.push({ w: media.w, h: media.h, tile: { row: r, col: c, rows, cols }, tiles: [{ rect: bleedRect, clip: bleedRect, x, y, s }], marks: marksFor(s0, toPage(rect), toPage(bleedRect), info ? `${info}  Tile ${r * cols + c + 1}/${rows * cols}` : '') });
    }
  }
  return pages;
}
