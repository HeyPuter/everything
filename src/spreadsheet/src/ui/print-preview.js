/**
 * The print dialog's preview: the sheet as it will fall on paper, one page at a time, following the
 * dialog's choices as they change (paper, orientation, scale, margins, centring, gridlines, headings,
 * title, header and footer). It lays the printed range out in pages the way the print does (whole rows
 * and columns per page, manual breaks honoured) and draws each page on a canvas; it is a picture of the
 * layout, close to the printed result, not the printed result itself.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { printPaperBox, expandPrintText, splitPrintSections, printPageText } from './print.js';
import { printBands } from './print-pagination.js';
import { fillColorCss } from '../core/fill-color.js';
import { fontColorCss } from '../core/font-color.js';
import { fontStack, borderCss } from '../core/format.js';
import { colName } from '../core/cell.js';

const HEAD_W = 36, HEAD_H = 18, TITLE_H = 28;

/** The block the print takes from the sheet: the selection, the print area, or the cells in use. */
function printedArea(wb, sheetId, prefs, range) {
  const sheet = wb.sheet(sheetId);
  if (prefs.area === 'selection' && range) return range;
  if (prefs.area === 'printArea' && sheet.printSettings?.areas?.length) return sheet.printSettings.areas[0];
  return wb.usedRange(sheetId);
}

/**
 * How the printed area falls on pages for these choices: { pages: [{ rows: [r1, r2], cols: [c1, c2] }],
 * scale, box, area, sizes } (sizes in unscaled CSS pixels). A sheet with nothing to print has one blank page.
 */
export function printPreviewLayout(wb, sheetId, prefs, range = null) {
  const sheet = wb.sheet(sheetId);
  const box = printPaperBox(prefs);
  const area = printedArea(wb, sheetId, prefs, range);
  if (!sheet || !area) return { pages: [null], scale: 1, box, area: null };
  const colSizes = [], rowSizes = [];
  for (let c = area.c1; c <= area.c2; c++) colSizes.push(sheet.hiddenCols?.has(c) ? 0 : wb.colWidth(sheetId, c));
  for (let r = area.r1; r <= area.r2; r++) rowSizes.push(sheet.hiddenRows?.has(r) || sheet.filterHidden?.has(r) ? 0 : wb.rowHeight(sheetId, r));
  const headW = prefs.headers ? HEAD_W : 0, headH = prefs.headers ? HEAD_H : 0, titleH = prefs.title ? TITLE_H : 0;
  const contentW = Math.max(1, box.width - box.margins.left - box.margins.right);
  const contentH = Math.max(1, box.height - box.margins.top - box.margins.bottom - titleH);
  const totalW = colSizes.reduce((a, b) => a + b, 0) + headW, totalH = rowSizes.reduce((a, b) => a + b, 0) + headH;
  let scale = 1;
  if (prefs.fit === 'width') scale = Math.min(1, contentW / Math.max(1, totalW));
  else if (prefs.fit === 'scale') scale = (Number(prefs.scale) || 100) / 100;
  else if (prefs.fit === 'pages') {
    if (prefs.fitWidth > 0) scale = Math.min(scale, (contentW * prefs.fitWidth) / Math.max(1, totalW));
    if (prefs.fitHeight > 0) scale = Math.min(scale, (contentH * prefs.fitHeight) / Math.max(1, totalH));
  }
  scale = Math.max(0.1, Math.min(4, scale));
  const forced = (breaks, from, to) => new Set((breaks || []).filter((b) => b > from && b <= to).map((b) => b - from));
  const bands = (sizes, capacity, breaks, from, to) => (printBands(sizes, capacity, 0, forced(breaks, from, to))?.bands || [{ start: 0, end: sizes.length }])
    .filter((b) => b.end > b.start).map((b) => [from + b.start, from + b.end - 1]);
  const colBands = bands(colSizes, contentW / scale - headW, prefs.colBreaks, area.c1, area.c2);
  const rowBands = bands(rowSizes, contentH / scale - headH, prefs.rowBreaks, area.r1, area.r2);
  const pages = [];
  if (prefs.pageOrder === 'overThenDown') for (const rows of rowBands) for (const cols of colBands) pages.push({ rows, cols });
  else for (const cols of colBands) for (const rows of rowBands) pages.push({ rows, cols });
  return { pages: pages.length ? pages : [null], scale, box, area, headW, headH, titleH };
}

