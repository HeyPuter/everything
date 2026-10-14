/**
 * Sheets as a PDF file, built here without the print dialog: what Send a Copy attaches when the copy is a PDF
 * (Print ▸ Save as PDF stays the way to lay pages out by hand). Each sheet (or one range of it) is laid on
 * pages of its print settings' paper and orientation, scaled down to fit the page width when that takes no
 * more than halving it and otherwise split over several pages across, down then over. Cells keep their
 * displayed text, alignment, bold and italic, text and fill colours, borders, merges and wrapped text; the
 * sheet's gridlines are drawn when its print settings ask for them. Charts and pictures are not drawn.
 *
 * The text uses the four standard sans-serif faces every PDF reader has (no font is embedded, so files stay
 * small), in the Windows-1252 character set: a character outside it is written as "?".
 */
import { cellKey } from './cell.js';
import { defaultAlign } from './format.js';
import { fontColorCss } from './font-color.js';
import { fillColorCss } from './fill-color.js';
import { normalizePrintSettings } from './print-settings.js';
import { MAX_ROW, MAX_COL } from './refs.js';

const PAPER = { 1: [612, 792], 3: [792, 1224], 5: [612, 1008], 8: [842, 1191], 9: [595, 842], 10: [595, 842] };
const MARGIN = 36; // points
const FOOTER = 18;
const PX = 0.75; // a CSS pixel in points
const DEFAULT_SIZE = 9.5 * 4 / 3; // the grid's default text size, in px

/* ---------- Text metrics: advance widths of the standard sans-serif faces, per 1000 units ---------- */

const REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** Windows-1252's characters at 0x80–0x9F, which differ from Latin-1's control codes. */
const CP1252 = new Map([[0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89],
  [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96],
  [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]]);

/** A character's byte in the PDF's text encoding; '?' for one it cannot carry. */
export function pdfByte(ch) {
  const code = ch.codePointAt(0);
  if (code === 0xa0) return 0x20;
  if ((code >= 0x20 && code < 0x7f) || (code >= 0xa1 && code <= 0xff)) return code;
  return CP1252.get(code) ?? 0x3f;
}

/** How wide `text` is at `size` points in the regular or bold face. */
export function textWidth(text, size, bold = false) {
  const table = bold ? BOLD : REGULAR;
  let units = 0;
  for (const ch of String(text)) {
    const b = pdfByte(ch);
    units += b >= 32 && b < 127 ? table[b - 32] : 556;
  }
  return (units * size) / 1000;
}

/** A PDF string literal for `text`: its bytes in the PDF's encoding, with the delimiters escaped. */
function pdfString(text) {
  let out = '(';
  for (const ch of String(text)) {
    const b = pdfByte(ch);
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

/** A text string for the document's information (its title): UTF-16 with a byte-order mark, as hex. */
function pdfTextString(text) {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

const num = (n) => (Math.round(n * 100) / 100).toString();

/** '#rrggbb' (or '#rgb') as PDF colour operands, or null. */
function rgb(css) {
  if (typeof css !== 'string') return null;
  let m = /^#([\da-f]{6})(?:[\da-f]{2})?$/i.exec(css.trim());
  if (!m) {
    const s = /^#([\da-f])([\da-f])([\da-f])$/i.exec(css.trim());
    if (!s) return null;
    m = [null, s[1] + s[1] + s[2] + s[2] + s[3] + s[3]];
  }
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => num(x / 255)).join(' ');
}

/** Split text into lines that fit `width` at `size`, at spaces where it can and mid-word where it must. */
export function wrapLines(text, width, size, bold) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    let lineText = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = lineText + word;
      if (!lineText || textWidth(next, size, bold) <= width) { lineText = next; continue; }
      out.push(lineText.trimEnd());
      lineText = /^\s+$/.test(word) ? '' : word;
      // A word longer than the line is broken where it meets the edge.
      while (lineText && textWidth(lineText, size, bold) > width && lineText.length > 1) {
        let cut = lineText.length - 1;
        while (cut > 1 && textWidth(lineText.slice(0, cut), size, bold) > width) cut--;
        out.push(lineText.slice(0, cut));
        lineText = lineText.slice(cut);
      }
    }
    out.push(lineText.trimEnd());
  }
  return out;
}

/* ---------- Layout ---------- */

/** Break line sizes into consecutive bands no larger than `capacity` (a line larger than it has a band of its own). */
export function bandsOf(sizes, capacity) {
  const bands = [];
  let start = 0, used = 0;
  sizes.forEach((size, i) => {
    if (i > start && used + size > capacity) { bands.push([start, i]); start = i; used = 0; }
    used += size;
  });
  if (sizes.length) bands.push([start, sizes.length]);
  return bands;
}

function pageSizeOf(settings) {
  const [w, h] = PAPER[settings?.paperSize] || PAPER[1];
  return settings?.orientation === 'landscape' ? [h, w] : [w, h];
}

