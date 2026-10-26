import { tableBorderWidth, tableHorizontalInsets } from './table-border-layout.js';
import { bodySymbolStyle } from './body-symbols.js';
import { inlineDisplayText } from './inline-display-text.js';
import { effectiveCellBorders } from './cell-borders.js';
import { textFontStyle } from './font-families.js';
import { kerningEnabled } from './kerning.js';
import { runFormat, paragraphText, paragraphFormat } from './model.js';
import { markerGeometry } from './list-layout.js';
import { OBJECT, inlineSegments, EMU_PER_PX, drawingOffsetPixels, imageExtents, isPositionedImage } from './images.js';
import { isCellRelativePosition, isPageBasedCellPosition } from './positioned-images.js';
import { rowGrid, minimumSpanWidth, fixedColumnWidths } from './tables.js';
import { dictionaryBreaks } from './dictionary-breaks.js';

// The same break opportunities drive both wrapping and intrinsic cell widths.
// Breaks are permitted after authored ASCII hyphens, including numeric/leading
// ones. U+2010/U+2011 and minus signs do not share this opportunity. Nonbreaking
// spaces stay within a word; forced grapheme wrapping remains possible.
// Floating anchors have zero text width and do not split the surrounding word.
// `wordBreak` marks the end of a Thai, Lao, Khmer or Myanmar word, or a break beside an ideograph or kana (dictionary-breaks.js).
export const breakAfter = (text, image, noBreakHyphen = false, wordBreak = false) => wordBreak || text === OBJECT && !isPositionedImage(image) || text === '\u00ad' || text === '-' && !noBreakHyphen || /\s/u.test(text) && !/[\u00a0\u202f\u2007]/u.test(text);
const shapeKey = style => `${(style.fontFamily || style.fontAscii || '').toLowerCase()}/${style.capitalization}/${style.bold}/${style.italic}/${style.fontSize}/${style.verticalAlign}/${style.baselineShift}/${style.characterSpacing}/${style.textScale}/${kerningEnabled(style)}`;
function withoutTrailingSpaces(chars, page) {
  if (page.wrapTrailSpaces) return chars;
  let end = chars.length;
  while (end && [' ', '\u00ad'].includes(chars[end - 1].text)) end--;
  return chars.slice(0, end);
}

/** Measure complete shaping groups, without constructing every growing prefix. */
function spanWidth(chars, measure) {
  let width = 0, group = '', style, key;
  const flush = () => { if (group) width += measure(group, style).width; group = ''; };
  for (const c of chars) {
    if (c.image) { flush(); if (!isPositionedImage(c.image)) width += imageExtents(c.image).width / EMU_PER_PX; key = null; continue; }
    const next = shapeKey(c.style);
    if (next !== key) { flush(); key = next; style = c.style; }
    group += c.text === '\u00ad' ? '' : c.text;
  }
  flush(); return width;
}

// Exclude a hanging space's advance, retaining kerning against the last glyph.
function contentSpanWidth(chars, measure, page) {
  const visible = withoutTrailingSpaces(chars, page), next = chars[visible.length], last = visible.at(-1);
  if (next?.text === ' ' && last && !last.image && !next.image && kerningEnabled(next.style) && shapeKey(last.style) === shapeKey(next.style)) {
    return spanWidth([...visible, next], measure) - measure(' ', next.style).width;
  }
  return spanWidth(visible, measure);
}

function decimalOffset(field, measure) {
  const dot = field.findIndex(c => c.text === '.'); let numberEnd = -1;
  for (let n = 0; n < field.length; n++) {
    if (/^[0-9]$/.test(field[n].text)) numberEnd = n + 1;
    else if (numberEnd >= 0 && field[n].text !== ',') break;
  }
  return spanWidth(field.slice(0, dot >= 0 ? dot : numberEnd >= 0 ? numberEnd : field.length), measure);
}

