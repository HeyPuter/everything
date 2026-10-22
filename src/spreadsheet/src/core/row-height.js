import { conditionalFontStyle, conditionalNumberFormat } from './style-values.js';
import { normalIndentUnit } from './normal-font.js';
import { cellKey } from './cell.js';
import { formatValue, fontStack, indentWidth } from './format.js';
import { wrapLines, heightForLines, rowPad, cellLayoutText, cellHorizontalPadding } from './textfit.js';
import { numberFormatParts, measureFormatParts, wrappedFormatLineCount, wrappedRichFormatLines } from './format-layout.js';
import { richTextMeasure, largestRichTextSize } from './rich-text-font.js';

function* rowNumbers(first, last) { for (let r = first; r <= last; r++) yield r; }

/** The cells of rows r1..r2 as [r, c, cell]: looked up by coordinate when that beats walking every cell of the sheet. */
function cellsInRows(s, r1, r2, onlyRows = null) {
  const out = [];
  if ((onlyRows?.size ?? (r2 - r1 + 1)) * s.cols < s.cells.size) {
    for (const r of onlyRows || rowNumbers(r1, r2)) for (let c = 0; c < s.cols; c++) { const cell = s.cells.get(cellKey(r, c)); if (cell) out.push([r, c, cell]); }
    return out;
  }
  for (const [key, cell] of s.cells) {
    const comma = key.indexOf(',');
    const r = Number(key.slice(0, comma));
    if (r >= r1 && r <= r2 && (!onlyRows || onlyRows.has(r))) out.push([r, Number(key.slice(comma + 1)), cell]);
  }
  return out;
}

/**
 * The heights rows r1..r2 need for their wrapped text: every wrapped cell in a row is measured at
 * the column widths `widthOf` gives (the workbook's, unless told otherwise) and the tallest wins.
 * Rows without wrapped text get no height unless `force` (row menu) asks for a fit of every row.
 * Nothing is written here: the reads come before the writes, so a step's writes do not drop the
 * workbook's caches between one row's measurement and the next.
 */