/** The pane: a page drawn to scale, with Previous and Next under it. `getPrefs()` reads the dialog's choices. */
export function createPrintPreview({ wb, sheetId, docName, getPrefs, getRange }) {
  let page = 0, layout = null, frame = 0;
  const canvas = el('canvas.print-preview-page');
  const count = el('span.print-preview-count', { 'aria-live': 'polite' });
  const prev = el('button.icon-btn.print-preview-step', { type: 'button', 'aria-label': 'Previous page', title: 'Previous page', html: icon('chevL', 16, 2), onclick: () => go(-1) });
  const next = el('button.icon-btn.print-preview-step', { type: 'button', 'aria-label': 'Next page', title: 'Next page', html: icon('chevR', 16, 2), onclick: () => go(1) });
  const stage = el('div.print-preview-stage', {}, canvas);
  const root = el('div.print-preview', { role: 'group', 'aria-label': 'Print preview' }, stage, el('div.print-preview-nav', {}, prev, count, next));

  function go(step) {
    if (!layout) return;
    page = Math.max(0, Math.min(layout.pages.length - 1, page + step));
    draw();
  }

  function refresh() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      layout = printPreviewLayout(wb, sheetId, getPrefs(), getRange?.());
      page = Math.min(page, layout.pages.length - 1);
      draw();
    });
  }

  function draw() {
    const prefs = getPrefs();
    const { box, pages, scale, headW = 0, headH = 0, titleH = 0 } = layout;
    const total = pages.length;
    count.textContent = `Page ${page + 1} of ${total}`;
    prev.disabled = page === 0;
    next.disabled = page >= total - 1;
    // The page fits the stage: as wide as it allows, no taller than it allows.
    const room = { w: stage.clientWidth || 280, h: stage.clientHeight || 360 };
    const k = Math.min((room.w - 8) / box.width, (room.h - 8) / box.height);
    const w = Math.round(box.width * k), h = Math.round(box.height * k);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    canvas.setAttribute('aria-label', `Page ${page + 1} of ${total}`);
    const g = canvas.getContext?.('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    const m = box.margins;
    const sheet = wb.sheet(sheetId);
    const info = { file: docName || 'Spreadsheet', tab: sheet?.name || '', page: page + 1, pages: total };
    // Header and footer, each in its left, centre and right parts, in the middle of the margin.
    const regular = { ...prefs, header: String(prefs.header || '').trim(), footer: String(prefs.footer || '').trim() || (prefs.native ? '' : 'Page &[Page] of &[Pages]') };
    const texts = printPageText(regular, page);
    g.fillStyle = '#555555';
    g.font = `${Math.max(5, 12 * k)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    g.textBaseline = 'middle';
    for (const [kind, y] of [['header', m.top / 2], ['footer', box.height - m.bottom / 2]]) {
      const parts = splitPrintSections(texts[kind]);
      for (const [side, x, align] of [['left', m.left, 'left'], ['center', box.width / 2, 'center'], ['right', box.width - m.right, 'right']]) {
        const text = expandPrintText(parts[side], info);
        if (!text) continue;
        g.textAlign = align;
        g.fillText(text, x * k, y * k);
      }
    }
    const current = pages[page];
    let x0 = m.left, y0 = m.top;
    if (prefs.title) {
      g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = '#111111';
      g.font = `600 ${Math.max(5, 15 * k)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      g.fillText(info.file, x0 * k, (y0 + 18) * k);
      y0 += titleH;
    }
    if (!current) return;
    const s = scale * k; // canvas pixels per unscaled sheet pixel
    const cols = [], rows = [];
    for (let c = current.cols[0]; c <= current.cols[1]; c++) if (!sheet.hiddenCols?.has(c)) cols.push([c, wb.colWidth(sheetId, c)]);
    for (let r = current.rows[0]; r <= current.rows[1]; r++) if (!sheet.hiddenRows?.has(r) && !sheet.filterHidden?.has(r)) rows.push([r, wb.rowHeight(sheetId, r)]);
    const usedW = cols.reduce((a, [, size]) => a + size, 0) + headW, usedH = rows.reduce((a, [, size]) => a + size, 0) + headH;
    const contentW = box.width - m.left - m.right, contentH = box.height - y0 - m.bottom;
    if (prefs.horizontalCentered) x0 += Math.max(0, (contentW - usedW * scale) / 2);
    if (prefs.verticalCentered) y0 += Math.max(0, (contentH - usedH * scale) / 2);
    const left = x0 * k + headW * s, top = y0 * k + headH * s;
    const xs = [left], ys = [top];
    for (const [, size] of cols) xs.push(xs.at(-1) + size * s);
    for (const [, size] of rows) ys.push(ys.at(-1) + size * s);
    g.save();
    g.beginPath(); g.rect(m.left * k, m.top * k, contentW * k, (box.height - m.top - m.bottom) * k); g.clip();
    // Row numbers and column letters, when they print.
    if (headW) {
      g.fillStyle = '#f1f1f1';
      g.fillRect(x0 * k, y0 * k, xs.at(-1) - x0 * k, headH * s);
      g.fillRect(x0 * k, y0 * k, headW * s, ys.at(-1) - y0 * k);
      g.fillStyle = '#666666'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `${Math.max(3, 11 * s)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      cols.forEach(([c], i) => g.fillText(colName(c), (xs[i] + xs[i + 1]) / 2, y0 * k + headH * s / 2));
      rows.forEach(([r], i) => g.fillText(String(r + 1), x0 * k + headW * s / 2, (ys[i] + ys[i + 1]) / 2));
    }
    // Fills first, then the gridlines, then the text and borders over them.
    rows.forEach(([r], i) => cols.forEach(([c], j) => {
      const bg = fillColorCss(wb.styleAt(sheetId, r, c)?.bg);
      if (bg && bg !== 'transparent') { g.fillStyle = bg; g.fillRect(xs[j], ys[i], xs[j + 1] - xs[j], ys[i + 1] - ys[i]); }
    }));
    if (prefs.gridlines) {
      g.strokeStyle = '#d4d4d4'; g.lineWidth = Math.max(0.5, 0.75 * k);
      g.beginPath();
      for (const x of xs) { g.moveTo(x, top); g.lineTo(x, ys.at(-1)); }
      for (const y of ys) { g.moveTo(left, y); g.lineTo(xs.at(-1), y); }
      g.stroke();
    }
    rows.forEach(([r], i) => cols.forEach(([c], j) => {
      const st = wb.styleAt(sheetId, r, c) || {};
      const cx = xs[j], cy = ys[i], cw = xs[j + 1] - xs[j], ch = ys[i + 1] - ys[i];
      const text = wb.getDisplay(sheetId, r, c);
      if (text) {
        const value = wb.getValue(sheetId, r, c);
        const align = st.align || (typeof value === 'number' ? 'right' : 'left');
        g.save();
        g.beginPath(); g.rect(cx, cy, cw, ch); g.clip();
        g.fillStyle = fontColorCss(st.color) || '#000000';
        g.font = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} ${Math.max(2, (st.size || 13) * s)}px ${fontStack(st.font) || 'sans-serif'}`;
        g.textAlign = align;
        g.textBaseline = st.valign === 'top' ? 'top' : st.valign === 'middle' ? 'middle' : 'bottom';
        const pad = 3 * s;
        const tx = align === 'right' ? cx + cw - pad : align === 'center' ? cx + cw / 2 : cx + pad;
        const ty = st.valign === 'top' ? cy + pad : st.valign === 'middle' ? cy + ch / 2 : cy + ch - pad;
        g.fillText(String(text).split('\n')[0], tx, ty);
        g.restore();
      }
      for (const [flag, x1, y1, x2, y2] of [['bt', cx, cy, cx + cw, cy], ['bb', cx, cy + ch, cx + cw, cy + ch], ['bl', cx, cy, cx, cy + ch], ['br', cx + cw, cy, cx + cw, cy + ch]]) {
        if (!st[flag]) continue;
        const pen = borderCss(st[`${flag}Border`] || st);
        g.strokeStyle = pen.color || '#000000';
        g.lineWidth = Math.max(0.6, parseFloat(pen.width) * s);
        g.setLineDash(pen.style === 'dashed' ? [4 * s, 2 * s] : pen.style === 'dotted' ? [1 * s, 2 * s] : []);
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        g.setLineDash([]);
      }
    }));
    g.restore();
  }

  return { el: root, refresh, get page() { return page; }, get pages() { return layout?.pages.length ?? 0; }, go };
}