function unwrappedWidth(chars, left, format, page, measure, minimum) {
  const fields = [[]];
  for (const c of chars) { if (c.text === '\t') fields.push([]); else fields.at(-1).push(c); }
  let end = left;
  const tabs = format.tabs.filter(t => !t.numberingOnly && t.alignment !== 'bar');
  const automaticDecimal = tabs.length === 1 && tabs[0].alignment === 'decimal';
  if (format.firstLine < 0 && !page.noTabHangInd && !tabs.some(t => t.position === format.indentLeft)) tabs.push({ position: format.indentLeft, alignment: 'left' });
  tabs.sort((a,b) => a.position - b.position);
  // Tab advances contribute to the first wrap chunk of the following field.
  // Legacy compatibility measures these advances from zero and includes the left indent
  // as an implicit stop; mode 15 starts at the real first-line position.
  // This is intrinsic sizing only: normal paragraph tab placement is unchanged.
  const legacyMinimum = (page.compatibilityMode ?? 12) < 15;
  const minimumTabs = minimum && [...(legacyMinimum ? format.tabs.filter(t => !t.numberingOnly && t.alignment !== 'bar') : tabs)];
  if (minimumTabs && legacyMinimum && format.indentLeft > 0 && !minimumTabs.some(t => t.position === format.indentLeft)) minimumTabs.push({position:format.indentLeft, alignment:'left'});
  minimumTabs?.sort((a,b) => a.position - b.position);
  let minimumEnd = 0;
  fields.forEach((field, i) => {
    const width = spanWidth(field, measure);
    const trailing = i === fields.length - 1 ? width - contentSpanWidth(field, measure, page) : 0;
    if (!i) { end += width - trailing; minimumEnd = width + (legacyMinimum ? 0 : left - page.left); return; }
    const relative = (end - page.left) * 15, custom = tabs.find(t => t.position > relative + 1e-6), interval = page.defaultTabStop ?? 720;
    const target = page.left + (custom?.position ?? (Math.floor((relative + 1e-6) / interval) + 1) * interval) / 15;
    let offset = 0;
    if (custom?.alignment === 'center') offset = width / 2;
    if (custom?.alignment === 'right') offset = width;
    if (custom?.alignment === 'decimal') offset = decimalOffset(field, measure);
    end = Math.max(end, target - offset) + width - trailing;
    if (minimum) {
      const relative = minimumEnd * 15;
      // A sole decimal stop belongs to the automatic initial cell field.
      // With multiple authored stops, decimal stops are ordinary explicit
      // destinations and contribute their aligned first wrap chunk.
      const stop = minimumTabs.find(t => (!automaticDecimal || t.alignment !== 'decimal') && t.position > relative + 1e-6);
      const defaultFrom = Math.max(relative, minimumTabs.at(-1)?.position ?? relative);
      const target = (stop?.position ?? (Math.floor((defaultFrom + 1e-6) / interval) + 1) * interval) / 15;
      const aligned = stop?.alignment === 'right' ? width : stop?.alignment === 'center' ? width / 2 : stop?.alignment === 'decimal' ? custom?.alignment === 'decimal' ? offset : decimalOffset(field, measure) : 0;
      const advance = Math.max(0, target - aligned - minimumEnd);
      const breakIndex = field.findIndex(c => breakAfter(c.text, c.image, c.noBreakHyphen, c.wordBreak));
      const chunkWidth = breakIndex < 0 ? width
        : breakIndex === field.length - 1 && i === fields.length - 1 ? width - trailing
        : contentSpanWidth(field.slice(0, breakIndex + 1), measure, page);
      minimum.value = Math.max(minimum.value, advance + chunkWidth);
      minimumEnd += advance + width;
    }
  });
  return end;
}

