/**
 * The print dialog's preview: the sheet as it will fall on paper, one page at a time, following the
 * dialog's choices as they change (paper, orientation, scale, margins, centring, gridlines, headings,
 * title, header and footer). It lays the printed range out in pages the way the print does (whole rows
 * and columns per page, manual breaks honoured) and draws each page on a canvas; it is a picture of the
 * layout, close to the printed result, not the printed result itself.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { printPaperBox, expandPrintText, splitPrintSections, printPageText, sheetPrintPrefs, manualBreaksApply, printRange } from './print.js';
import { printBands, printTitleBands } from './print-pagination.js';
import { fillColorCss } from '../core/fill-color.js';
import { fontColorCss } from '../core/font-color.js';
import { fontStack, fontKeyFor, borderCss, getLocale, defaultAlign } from '../core/format.js';
import { readsRightToLeft } from '../core/bidi.js';
import { cellLayoutText, wrapLines } from '../core/textfit.js';
import { codeColor } from '../core/numfmt.js';
import { hasHeaderFormatting, parsePrintHeader } from '../core/print-header.js';
import { colName } from '../core/cell.js';
import { conditionalFontStyle } from '../core/style-values.js';
import { nativeFillOverridesNormal } from '../core/native-fill.js';

const HEAD_W = 36, HEAD_H = 18, TITLE_H = 28;

/**
 * The block the print takes from the sheet: the selection, the print area, or the whole sheet as the print bounds it,
 * which reaches past the cells in use to the fills and borders, the charts and pictures, the merges and the text
 * running on from the last column, so the preview counts the pages the print makes. Worked out once for each change
 * of the workbook: the dialog lays the preview out again on every key typed in it.
 */
const wholeSheets = new WeakMap(); // workbook → "sheet id:block" → { version, range }
function printedArea(wb, sheetId, prefs, range, only) {
  const sheet = wb.sheet(sheetId);
  // A block given whole (a print area, the selection) is taken as the print takes it, a whole column as far down as the
  // sheet's print reaches: the preview counted pages down to row 1,048,576, some twenty thousand of them.
  const given = only || (prefs.area === 'selection' && range) || (prefs.area === 'printArea' && sheet.printSettings?.areas?.[0]) || null;
  let kept = wholeSheets.get(wb);
  if (!kept) wholeSheets.set(wb, kept = new Map());
  const key = `${sheetId}:${given ? `${given.r1},${given.c1},${given.r2},${given.c2}` : ''}`;
  if (kept.get(key)?.version !== wb.version) kept.set(key, { version: wb.version, range: printRange(wb, sheetId, { range: given }) });
  return kept.get(key).range;
}

/**
 * How the printed area falls on pages for these choices: { pages: [{ rows: [r1, r2], cols: [c1, c2], repeatRows?,
 * repeatCols? }], scale, box, area, sizes } (sizes in unscaled CSS pixels), where repeatRows and repeatCols list the
 * lines a page repeats before its own. A sheet with nothing to print has one blank page.
 */
