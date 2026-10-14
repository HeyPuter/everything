/**
 * A picture of a range of cells, as SVG: Paste Special ▸ Picture keeps one such picture, and a
 * linked picture (Paste Special ▸ Linked Picture) draws its range again whenever the cells change.
 * The drawing is plain SVG (rectangles, lines, text and images, no embedded HTML) so the same
 * picture shows on the sheet, prints, copies as a bitmap and goes into the file as a picture.
 *
 * What it shows: the cells' values as formatted, their fills (conditional ones too), fonts, text
 * colours, alignment, borders, merged cells and pictures in cells. Gridlines are left out, as a
 * picture of cells shows them without the sheet's lines; hidden rows and columns are left out too.
 */
import { normalizeRange } from './cell.js';
import { formatValue, fontStack, defaultAlign, borderCss } from './format.js';
import { fontColorCss } from './font-color.js';
import { fillColorCss } from './fill-color.js';
import { createBorderResolver } from './shared-borders.js';
import { codeColor } from './numfmt.js';
import { isError } from './formula/functions.js';
import { isCellPicture, cellPictureAspect } from './cell-picture.js';

/** Past this many cells a picture of a range is not drawn (the reference most likely names whole columns). */
export const RANGE_PICTURE_MAX_CELLS = 20000;
const DEFAULT_FONT = 'Calibri, Carlito, Arial, sans-serif';
const DEFAULT_SIZE = 13;

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  // Characters XML cannot carry at all (control characters other than tab and line ends).
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
const px = (n) => Math.round(n * 100) / 100;

/** The sheet and range a linked picture's reference names now, or null when it names nothing. */
export function linkedPictureTarget(wb, sheetId, ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const target = wb.rangeFromText(sheetId, ref.trim().replace(/^=/, ''));
  if (!target || !wb.sheet(target.sheetId) || wb.sheet(target.sheetId).kind === 'chart') return null;
  return { sheetId: target.sheetId, range: normalizeRange(target.range) };
}

/** The size, in sheet pixels, a picture of the range takes: its shown columns and rows. */
export function rangePictureSize(wb, sheetId, range) {
  const n = normalizeRange(range), sheet = wb.sheet(sheetId);
  let w = 0, h = 0;
  for (let c = n.c1; c <= Math.min(n.c2, (sheet?.cols ?? n.c2 + 1) - 1); c++) w += wb.colWidth(sheetId, c);
  for (let r = n.r1; r <= Math.min(n.r2, (sheet?.rows ?? n.r2 + 1) - 1); r++) h += wb.rowHeight(sheetId, r);
  return { w, h };
}

/**
 * The picture of `range` on `sheetId`: { svg, w, h }, or null when the range shows nothing (all of it
 * hidden) or is too large to draw. `fontFamily` stands in for cells with no font of their own; `idPrefix`
 * keeps the picture's clip ids apart from another's drawn into the same page.
 */