/** Minimum is the widest wrap chunk; floor is the widest indivisible grapheme. */
export function cellIntrinsicWidths(cell, measure, page, numbering, markers, borders = cell.borders, autoFit = true) {
  const borderLeft = tableBorderWidth(borders?.left) / 2, borderRight = tableBorderWidth(borders?.right) / 2;
  const paddingLeft = Math.max(cell.margins.left / 15, borderLeft);
  // AutoFit compares the combined margins with the combined half-borders.
  // Taking the larger inset independently at each edge overstates demand
  // when one margin exceeds its border and the other does not.
  const paddingRight = Math.max((cell.margins.left + cell.margins.right) / 15, borderLeft + borderRight) - paddingLeft;
  // Six twips of writing space are reserved even for an empty cell,
  // independent of the paragraph-mark font and size (native paired controls).
  const writingMinimum = 6 / 15;
  let min = paddingLeft + paddingRight + writingMinimum, max = min, floor = min, paddingFloor = min;
  // Span allocation weights actual content, excluding the empty-cell
  // writing minimum retained for empty cells in ordinary width constraints.
  let contentMin = paddingLeft + paddingRight;
  const localPage = { ...page, width: 1e9, left: paddingLeft, right: paddingRight };
  for (const block of cell.content) {
    if (block.type === 'table') {
      const nested = tableIntrinsicWidths(block, measure, page, numbering, markers);
      min = Math.max(min, nested.min + paddingLeft + paddingRight);
      contentMin = Math.max(contentMin, nested.min + paddingLeft + paddingRight);
      max = Math.max(max, nested.max + paddingLeft + paddingRight);
      floor = Math.max(floor, nested.floor + paddingLeft + paddingRight);
      paddingFloor = Math.max(paddingFloor, nested.paddingFloor + paddingLeft + paddingRight);
      continue;
    }
    const { paragraph: p, index } = block;
    const text = paragraphText(p), format = paragraphFormat(p, numbering), chars = [];
    // An empty paragraph contributes the cell padding but no indentation to
    // the AutoFit demand. Keep spaces, breaks, tabs and visible list labels:
    // those are content even when no ordinary text glyph is painted.
    if (!text && !markers[index]?.text) continue;
    let runIndex = 0, runEnd = p.runs[0]?.text.length ?? 0;
    const wordBreaks = dictionaryBreaks(text);
    for (const part of inlineSegments(text)) {
      while (part.index >= runEnd && runIndex < p.runs.length - 1) runEnd += p.runs[++runIndex].text.length;
      // Inline page/column breaks have no visual or wrapping effect in cells.
      if (part.segment === '\f' || part.segment === '\u000e') continue;
      const run = p.runs[runIndex], text = inlineDisplayText(run, part.segment);
      chars.push({ text, ...(run?.noBreakHyphen ? { noBreakHyphen: true } : {}), ...(wordBreaks?.has(part.index + part.segment.length) ? { wordBreak: true } : {}), style: textFontStyle(text, bodySymbolStyle(run, runFormat(run))), image: run?.image });
    }
    const continuation = paddingLeft + format.indentLeft / 15;
    const initial = continuation + format.firstLine / 15;
    const first = markerGeometry(markers[index], runFormat(p.markFormat), initial, 1e9, format, localPage, measure, 0).left;
    const right = paddingRight + format.indentRight / 15;
    const minimumFirst = (page.compatibilityMode ?? 12) < 15 && chars[0]?.text === '\t' ? Math.min(first, continuation) : first;
    // Indentation can supply the writing reserve already included in padding;
    // do not add it again beyond the first/continuation indent.
    min = Math.max(min, minimumFirst + right, continuation + right);
    floor = Math.max(floor, minimumFirst + right, continuation + right);
    paddingFloor = Math.max(paddingFloor, minimumFirst + right, continuation + right);
    let line = [], chunk = [], firstLine = true, firstChunk = true, tabMinimum;
    const finishChunk = (discretionary = false) => {
      // A discretionary break contributes a visible hyphen only to the minimum.
      const visible = discretionary && chunk.at(-1)?.text === '\u00ad' ? [...chunk.slice(0,-1), { ...chunk.at(-1), text: '-' }] : chunk;
      const width = (firstChunk ? minimumFirst : continuation) + contentSpanWidth(visible, measure, page) + right;
      contentMin = Math.max(contentMin, width); min = Math.max(min, width);
      firstChunk = false; chunk = [];
    };
    const finishLine = () => {
      finishChunk(); max = Math.max(max, unwrappedWidth(line, firstLine ? first : continuation, format, localPage, measure, tabMinimum) + right);
      if (tabMinimum) {
        const indent = firstLine ? first : continuation;
        const width = ((page.compatibilityMode ?? 12) < 15 ? Math.min(indent, continuation) : indent) + tabMinimum.value + right;
        min = Math.max(min, width); contentMin = Math.max(contentMin, width);
      }
      tabMinimum = undefined;
      line = []; firstLine = false;
    };
    chars.forEach((c, i) => {
      if (isPositionedImage(c.image)) {
        if (isPageBasedCellPosition(c.image)) return;
        if (!isCellRelativePosition(c.image)) throw new Error('This drawing coordinate combination inside a table cell is not supported yet.');
        // Unwrapped floating drawings may extend beyond the cell. AutoFit does not
        // include their extent or offset in AutoFit's content width.
        if (c.image.anchor.wrap === 'none') return;
        const width = paddingLeft + Math.max(0, drawingOffsetPixels(c.image.anchor.x)) + imageExtents(c.image).width / EMU_PER_PX + paddingRight;
        min = Math.max(min, width); max = Math.max(max, width); floor = Math.max(floor, width);
        contentMin = Math.max(contentMin, width);
        return;
      }
      if (c.text === '\v' || c.text === '\f' || c.text === '\u000e') { finishLine(); return; }
      if (c.text !== '\t' && c.text !== '\u00ad' && (c.text !== ' ' || page.wrapTrailSpaces)) floor = Math.max(floor, (i === 0 ? first : continuation) + (c.image ? imageExtents(c.image).width / EMU_PER_PX : measure(c.text, c.style).width) + right);
      line.push(c);
      if (c.text === '\t') { tabMinimum ||= {value:0}; finishChunk(); }
      else { if (c.image && chunk.length) finishChunk(); chunk.push(c); if (breakAfter(c.text, c.image, c.noBreakHyphen, c.wordBreak)) finishChunk(c.text === '\u00ad' && i + 1 < chars.length && !['\v','\f','\u000e'].includes(chars[i + 1].text)); }
    });
    finishLine();
  }
  // noWrap affects AutoFit's preferred minimum, not final line breaking.
  // Fixed cell widths resist shrinking; automatic/percentage cells measure
  // each explicit line as one unbreakable span (§17.4.29).
  // Eight twips are reserved at each edge with no inset.
  // A margin or border supplies that space, regardless of its magnitude.
  const protectedPreference = autoFit && cell.noWrap && cell.width?.type === 'dxa';
  const allowance = (paddingLeft === 0 ? 8 : 0) + (Math.max(cell.margins.right / 15, borderRight) === 0 ? 8 : 0);
  if (autoFit && cell.noWrap) min = Math.max(min, protectedPreference ? (cell.width.value + allowance) / 15 : max);
  // Whole-twip AutoFit allocation must not round below its content minimum.
  min = Math.ceil(Math.max(min, floor) * 15 - 1e-6) / 15;
  // A protected preference is a minimum constraint, not measured content.
  // In particular, spreading it as a merged content maximum distorts columns.
  return { min, max: Math.max(max, protectedPreference ? 0 : min, floor), floor, paddingFloor, contentMin: Math.max(0, Math.ceil(contentMin * 15 - 1e-6) / 15) };
}