export function printPreviewLayout(wb, sheetId, prefs, range = null, only = null) {
  const sheet = wb.sheet(sheetId);
  const box = printPaperBox(prefs);
  const area = printedArea(wb, sheetId, prefs, range, only);
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
  /**
   * The lines each page takes: [first, last] of the block, and the lines repeated above (or beside) them on
   * that page, as the print repeats them: rows (or columns) to repeat, from wherever they are on the sheet, or
   * else the frozen rows the block starts with, when they repeat.
   */
  const bands = (sizes, capacity, breaks, from, to, titles, hidden, size, frozen) => {
    const plain = (list) => list.filter((b) => b.end > b.start).map((b) => ({ lines: [from + b.start, from + b.end - 1] }));
    const whole = [{ lines: [from, to] }];
    if (titles) {
      // As the print lays them out: the title lines above the block, then the block, hidden lines left out.
      const lines = [];
      for (let i = titles[0]; i <= Math.min(titles[1], from - 1); i++) if (!hidden(i)) lines.push(i);
      const bodyStart = lines.length;
      for (let i = from; i <= to; i++) if (!hidden(i)) lines.push(i);
      const repeat = lines.map((n, i) => (n >= titles[0] && n <= titles[1] ? i : -1)).filter((i) => i >= 0);
      if (!repeat.length || bodyStart >= lines.length) return plain(printBands(sizes, capacity, 0, forced(breaks, from, to))?.bands || [{ start: 0, end: sizes.length }]);
      const offsets = [0];
      for (const line of lines) offsets.push(offsets.at(-1) + size(line));
      // A band's pieces are runs of lines, by offset: each run's lines are those that start inside it. The offsets
      // only grow, so each run is found by halving rather than by reading every line for every page (a sheet of
      // 50,000 rows took over a second a keystroke).
      const firstAt = (at) => { let lo = 0, hi = lines.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] < at) lo = mid + 1; else hi = mid; } return lo; };
      const linesIn = ({ offset, size: extent }) => lines.slice(firstAt(offset), firstAt(offset + extent));
      const breakAt = new Set([...forced(breaks, from, to)].map((b) => lines.findIndex((n) => n >= from + b)).filter((i) => i > bodyStart));
      const list = printTitleBands(lines.map(size), capacity, { bodyStart, repeat: [repeat[0], repeat.at(-1) + 1] }, breakAt) || [];
      const out = list.map(({ segments }) => {
        const body = linesIn(segments.at(-1)), repeated = segments.slice(0, -1).flatMap(linesIn);
        return body.length ? { lines: [body[0], body.at(-1)], ...(repeated.length ? { repeat: repeated } : {}) } : null;
      }).filter(Boolean);
      return out.length ? out : whole;
    }
    const result = printBands(sizes, capacity, frozen, forced(breaks, from, to));
    const list = (result?.bands || []).filter((b) => b.end > b.start);
    if (!list.length) return frozen ? plain(printBands(sizes, capacity, 0, forced(breaks, from, to))?.bands || [{ start: 0, end: sizes.length }]) : whole;
    // The frozen rows that fit stay at the top of every page; their first page is the block's own first page.
    const head = list[0].start;
    const repeated = [];
    for (let i = from; i < from + head; i++) if (!hidden(i)) repeated.push(i);
    return list.map((b, i) => (i === 0 ? { lines: [from, from + b.end - 1] } : { lines: [from + b.start, from + b.end - 1], ...(repeated.length ? { repeat: repeated } : {}) }));
  };
  const hiddenCol = (c) => !!sheet.hiddenCols?.has(c), hiddenRow = (r) => !!(sheet.hiddenRows?.has(r) || sheet.filterHidden?.has(r));
  const titleRows = Array.isArray(prefs.titleRows) ? prefs.titleRows : null, titleCols = Array.isArray(prefs.titleCols) ? prefs.titleCols : null;
  // The sheet's frozen rows the block starts with repeat on every page, unless rows to repeat are named.
  const frozen = !titleRows && prefs.repeatFrozen ? Math.max(0, Math.min(sheet.frozenRows || 0, area.r2 + 1) - area.r1) : 0;
  // Manual breaks give way to fitting, as in the print: across when fitted to the page's width, or to a number of pages wide; down when fitted to a number of pages tall.
  const breaks = manualBreaksApply(prefs);
  const colBands = bands(colSizes, contentW / scale - headW, breaks.cols ? prefs.colBreaks : null, area.c1, area.c2, titleCols, hiddenCol, (c) => wb.colWidth(sheetId, c), 0);
  const rowBands = bands(rowSizes, contentH / scale - headH, breaks.rows ? prefs.rowBreaks : null, area.r1, area.r2, titleRows, hiddenRow, (r) => wb.rowHeight(sheetId, r), frozen);
  const page = (r, c) => ({ rows: r.lines, cols: c.lines, ...(r.repeat ? { repeatRows: r.repeat } : {}), ...(c.repeat ? { repeatCols: c.repeat } : {}) });
  const pages = [];
  if (prefs.pageOrder === 'overThenDown') for (const rows of rowBands) for (const cols of colBands) pages.push(page(rows, cols));
  else for (const cols of colBands) for (const rows of rowBands) pages.push(page(rows, cols));
  // Fitted to the page's width, a block narrower than the page is stretched across it, its columns (and the row numbers'
  // column) widened in proportion and its rows and text left as they are, as the print lays it out.
  const stretch = prefs.fit === 'width' && totalW < contentW ? contentW / Math.max(1, totalW) : 1;
  return { pages: pages.length ? pages : [null], scale, stretch, box, area, headW, headH, titleH };
}