export function measureRows(wb, sheetId, r1, r2, { force = false, widthOf = (c) => wb.colWidth(sheetId, c), onlyRows = null, automatic = false,
  baseFontSize = 13, cellFont = '13px system-ui', textWidth, styleAt = null, mergeAt = (r, c) => wb.mergeAt(sheetId, r, c) } = {}) {
  const s = wb.sheet(sheetId);
  const heights = new Map();
  if (!s) return heights;
  let indentUnit;
  const customTables = s.tables.some(t => t.customStyle);
  styleAt ??= (sheet, r, c) => customTables
    ? { ...wb._tableStyleAt(sheet, r, c), ...wb.styleAt(sheet.id, r, c) } : wb.styleAt(sheet.id, r, c);
  const hidden = (r) => s.hiddenRows.has(r) || s.filterHidden.has(r);
  // A row the app fits is never shorter than the sheet's default row.
  // Automatic rows from a file (no customHeight) fit their content, even below that default.
  const floor = automatic ? 0 : s.defaultRowHeight;
  const pad = rowPad(s.defaultRowHeight, wb.normalStyle?.size || baseFontSize);
  if (force) {
    // The sheet default is a fallback for rows without measurable cells,
    // not a minimum: native automatic rows can be shorter than that default.
    const height = floor;
    for (const r of onlyRows || rowNumbers(r1, r2)) {
      if (hidden(r)) continue;
      if (automatic || wb.rowHeight(sheetId, r) !== height) heights.set(r, height);
    }
  }
  for (const [r, c, cell] of cellsInRows(s, r1, r2, onlyRows)) {
    if (hidden(r)) continue;
    // Merged cells are excluded from automatic sizing, including their font
    // size. Other cells can grow the row; otherwise it uses the default height.
    // A cached height is not a minimum (confirmed by native Excel round trips).
    if (automatic && mergeAt(r, c)) continue;
    if (cell.v == null && cell.f == null) {
      // An empty cell in a font larger than the row's default still grows its row, as Excel's do: 28 point set
      // on a blank cell makes room for what will be typed there. A blank never makes a row shorter than its default.
      if (!force || mergeAt(r, c)) continue;
      const need = heightForLines(1, styleAt(s, r, c)?.size || baseFontSize, floor, pad);
      if (need > s.defaultRowHeight) heights.set(r, Math.max(heights.get(r) || 0, need));
      continue;
    }
    const value = wb.getValue(sheetId, r, c);
    const cf = wb.conditionalStyle(sheetId, r, c, value), st = conditionalNumberFormat(conditionalFontStyle(styleAt(s, r, c), cf), cf);
    const size = st?.size || baseFontSize;
    const bold = st?.bold;
    const font = `${st?.italic ? 'italic ' : ''}${bold ? '600 ' : ''}${size}px ${fontStack(st?.font) || cellFont.replace(/^[\d.]+px\s*/, '')}`;
    const text = cellLayoutText(formatValue(value, st), st?.wrap);
    const parts = numberFormatParts(value, st, cell.richText);
    const measurePart = richTextMeasure(font, textWidth);
    const rich = parts?.some(part => part.rich);
    const largestSize = largestRichTextSize(parts, size);
    let richLines = null;
    let lines = 1;
    if (st?.rot && text) {
      // Rotated text needs the height of its turned bounding box.
      const rad = (Math.abs(st.rot) * Math.PI) / 180;
      const width = parts ? measureFormatParts(parts, measurePart) : textWidth(text, font);
      const h = Math.ceil(width * Math.sin(rad) + largestSize * 1.3 * Math.cos(rad) + 10);
      heights.set(r, Math.max(heights.get(r) || 0, h, heightForLines(1, largestSize, floor, pad)));
      continue;
    }
    let m = null;
    if (st?.wrap) {
      m = mergeAt(r, c);
      // The widths come from the workbook, not the laid-out offsets: a column dragged and its rows
      // fitted in one step change width inside a transaction, whose layout event comes only at its end.
      const indent = st?.indent ? indentWidth(value, st, indentUnit ??= normalIndentUnit(wb.normalFont, textWidth)) : 0;
      let width = -cellHorizontalPadding(indent) - 1;
      for (let cc = m ? m.c1 : c, last = m ? Math.min(m.c2, s.cols - 1) : c; cc <= last; cc++) width += widthOf(cc);
      // A number never wraps: too wide, it shows ### on its one line.
      if (rich) richLines = wrappedRichFormatLines(parts, Math.max(20, width), measurePart, size);
      lines = richLines ? richLines.length : typeof value === 'number' ? 1 : parts ? wrappedFormatLineCount(parts, Math.max(20, width), measurePart) : wrapLines(text, Math.max(20, width), (t) => textWidth(t, font)).length;
    } else if (!force) continue;
    else { m = mergeAt(r, c); lines = text.split(/\r\n?|\n/).length; }
    const need = richLines ? Math.max(floor, richLines.reduce((height, line) => height + heightForLines(1, line.size), pad)) : heightForLines(lines, largestSize, floor, pad);
    if (m && m.r2 > m.r1) {
      // A merge spanning rows shows its text over all of their heights together, so only what is
      // still missing is asked of its first row, not the whole text's height on top of the others.
      const willBe = (rr) => heights.get(rr) ?? wb.rowHeight(sheetId, rr);
      let block = 0;
      for (let rr = m.r1; rr <= m.r2; rr++) block += willBe(rr);
      if (need > block) heights.set(r, willBe(r) + need - block);
      continue;
    }
    heights.set(r, Math.max(heights.get(r) || 0, need));
  }
  if (automatic) for (const [r, height] of heights) if (!height) heights.set(r, s.defaultRowHeight);
  return heights;
}