// A nested table contributes its complete grid, not the largest single cell.
// Spanning cells constrain the same grid-prefix graph used by AutoFit layout.
export function tableIntrinsicWidths(block, measure, page, numbering, markers) {
  const { table } = block, columns = table.grid.map(() => ({ min: 0, max: 0, floor: 0, paddingFloor: 0 })), spans = [], cellBorders = new Map();
  for (const [rowIndex, row] of block.rows.entries()) for (const { cell, column, span } of rowGrid(row)) {
    const borders = effectiveCellBorders(table, cell, rowIndex, column, span, cell.rowSpan || 1);
    cellBorders.set(cell.id, borders);
    if (!cell.rowSpan) continue;
    const metrics = cellIntrinsicWidths(cell, measure, page, numbering, markers, borders, table.layout === 'autofit');
    if (span > 1) spans.push({ column, span, ...metrics });
    else for (const key of ['min','max','floor','paddingFloor']) columns[column][key] = Math.max(columns[column][key], metrics[key]);
  }
  // The shared grid solver uses twips, including its one-twip column floor.
  const twipSpans = spans.map(s => ({ ...s, min: s.min * 15, max: s.max * 15, floor: s.floor * 15, paddingFloor: s.paddingFloor * 15 }));
  const total = key => minimumSpanWidth(columns.map(c => c[key] * 15), twipSpans, key) / 15;
  const horizontal = tableHorizontalInsets(block, cellBorders, page);
  const inset = Math.max(0, table.alignment === 'left' ? table.indent / 15 : 0) + horizontal.left + horizontal.right;
  let min = total('min'), max = total('max'), floor = total('floor');
  if (table.layout === 'fixed' && table.width?.type !== 'pct') {
    const width = fixedColumnWidths(table,(page.width-page.left-page.right)*15).reduce((a,b)=>a+b,0)/15;
    min = Math.max(min,width); max = Math.max(max,width); floor = Math.max(floor,width);
  } else if (table.width?.type === 'dxa') max = Math.max(max,table.width.value/15);
  return { min: min+inset, max: Math.max(max,min,floor)+inset, floor: floor+inset, paddingFloor: total('paddingFloor')+inset };
}