/**
 * Every page the print makes, in order, as [{ sheetId, prefs, layout, page }]: for All sheets each visible sheet's
 * pages in turn, each with its own page setup, and with a print area of several blocks each block's pages, as the
 * print lays them out one after the other.
 */
export function printPreviewJob(wb, sheetId, prefs, range = null) {
  const sheets = prefs.area === 'workbook' ? wb.sheets.filter((sh) => !sh.hidden) : [wb.sheet(sheetId)].filter(Boolean);
  // The selection may be several ranges (a list): each prints on pages of its own, as a print area's blocks do.
  const selected = prefs.area === 'selection' && Array.isArray(range) && range.length ? range : null;
  if (Array.isArray(range)) range = range[0] || null;
  const job = [];
  for (const sh of sheets) {
    const own = sh.id === sheetId ? prefs : { ...prefs, ...sheetPrintPrefs(sh), area: prefs.area };
    const areas = selected || ((prefs.area === 'printArea' || prefs.area === 'workbook') && sh.printSettings?.areas?.length ? sh.printSettings.areas : [null]);
    for (const only of areas) {
      const layout = printPreviewLayout(wb, sh.id, own, range, only);
      for (const page of layout.pages) job.push({ sheetId: sh.id, prefs: own, layout, page });
    }
  }
  return job.length ? job : [{ sheetId, prefs, layout: printPreviewLayout(wb, sheetId, prefs, range), page: null }];
}

/**
 * A header or footer written with Excel's formatting codes, its left, centre and right parts each drawn run by run
 * in the font, size, weight and colour the codes give, as the print sets them. `places` are [side, x, align].
 */
function drawRichText(g, text, info, wb, k, y, places) {
  const sections = parsePrintHeader(text, wb.colorPalette);
  const now = info.now || new Date();
  const values = { Page: info.page, Pages: info.pages, Tab: info.tab, File: info.file, Path: info.path || '',
    Date: now.toLocaleDateString(getLocale()), Time: now.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) };
  const fontOf = (s) => `${s.italic ? 'italic ' : ''}${s.bold ? '700' : '400'} ${Math.max(4, (s.size || wb.normalFont?.sz || 11) * 4 / 3 * k * (s.super || s.sub ? 0.75 : 1))}px ${fontStack(fontKeyFor(s.font || wb.normalFont?.name || 'Arial', { literal: true }))}`;
  g.textAlign = 'left';
  for (const [side, x, align] of places) {
    const runs = sections[side].map((run) => ({ text: run.token ? String(values[run.token] ?? '') : run.text, style: run.style || {} })).filter((run) => run.text);
    if (!runs.length) continue;
    const widths = runs.map((run) => { g.font = fontOf(run.style); return g.measureText?.(run.text)?.width || 0; });
    const total = widths.reduce((a, b) => a + b, 0);
    let at = align === 'left' ? x : align === 'center' ? x - total / 2 : x - total;
    runs.forEach((run, i) => {
      g.font = fontOf(run.style);
      g.fillStyle = run.style.color || '#000000';
      g.fillText(run.text, at, y);
      at += widths[i];
    });
  }
}