/** The cells a sheet's PDF covers: the range asked for, or the print area, or the used range. */
function extentOf(wb, sheetId, range, settings) {
  const used = wb.usedRange(sheetId);
  if (range) {
    const r = { ...range };
    if (r.r2 >= MAX_ROW || r.c2 >= MAX_COL) {
      if (!used) return null;
      if (r.r2 >= MAX_ROW) r.r2 = Math.max(r.r1, used.r2);
      if (r.c2 >= MAX_COL) r.c2 = Math.max(r.c1, used.c2);
    }
    return r;
  }
  const area = settings?.areas?.[0];
  if (area) return area;
  return used ? { r1: 0, c1: 0, r2: used.r2, c2: used.c2 } : null;
}

const SIDES = [['bt', 'top'], ['bb', 'bottom'], ['bl', 'left'], ['br', 'right']];

/** One sheet (or range) as page descriptions: each a list of drawing operators and the page's size. */
function sheetPages(wb, sheetId, { range = null, title = '' } = {}) {
  const sheet = wb.sheet(sheetId);
  if (!sheet || sheet.kind === 'chart') return [];
  const settings = normalizePrintSettings(sheet.printSettings);
  const [pageW, pageH] = pageSizeOf(settings);
  const extent = extentOf(wb, sheetId, range, settings);
  const roomW = pageW - 2 * MARGIN, roomH = pageH - 2 * MARGIN - FOOTER;
  if (!extent) return [{ w: pageW, h: pageH, ops: [], footer: title }];
  const rows = [], cols = [];
  for (let r = extent.r1; r <= Math.min(extent.r2, sheet.rows - 1); r++) if (wb.rowHeight(sheetId, r) > 0) rows.push(r);
  for (let c = extent.c1; c <= Math.min(extent.c2, sheet.cols - 1); c++) if (wb.colWidth(sheetId, c) > 0) cols.push(c);
  if (!rows.length || !cols.length) return [{ w: pageW, h: pageH, ops: [], footer: title }];
  const colW = cols.map((c) => wb.colWidth(sheetId, c) * PX);
  const rowH = rows.map((r) => wb.rowHeight(sheetId, r) * PX);
  const totalW = colW.reduce((a, b) => a + b, 0);
  // Fit to the page width when that keeps text at half its size or more; wider sheets go over several pages.
  const scale = totalW > roomW ? Math.max(0.5, roomW / totalW) : 1;
  const colBands = bandsOf(colW.map((w) => w * scale), roomW);
  const rowBands = bandsOf(rowH.map((h) => h * scale), roomH);
  const colIndex = new Map(cols.map((c, i) => [c, i]));
  const rowIndex = new Map(rows.map((r, i) => [r, i]));
  const gridlines = !!settings?.gridlines;
  const merges = sheet.merges || [];
  const mergeAnchor = new Map();
  const covered = new Set();
  for (const m of merges) {
    mergeAnchor.set(cellKey(m.r1, m.c1), m);
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(cellKey(r, c));
  }
  const pages = [];
  for (const [cb0, cb1] of colBands) {
    for (const [rb0, rb1] of rowBands) {
      const ops = [];
      // Positions on the page, in points, from the band's top-left corner.
      const xs = [MARGIN];
      for (let i = cb0; i < cb1; i++) xs.push(xs.at(-1) + colW[i] * scale);
      const ys = [pageH - MARGIN];
      for (let i = rb0; i < rb1; i++) ys.push(ys.at(-1) - rowH[i] * scale);
      const x = (ci) => xs[Math.max(0, Math.min(ci - cb0, cb1 - cb0))];
      const y = (ri) => ys[Math.max(0, Math.min(ri - rb0, rb1 - rb0))];
      if (gridlines) {
        ops.push('q 0.8 0.8 0.8 RG 0.4 w');
        for (const gx of xs) ops.push(`${num(gx)} ${num(ys[0])} m ${num(gx)} ${num(ys.at(-1))} l S`);
        for (const gy of ys) ops.push(`${num(xs[0])} ${num(gy)} m ${num(xs.at(-1))} ${num(gy)} l S`);
        ops.push('Q');
      }
      const borders = [];
      for (let ri = rb0; ri < rb1; ri++) {
        const r = rows[ri];
        for (let ci = cb0; ci < cb1; ci++) {
          const c = cols[ci];
          const key = cellKey(r, c);
          if (covered.has(key)) continue;
          const m = mergeAnchor.get(key);
          // A merge reaches to its last visible line, clipped at the band's edge.
          const lastRow = m ? (rows.findLastIndex((rr) => rr <= m.r2) + 1) : ri + 1;
          const lastCol = m ? (cols.findLastIndex((cc) => cc <= m.c2) + 1) : ci + 1;
          const x0 = x(ci), x1 = x(lastCol), yTop = y(ri), yBot = y(lastRow);
          const w = x1 - x0, h = yTop - yBot;
          if (w <= 0 || h <= 0) continue;
          const st = wb.styleAt(sheetId, r, c) || {};
          const fill = rgb(fillColorCss(st.bg));
          if (fill) ops.push(`q ${fill} rg ${num(x0)} ${num(yBot)} ${num(w)} ${num(h)} re f Q`);
          for (const [side, edge] of SIDES) {
            if (!st[side]) continue;
            const pen = st[`${side}Border`] || st;
            const lw = (pen.bs === 'medium' ? 1.5 : pen.bs === 'thick' || pen.bs === 'double' ? 2.25 : 0.75) * scale;
            const color = rgb(fontColorCss(pen.bc)) || '0 0 0';
            const seg = edge === 'top' ? [x0, yTop, x1, yTop] : edge === 'bottom' ? [x0, yBot, x1, yBot] : edge === 'left' ? [x0, yTop, x0, yBot] : [x1, yTop, x1, yBot];
            borders.push(`q ${color} RG ${num(lw)} w ${seg.slice(0, 2).map(num).join(' ')} m ${seg.slice(2).map(num).join(' ')} l S Q`);
          }
          const value = wb.getValue(sheetId, r, c);
          const display = wb.getDisplay(sheetId, r, c, value);
          if (display === '' || display == null) continue;
          const bold = !!st.bold, italic = !!st.italic;
          const font = `/F${1 + (bold ? 1 : 0) + (italic ? 2 : 0)}`;
          const size = (Number(st.size) || DEFAULT_SIZE) * PX * scale;
          const pad = 2 * scale;
          const align = st.align === 'center' || st.align === 'right' || st.align === 'left' ? st.align : defaultAlign(value);
          const valign = st.valign || sheet.defaultVAlign || 'bottom';
          const lines = st.wrap ? wrapLines(display, Math.max(1, w - 2 * pad), size, bold) : [String(display).replace(/\r?\n/g, ' ')];
          const lead = size * 1.2;
          const block = lines.length * lead;
          const firstBase = valign === 'top' ? yTop - pad - size * 0.85
            : valign === 'middle' || valign === 'center' ? yBot + h / 2 + block / 2 - size * 0.95
              : yBot + pad + size * 0.25 + (lines.length - 1) * lead;
          const ink = rgb(fontColorCss(st.color)) || '0 0 0';
          // Text that does not fit is cut at the cell's edge; left-aligned text runs on into empty cells to its right.
          let clipRight = x1;
          if (!st.wrap && align === 'left' && !m) {
            for (let k = ci + 1; k < cb1; k++) {
              const cc = cols[k];
              if (wb.getDisplay(sheetId, r, cc) !== '' || covered.has(cellKey(r, cc)) || mergeAnchor.has(cellKey(r, cc))) break;
              clipRight = x(k + 1);
            }
          }
          ops.push(`q ${num(x0)} ${num(yBot)} ${num(clipRight - x0)} ${num(h)} re W n BT ${font} ${num(size)} Tf ${ink} rg`);
          lines.forEach((text, i) => {
            const tw = textWidth(text, size, bold);
            const tx = align === 'right' ? x1 - pad - tw : align === 'center' ? x0 + (w - tw) / 2 : x0 + pad;
            ops.push(`1 0 0 1 ${num(tx)} ${num(firstBase - i * lead)} Tm ${pdfString(text)} Tj`);
          });
          ops.push('ET Q');
        }
      }
      ops.push(...borders);
      pages.push({ w: pageW, h: pageH, ops, footer: title });
    }
  }
  return pages;
}