export function rangePicture(wb, sheetId, range, { fontFamily = DEFAULT_FONT, background = '#ffffff', idPrefix = 'rp' } = {}) {
  const sheet = wb.sheet(sheetId);
  if (!sheet || sheet.kind === 'chart') return null;
  const n = normalizeRange(range);
  const r2 = Math.min(n.r2, sheet.rows - 1), c2 = Math.min(n.c2, sheet.cols - 1);
  if (r2 < n.r1 || c2 < n.c1 || (r2 - n.r1 + 1) * (c2 - n.c1 + 1) > RANGE_PICTURE_MAX_CELLS) return null;
  // Where each row and column starts in the picture; hidden ones take no room.
  const xs = [0], ys = [0];
  for (let c = n.c1; c <= c2; c++) xs.push(xs.at(-1) + wb.colWidth(sheetId, c));
  for (let r = n.r1; r <= r2; r++) ys.push(ys.at(-1) + wb.rowHeight(sheetId, r));
  const W = xs.at(-1), H = ys.at(-1);
  if (W <= 0 || H <= 0) return null;
  const X = (c) => xs[c - n.c1], Y = (r) => ys[r - n.r1];
  const colW = (c) => xs[c - n.c1 + 1] - xs[c - n.c1], rowH = (r) => ys[r - n.r1 + 1] - ys[r - n.r1];
  // Unformatted cells take the workbook's Normal face at the sheet's default size, as the grid draws them.
  const base = wb.normalStyle?.font ? { font: wb.normalStyle.font } : null;
  const styleAt = (r, c) => {
    const own = wb.displayStyleAt ? wb.displayStyleAt(sheetId, r, c) : wb.styleAt(sheetId, r, c);
    const table = sheet.tables?.some((t) => t.customStyle) ? wb._tableStyleAt?.(sheet, r, c) : null;
    return table ? { ...table, ...own } : own;
  };
  const valueAt = (r, c) => {
    const cell = sheet.cells.get(`${r},${c}`);
    if (cell && (cell.v != null || cell.f != null)) return wb.getValue(sheetId, r, c);
    return wb.spillAt?.(sheetId, r, c)?.value ?? null;
  };
  const conditional = (r, c, value) => (sheet.rules?.length || sheet.tables?.length ? wb.conditionalStyle(sheetId, r, c, value) : null);
  const resolve = createBorderResolver({
    read: (r, c) => ({ style: wb.styleAt(sheetId, r, c), table: null, conditional: sheet.rules?.length ? wb.conditionalStyle(sheetId, r, c, wb.getValue(sheetId, r, c), { banding: false }) : null }),
    mergeAt: sheet.merges?.length ? (r, c) => wb.mergeAt(sheetId, r, c) : undefined,
    neighbor: (r, c, side) => {
      const rr = side === 'bt' ? r - 1 : side === 'bb' ? r + 1 : r, cc = side === 'bl' ? c - 1 : side === 'br' ? c + 1 : c;
      return rr >= 0 && cc >= 0 ? [rr, cc] : null;
    },
  });
  const fills = [], texts = [], lines = [], pictures = [], clips = [];
  let clipId = 0;
  const clipFor = (x, y, w, h) => {
    const id = `${idPrefix}${clipId++}`;
    clips.push(`<clipPath id="${id}"><rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}"/></clipPath>`);
    return id;
  };
  for (let r = n.r1; r <= r2; r++) {
    if (rowH(r) <= 0) continue;
    for (let c = n.c1; c <= c2; c++) {
      if (colW(c) <= 0) continue;
      const merge = sheet.merges?.length ? wb.mergeAt(sheetId, r, c) : null;
      // A merged area is drawn once, from its first cell shown in the picture.
      if (merge && (r !== Math.max(merge.r1, n.r1) || c !== Math.max(merge.c1, n.c1))) continue;
      const mr = merge ? Math.min(merge.r2, r2) : r, mc = merge ? Math.min(merge.c2, c2) : c;
      const x = X(c), y = Y(r), w = X(mc) + colW(mc) - x, h = Y(mr) + rowH(mr) - y;
      const sr = merge ? merge.r1 : r, sc = merge ? merge.c1 : c;
      const value = valueAt(sr, sc);
      const st = { ...base, ...styleAt(sr, sc) };
      const cf = conditional(sr, sc, value);
      const fill = fillColorCss(cf?.bg || st.bg);
      if (fill && fill !== 'transparent') fills.push(`<rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" fill="${esc(fill)}"/>`);
      // Borders: each shared edge once, as the sheet resolves it.
      const edges = merge ? {} : resolve(r, c, wb.styleAt(sheetId, r, c), sheet.rules?.length ? wb.conditionalStyle(sheetId, r, c, value, { banding: false }) : null, null);
      for (const [side, x1, y1, x2, y2] of [['bt', x, y, x + w, y], ['bb', x, y + h, x + w, y + h], ['bl', x, y, x, y + h], ['br', x + w, y, x + w, y + h]]) {
        const pen = merge ? (st[side] ? st[`${side}Border`] || st : null) : edges[side] ? edges[`${side}Border`] : null;
        if (!pen) continue;
        const css = borderCss(pen), width = parseFloat(css.width) || 1;
        const color = fontColorCss(pen.bc) || (typeof pen.bc === 'string' ? pen.bc : '#000000');
        const dash = css.style === 'dashed' ? ` stroke-dasharray="${width * 3} ${width * 2}"` : css.style === 'dotted' ? ` stroke-dasharray="${width} ${width}"` : '';
        lines.push(`<line x1="${px(x1)}" y1="${px(y1)}" x2="${px(x2)}" y2="${px(y2)}" stroke="${esc(color === 'windowtext' ? '#000000' : color)}" stroke-width="${width}"${dash}/>`);
      }
      if (value == null || value === '') continue;
      if (isCellPicture(value)) {
        pictures.push(`<image href="${esc(value.image)}" x="${px(x + 1)}" y="${px(y + 1)}" width="${px(Math.max(0, w - 2))}" height="${px(Math.max(0, h - 2))}" preserveAspectRatio="${cellPictureAspect(st, value.fit)}"${value.alt ? ` aria-label="${esc(value.alt)}"` : ''}/>`);
        continue;
      }
      if (typeof value === 'object' && !isError(value)) continue; // a sparkline or another drawing the picture leaves out
      let text = formatValue(value, st);
      if (value === 0 && sheet.zeros === false) text = '';
      if (!text) continue;
      const size = st.size || DEFAULT_SIZE;
      const align = st.align || defaultAlign(value);
      const lineList = String(text).split('\n');
      const pad = 3 + (st.indent || 0) * 9;
      const anchor = align === 'center' || align === 'centerContinuous' ? 'middle' : align === 'right' ? 'end' : 'start';
      const tx = anchor === 'middle' ? x + w / 2 : anchor === 'end' ? x + w - pad : x + pad;
      const lineHeight = size * 1.2, block = lineHeight * lineList.length;
      const top = st.valign === 'top' ? y + 2 : st.valign === 'bottom' ? y + h - block - 2 : y + (h - block) / 2;
      const sectionColor = !cf?.color && st.fmt === 'custom' && st.code ? codeColor(value, st.code, wb.colorPalette) : null;
      const color = isError(value) ? '#c00000' : fontColorCss(cf?.color) || sectionColor || fontColorCss(st.color) || '#000000';
      const decoration = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
      const attrs = [`font-family="${esc(fontStack(st.font) || fontFamily)}"`, `font-size="${px(size)}"`, `fill="${esc(color === 'windowtext' ? '#000000' : color)}"`,
        `text-anchor="${anchor}"`, (st.bold || cf?.bold) && 'font-weight="bold"', (st.italic || cf?.italic) && 'font-style="italic"', decoration && `text-decoration="${decoration}"`]
        .filter(Boolean).join(' ');
      // Text stays within its cell, or for left- and right-aligned text that has room, runs on as the sheet lets it.
      const clip = clipFor(x, y, w, h);
      const tspans = lineList.map((line, i) => `<tspan x="${px(tx)}" y="${px(top + lineHeight * (i + 0.8))}">${esc(line)}</tspan>`).join('');
      texts.push(`<text ${attrs} clip-path="url(#${clip})" xml:space="preserve">${tspans}</text>`);
    }
  }
  const back = background ? `<rect width="${px(W)}" height="${px(H)}" fill="${esc(background)}"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px(W)}" height="${px(H)}" viewBox="0 0 ${px(W)} ${px(H)}" preserveAspectRatio="none">`
    + (clips.length ? `<defs>${clips.join('')}</defs>` : '') + back + fills.join('') + pictures.join('') + texts.join('') + lines.join('') + '</svg>';
  return { svg, w: W, h: H };
}

/** An SVG picture as a data URL a picture object can hold (`src`). */
export function svgDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** The text a linked picture shows in the formula bar: =Sheet1!$A$1:$C$5. */
export const linkedPictureFormula = (obj) => (obj?.pictureRef ? `=${obj.pictureRef}` : '');