/** The pane: a page drawn to scale, with Previous and Next under it. `getPrefs()` reads the dialog's choices. */
export function createPrintPreview({ wb, sheetId, docName, filePath = '', getPrefs, getRange }) {
  let page = 0, job = null, frame = 0;
  const canvas = el('canvas.print-preview-page');
  const count = el('span.print-preview-count', { 'aria-live': 'polite' });
  const prev = el('button.icon-btn.print-preview-step', { type: 'button', 'aria-label': 'Previous page', title: 'Previous page', html: icon('chevL', 16, 2), onclick: () => go(-1) });
  const next = el('button.icon-btn.print-preview-step', { type: 'button', 'aria-label': 'Next page', title: 'Next page', html: icon('chevR', 16, 2), onclick: () => go(1) });
  const stage = el('div.print-preview-stage', {}, canvas);
  const root = el('div.print-preview', { role: 'group', 'aria-label': 'Print preview' }, stage, el('div.print-preview-nav', {}, prev, count, next));

  function go(step) {
    if (!job) return;
    page = Math.max(0, Math.min(job.length - 1, page + step));
    draw();
  }

  function refresh() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      job = printPreviewJob(wb, sheetId, getPrefs(), getRange?.());
      page = Math.min(page, job.length - 1);
      draw();
    });
  }

  // The page is fitted to the room the pane gives it, which a turned tablet or a resized window changes as the dialog
  // is laid out again (beside the choices, or under them): drawn for the old room, it was cut off or left small.
  let drawnFor = '';
  const roomNow = () => `${stage.clientWidth}x${stage.clientHeight}`;
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (job && roomNow() !== drawnFor) refresh();
  }) : null;
  resized?.observe(stage);

  function draw() {
    drawnFor = roomNow();
    const { sheetId: shown, prefs, layout, page: current } = job[page];
    const { box, scale, stretch = 1, headW = 0, headH = 0, titleH = 0 } = layout;
    const total = job.length;
    // A live region: written only when it changes, or a screen reader reads it out again on every key typed in the dialog.
    const counted = `Page ${page + 1} of ${total}`;
    if (count.textContent !== counted) count.textContent = counted;
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
    const sheet = wb.sheet(shown);
    // Numbered as the print numbers them: from the first sheet's starting number, on through the later sheets.
    const first = job[0].prefs.useFirstPageNumber && Number.isFinite(job[0].prefs.firstPageNumber) ? job[0].prefs.firstPageNumber : 1;
    const info = { file: docName || 'Spreadsheet', path: filePath, tab: sheet?.name || '', page: first + page, pages: total };
    // Header and footer, each in its left, centre and right parts, in the middle of the margin.
    const regular = { ...prefs, header: String(prefs.header || '').trim(), footer: String(prefs.footer || '').trim() || (prefs.native ? '' : 'Page &[Page] of &[Pages]') };
    const texts = printPageText(regular, page);
    g.fillStyle = '#555555';
    g.font = `${Math.max(5, 12 * k)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    g.textBaseline = 'middle';
    const places = [['left', m.left, 'left'], ['center', box.width / 2, 'center'], ['right', box.width - m.right, 'right']];
    for (const [kind, y] of [['header', m.top / 2], ['footer', box.height - m.bottom / 2]]) {
      // Excel's formatting codes (&B, &"Arial,Bold", &14, &K…) are drawn as the styles they name, not as text.
      if (hasHeaderFormatting(texts[kind])) {
        drawRichText(g, texts[kind], info, wb, k, y * k, places.map(([side, x, align]) => [side, x * k, align]));
        g.fillStyle = '#555555';
        g.font = `${Math.max(5, 12 * k)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        continue;
      }
      const parts = splitPrintSections(texts[kind]);
      for (const [side, x, align] of places) {
        const text = expandPrintText(parts[side], info);
        if (!text) continue;
        g.textAlign = align;
        g.fillText(text, x * k, y * k);
      }
    }
    let x0 = m.left, y0 = m.top;
    if (prefs.title) {
      g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = '#111111';
      g.font = `600 ${Math.max(5, 15 * k)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      g.fillText(info.file, x0 * k, (y0 + 18) * k);
      // The sheet's name beside it, as the print writes it when the workbook has more than one.
      if (wb.sheets.length > 1 && sheet) {
        const after = (g.measureText?.(info.file)?.width || 0) + 12 * k;
        g.fillStyle = '#555555';
        g.font = `${Math.max(4, 13 * k)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        g.fillText(sheet.name, x0 * k + after, (y0 + 18) * k);
      }
      y0 += titleH;
    }
    if (!current) return;
    const s = scale * k; // canvas pixels per unscaled sheet pixel
    // The repeated lines (rows to repeat, frozen rows) first, then the page's own.
    const cols = (current.repeatCols || []).map((c) => [c, wb.colWidth(shown, c)]);
    const rows = (current.repeatRows || []).map((r) => [r, wb.rowHeight(shown, r)]);
    for (let c = current.cols[0]; c <= current.cols[1]; c++) if (!sheet.hiddenCols?.has(c)) cols.push([c, wb.colWidth(shown, c)]);
    for (let r = current.rows[0]; r <= current.rows[1]; r++) if (!sheet.hiddenRows?.has(r) && !sheet.filterHidden?.has(r)) rows.push([r, wb.rowHeight(shown, r)]);
    const usedW = cols.reduce((a, [, size]) => a + size, 0) + headW, usedH = rows.reduce((a, [, size]) => a + size, 0) + headH;
    const contentW = box.width - m.left - m.right, contentH = box.height - y0 - m.bottom;
    if (prefs.horizontalCentered) x0 += Math.max(0, (contentW - usedW * scale * stretch) / 2);
    if (prefs.verticalCentered) y0 += Math.max(0, (contentH - usedH * scale) / 2);
    const sx = s * stretch; // across, the stretch of a block fitted to the page's width
    const left = x0 * k + headW * sx, top = y0 * k + headH * s;
    const xs = [left], ys = [top];
    for (const [, size] of cols) xs.push(xs.at(-1) + size * sx);
    for (const [, size] of rows) ys.push(ys.at(-1) + size * s);
    g.save();
    g.beginPath(); g.rect(m.left * k, m.top * k, contentW * k, (box.height - m.top - m.bottom) * k); g.clip();
    // Row numbers and column letters, when they print.
    if (headW) {
      g.fillStyle = '#f1f1f1';
      g.fillRect(x0 * k, y0 * k, xs.at(-1) - x0 * k, headH * s);
      g.fillRect(x0 * k, y0 * k, headW * sx, ys.at(-1) - y0 * k);
      g.fillStyle = '#666666'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `${Math.max(3, 11 * s)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      cols.forEach(([c], i) => g.fillText(colName(c), (xs[i] + xs[i + 1]) / 2, y0 * k + headH * s / 2));
      rows.forEach(([r], i) => g.fillText(String(r + 1), x0 * k + headW * sx / 2, (ys[i] + ys[i + 1]) / 2));
    }
    // Each cell as it prints: its own style, under its table's colours (header, banded rows) and its conditional
    // formatting, which paint over it as they do on screen and on paper; a cell's own fill shows through a table's coat.
    const looked = !!(sheet.rules?.length || sheet.tables?.length);
    const lookAt = (r, c) => {
      const own = wb.styleAt(shown, r, c) || {};
      const value = wb.getValue(shown, r, c);
      const cf = looked ? wb.conditionalStyle(shown, r, c, value) : null;
      const bg = cf?.bg && !(nativeFillOverridesNormal(own, wb.nativeNormalFill) && cf.coat) ? cf.bg : own.bg;
      return { st: conditionalFontStyle(own, cf), cf, bg, value };
    };
    const looks = rows.map(([r]) => cols.map(([c]) => lookAt(r, c)));
    // Merged cells print as one block: the top-left cell's fill and text across it, with no gridlines inside. Each run of
    // the block on this page is a span; the value shows in the span that holds the block's first shown row and column,
    // not again where a block runs on from the page before.
    const spans = new Map(); // "i,j" of each cell a span covers → the span
    if (sheet.merges?.length) {
      const hiddenRow = (r) => !!(sheet.hiddenRows?.has(r) || sheet.filterHidden?.has(r)), hiddenCol = (c) => !!sheet.hiddenCols?.has(c);
      const runs = (list, lo, hi) => {
        const out = [];
        list.forEach(([n], i) => { if (n < lo || n > hi) return; const run = out.at(-1); if (run && run[1] === i - 1) run[1] = i; else out.push([i, i]); });
        return out;
      };
      const before = (from, to, hidden) => { for (let n = from; n < to; n++) if (!hidden(n)) return true; return false; };
      const span = (list) => list.reduce(([lo, hi], [n]) => [Math.min(lo, n), Math.max(hi, n)], [Infinity, -Infinity]);
      const [rLo, rHi] = span(rows), [cLo, cHi] = span(cols);
      for (const m of sheet.merges) {
        if (m.r2 < rLo || m.r1 > rHi || m.c2 < cLo || m.c1 > cHi) continue; // off this page: a sheet may hold thousands
        for (const [i0, i1] of runs(rows, m.r1, m.r2)) for (const [j0, j1] of runs(cols, m.c1, m.c2)) {
          if (i0 === i1 && j0 === j1) continue;
          const show = !before(m.r1, rows[i0][0], hiddenRow) && !before(m.c1, cols[j0][0], hiddenCol);
          const look = show ? (rows[i0][0] === m.r1 && cols[j0][0] === m.c1 ? looks[i0][j0] : lookAt(m.r1, m.c1)) : { ...looks[i0][j0], value: null };
          const span = { i0, j0, i1, j1, look, from: show ? [m.r1, m.c1] : [rows[i0][0], cols[j0][0]], x: xs[j0], y: ys[i0], w: xs[j1 + 1] - xs[j0], h: ys[i1 + 1] - ys[i0] };
          for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) spans.set(`${i},${j}`, span);
        }
      }
    }
    const spanBg = (span) => fillColorCss(span.look.bg);
    // Fills first, then the gridlines, then the text and borders over them.
    rows.forEach((_, i) => cols.forEach((__, j) => {
      const span = spans.get(`${i},${j}`);
      if (span && (span.i0 !== i || span.j0 !== j)) return;
      const bg = span ? spanBg(span) : fillColorCss(looks[i][j].bg);
      if (bg && bg !== 'transparent') { g.fillStyle = bg; span ? g.fillRect(span.x, span.y, span.w, span.h) : g.fillRect(xs[j], ys[i], xs[j + 1] - xs[j], ys[i + 1] - ys[i]); }
    }));
    if (prefs.gridlines) {
      g.strokeStyle = '#d4d4d4'; g.lineWidth = Math.max(0.5, 0.75 * k);
      g.beginPath();
      for (const x of xs) { g.moveTo(x, top); g.lineTo(x, ys.at(-1)); }
      for (const y of ys) { g.moveTo(left, y); g.lineTo(xs.at(-1), y); }
      g.stroke();
      // A merged block has no gridlines inside it: painted over again, short of its own edges.
      const inset = g.lineWidth / 2;
      for (const span of new Set(spans.values())) {
        const bg = spanBg(span);
        g.fillStyle = bg && bg !== 'transparent' ? bg : '#ffffff';
        g.fillRect(span.x + inset, span.y + inset, span.w - 2 * inset, span.h - 2 * inset);
      }
    }
    // A cell under a checkbox rule prints a tick box in place of its TRUE or FALSE, blank or not, as the grid shows it.
    const ruleAt = sheet.validations?.length ? (r, c) => wb.validationAt(shown, r, c) : () => null;
    const tickBox = (rule, on, cx, cy, cw, ch) => {
      const excel = rule.checkboxStyle === 'excel', size = (excel ? 12 : 13) * s;
      const x = excel && Number.isFinite(rule.checkboxOffset) ? cx + Math.max(0, Math.min(rule.checkboxOffset * sx, cw - size)) : cx + (cw - size) / 2;
      const y = cy + (ch - size) / 2;
      g.save();
      g.beginPath(); g.rect(cx, cy, cw, ch); g.clip();
      g.beginPath();
      if (excel || !g.roundRect) g.rect(x, y, size, size); else g.roundRect(x, y, size, size, 3.5 * s);
      g.fillStyle = excel ? '#ffffff' : on ? '#356d49' : '#ffffff';
      g.fill();
      g.strokeStyle = excel ? '#000000' : on ? '#356d49' : '#6b6964';
      g.lineWidth = Math.max(0.5, (excel ? 1 : 1.5) * s);
      g.stroke();
      if (on) {
        g.beginPath();
        g.moveTo(x + size * 0.23, y + size * 0.52); g.lineTo(x + size * 0.44, y + size * 0.72); g.lineTo(x + size * 0.79, y + size * 0.3);
        g.strokeStyle = excel ? '#000000' : '#ffffff';
        g.lineWidth = Math.max(0.5, (excel ? 1.5 : 2) * s);
        g.stroke();
      }
      g.restore();
    };
    rows.forEach(([r], i) => cols.forEach(([c], j) => {
      const span = spans.get(`${i},${j}`);
      const lead = !span || (span.i0 === i && span.j0 === j);
      // A merged block's text is its top-left cell's, set in the whole block; the cells it covers draw no text of their own.
      const { st, cf, value } = span ? (lead ? span.look : { ...looks[i][j], value: null }) : looks[i][j];
      const cx = span ? span.x : xs[j], cy = span ? span.y : ys[i], cw = span ? span.w : xs[j + 1] - xs[j], ch = span ? span.h : ys[i + 1] - ys[i];
      const [sr, sc] = span ? span.from : [r, c];
      const rule = lead ? ruleAt(sr, sc) : null;
      const checkbox = rule?.type === 'checkbox';
      if (checkbox) tickBox(rule, value === true, cx, cy, cw, ch);
      // A sheet set to hide its zero values prints those cells blank, as the grid shows them.
      const text = !lead || value == null || checkbox || cf?.barOnly || cf?.iconOnly || (value === 0 && sheet.zeros === false) ? '' : wb.getDisplay(shown, sr, sc);
      if (text) {
        // With no alignment of its own, as the print sets it: logical values and errors centred, text written right to left at the right.
        const align = st.align || (typeof value === 'string' && readsRightToLeft(text) ? 'right' : defaultAlign(value));
        // Text runs on over the empty cells beside it, as it prints: rightward from the left, leftward from the right, both
        // ways from the centre. A number, a merged block, wrapped or clipped text keeps to its own cell.
        let jl = j, jr = j;
        if (!span && typeof value === 'string' && !st.wrap && !st.clip && !st.shrink && !st.rot) {
          const empty = (jj) => jj >= 0 && jj < cols.length && !spans.has(`${i},${jj}`) && (looks[i][jj].value == null || looks[i][jj].value === '');
          if (align !== 'right') while (empty(jr + 1)) jr++;
          if (align !== 'left') while (empty(jl - 1)) jl--;
        }
        g.save();
        const clipX = jl === j ? cx : xs[jl], clipEnd = jr === j ? cx + cw : xs[jr + 1];
        g.beginPath(); g.rect(clipX, cy, clipEnd - clipX, ch); g.clip();
        // A format's own colour ([Red] negatives) as the print inks it, under conditional formatting's.
        const formatColor = st.fmt === 'custom' && st.code ? codeColor(value, st.code, wb.colorPalette) : null;
        g.fillStyle = fontColorCss(cf?.color || formatColor || st.color) || '#000000';
        g.font = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} ${Math.max(2, (st.size || 13) * s)}px ${fontStack(st.font) || 'sans-serif'}`;
        g.textAlign = align;
        g.textBaseline = st.valign === 'top' ? 'top' : st.valign === 'middle' ? 'middle' : 'bottom';
        const pad = 3 * s;
        const tx = align === 'right' ? cx + cw - pad : align === 'center' ? cx + cw / 2 : cx + pad;
        const ty = st.valign === 'top' ? cy + pad : st.valign === 'middle' ? cy + ch / 2 : cy + ch - pad;
        // Underlined or struck-through text is drawn so, as it prints: a line under (or through) each line of it.
        const size = Math.max(2, (st.size || 13) * s);
        const write = (line, y) => {
          g.fillText(line, tx, y);
          const width = (st.underline || st.strike) && (g.measureText?.(line)?.width || 0);
          if (!width) return;
          const x = align === 'right' ? tx - width : align === 'center' ? tx - width / 2 : tx;
          const base = g.textBaseline;
          g.strokeStyle = g.fillStyle;
          g.lineWidth = Math.max(0.5, size / 14);
          g.beginPath();
          if (st.underline) { const u = base === 'top' ? y + size * 0.95 : base === 'middle' ? y + size * 0.45 : y - size * 0.15; g.moveTo(x, u); g.lineTo(x + width, u); }
          if (st.strike) { const t = base === 'top' ? y + size * 0.5 : base === 'middle' ? y : y - size * 0.6; g.moveTo(x, t); g.lineTo(x + width, t); }
          g.stroke();
        };
        // Wrapped text in the lines it prints in, set at the top, middle or bottom of its cell; unwrapped, on one line.
        const shownText = cellLayoutText(text, st.wrap);
        if (st.wrap) {
          const lineHeight = size * 1.3;
          const lines = wrapLines(shownText, Math.max(1, cw - 2 * pad), (t) => g.measureText?.(t)?.width || 0);
          const block = lines.length * lineHeight;
          let y = st.valign === 'top' ? cy + pad : st.valign === 'middle' ? cy + (ch - block) / 2 : cy + ch - pad - block;
          g.textBaseline = 'top';
          for (const line of lines) { write(line, y); y += lineHeight; }
        } else write(shownText, ty);
        g.restore();
      }
      // Each cell's borders on its own edges; inside a merged block, only those on the block's outline.
      const own = looks[i][j].st, ox = xs[j], oy = ys[i], ow = xs[j + 1] - xs[j], oh = ys[i + 1] - ys[i];
      const outline = { bt: !span || i === span.i0, bb: !span || i === span.i1, bl: !span || j === span.j0, br: !span || j === span.j1 };
      for (const [flag, x1, y1, x2, y2] of [['bt', ox, oy, ox + ow, oy], ['bb', ox, oy + oh, ox + ow, oy + oh], ['bl', ox, oy, ox, oy + oh], ['br', ox + ow, oy, ox + ow, oy + oh]]) {
        if (!own[flag] || !outline[flag]) continue;
        const pen = borderCss(own[`${flag}Border`] || own);
        g.strokeStyle = pen.color || '#000000';
        g.lineWidth = Math.max(0.6, parseFloat(pen.width) * s);
        g.setLineDash(pen.style === 'dashed' ? [4 * s, 2 * s] : pen.style === 'dotted' ? [1 * s, 2 * s] : []);
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        g.setLineDash([]);
      }
    }));
    g.restore();
  }

  return { el: root, refresh, get page() { return page; }, get pages() { return layout?.pages.length ?? 0; }, go,
    destroy() { resized?.disconnect(); cancelAnimationFrame(frame); } };
}