/* ---------- The file ---------- */

/**
 * A PDF of `parts` ([{ sheetId, range? }], in order) of the workbook. `title` names the document; each page's
 * footer names its sheet and number. Returns the file's bytes.
 */
export function sheetsToPdf(wb, parts, { title = 'Spreadsheet' } = {}) {
  const pages = [];
  for (const part of parts) {
    const sheet = wb.sheet(part.sheetId);
    if (!sheet) continue;
    pages.push(...sheetPages(wb, part.sheetId, { range: part.range || null, title: sheet.name }));
  }
  if (!pages.length) pages.push({ w: PAPER[1][0], h: PAPER[1][1], ops: [], footer: '' });
  const objects = []; // bodies, numbered from 1
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null), pagesObj = add(null);
  const fonts = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique']
    .map((name) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
  const resources = `<< /Font << ${fonts.map((id, i) => `/F${i + 1} ${id} 0 R`).join(' ')} >> >>`;
  const kids = [];
  pages.forEach((page, i) => {
    const footer = `${page.footer ? `${page.footer} · ` : ''}Page ${i + 1} of ${pages.length}`;
    const fsize = 8;
    const stream = [...page.ops,
      `BT /F1 ${fsize} Tf 0.45 0.45 0.45 rg 1 0 0 1 ${num((page.w - textWidth(footer, fsize)) / 2)} ${num(MARGIN - 4)} Tm ${pdfString(footer)} Tj ET`].join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(page.w)} ${num(page.h)}] /Resources ${resources} /Contents ${content} 0 R >>`));
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfTextString(String(title).slice(0, 200))} /Producer (Spreadsheet on Puter) >>`);
  // Every string above holds one byte per character (pdfString encodes text that way), so lengths are offsets.
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
