/**
 * Page Break Preview: where each printed page of a sheet begins and ends, from the sheet's page setup
 * (paper, orientation, margins, scale or fit to pages), its print area or used range, its manual page
 * breaks and the sizes of its rows and columns, laid out as the print path lays them out (printBands).
 */
import { PRINT_DEFAULTS, sheetPrintPrefs, printableWidth, printableHeight, manualBreaksApply } from './print.js';
import { printBands } from './print-pagination.js';

/**
 * { area, rows: [[r1, r2]...], cols: [[c1, c2]...], order, rowBreaks, colBreaks } for a sheet, or null when
 * there is nothing to print. rowBreaks and colBreaks list where each page after the first starts along the
 * axis, { at, manual }: a manual break is one the sheet keeps, an automatic one where the paper ran out.
 */
export function pageBreaks(wb, sheetId) {
  const sheet = wb.sheet(sheetId);
  if (!sheet || sheet.kind === 'chart') return null;
  const prefs = { ...PRINT_DEFAULTS, ...sheetPrintPrefs(sheet) };
  const area = sheet.printSettings?.areas?.[0] || wb.usedRange(sheetId);
  if (!area) return null;
  const rowSizes = [], colSizes = [];
  for (let r = area.r1; r <= area.r2; r++) rowSizes.push(sheet.hiddenRows.has(r) || sheet.filterHidden.has(r) ? 0 : wb.rowHeight(sheetId, r));
  for (let c = area.c1; c <= area.c2; c++) colSizes.push(sheet.hiddenCols.has(c) ? 0 : wb.colWidth(sheetId, c));
  const width = printableWidth(prefs), height = printableHeight(prefs);
  const totalW = colSizes.reduce((a, b) => a + b, 0), totalH = rowSizes.reduce((a, b) => a + b, 0);
  // The print scale: a fixed percentage, actual size, or the largest that fits the pages asked for.
  let scale = 1;
  if (prefs.fit === 'scale') scale = (Number(prefs.scale) || 100) / 100;
  else if (prefs.fit === 'width') scale = Math.min(1, width / Math.max(1, totalW));
  else if (prefs.fit === 'pages') {
    const w = Number(prefs.fitWidth) > 0 ? (width * prefs.fitWidth) / Math.max(1, totalW) : Infinity;
    const h = Number(prefs.fitHeight) > 0 ? (height * prefs.fitHeight) / Math.max(1, totalH) : Infinity;
    scale = Math.min(1, w, h);
  }
  scale = Math.max(0.1, scale);
  const apply = manualBreaksApply(prefs);
  // The manual breaks inside the printed block, as offsets into it; one at its first line starts nothing.
  const forced = (list, from, to, on) => new Set(on ? (list || []).filter(at => at > from && at <= to).map(at => at - from) : []);
  const axis = (sizes, capacity, from, manual) => {
    const bands = (printBands(sizes, capacity, 0, manual)?.bands || [{ start: 0, end: sizes.length }]).filter((b) => b.end > b.start);
    return { spans: bands.map((b) => [from + b.start, from + b.end - 1]), breaks: bands.slice(1).map((b) => ({ at: from + b.start, manual: manual.has(b.start) })) };
  };
  const rows = axis(rowSizes, height / scale, area.r1, forced(prefs.rowBreaks, area.r1, area.r2, apply.rows));
  const cols = axis(colSizes, width / scale, area.c1, forced(prefs.colBreaks, area.c1, area.c2, apply.cols));
  return { area: { ...area }, rows: rows.spans, cols: cols.spans, order: prefs.pageOrder || 'downThenOver', rowBreaks: rows.breaks, colBreaks: cols.breaks };
}

/** The pages in print order, each { r1, c1, r2, c2, n }. */
export function pagesOf(breaks) {
  if (!breaks) return [];
  const out = [];
  let n = 1;
  if (breaks.order === 'overThenDown') {
    for (const [r1, r2] of breaks.rows) for (const [c1, c2] of breaks.cols) out.push({ r1, r2, c1, c2, n: n++ });
  } else {
    for (const [c1, c2] of breaks.cols) for (const [r1, r2] of breaks.rows) out.push({ r1, r2, c1, c2, n: n++ });
  }
  return out;
}

/**
 * The breaks Insert Page Break leaves, given the sheet's current ones and the selection: whole rows put a
 * break above the active row, whole columns one left of the active column, and a cell both, above and to
 * the left of it (nothing on an axis where it sits on the first line).
 */
export function insertBreaks({ rowBreaks = [], colBreaks = [] } = {}, { active, wholeRows = false, wholeCols = false }) {
  const rows = new Set(rowBreaks), cols = new Set(colBreaks);
  if (!wholeCols && active.r > 0) rows.add(active.r);
  if (!wholeRows && active.c > 0) cols.add(active.c);
  return { rows: [...rows].sort((a, b) => a - b), cols: [...cols].sort((a, b) => a - b) };
}

/** The breaks Remove Page Break leaves: the manual break above the active row and the one left of its column, as the selection's kind allows. */
export function removeBreaks({ rowBreaks = [], colBreaks = [] } = {}, { active, wholeRows = false, wholeCols = false }) {
  return {
    rows: wholeCols ? [...rowBreaks] : rowBreaks.filter(at => at !== active.r),
    cols: wholeRows ? [...colBreaks] : colBreaks.filter(at => at !== active.c),
  };
}

/** Does Remove Page Break have a break to remove at this selection? */
export function hasBreakAt(settings, selection) {
  const next = removeBreaks(settings || {}, selection);
  return next.rows.length !== (settings?.rowBreaks || []).length || next.cols.length !== (settings?.colBreaks || []).length;
}

/**
 * Moving a break in Page Break Preview: a drag from `from` to `to` along `axis` (an automatic break, when
 * `manual` is false, becomes a manual one where it lands). A break dropped outside the printed block, or on
 * its first line, is removed.
 */
export function moveBreak(settings, area, { axis, from, to, manual }) {
  const key = axis === 'row' ? 'rowBreaks' : 'colBreaks';
  const lo = axis === 'row' ? area.r1 : area.c1, hi = axis === 'row' ? area.r2 : area.c2;
  const list = new Set(settings?.[key] || []);
  if (manual) list.delete(from);
  if (to > lo && to <= hi) list.add(to);
  return [...list].sort((a, b) => a - b);
}

/** Page Break Preview's print area after one of its edges is dragged to line `to` (the edge's own line, inclusive). */
export function moveAreaEdge(area, edge, to) {
  const next = { ...area };
  if (edge === 'top') next.r1 = Math.min(to, area.r2);
  else if (edge === 'bottom') next.r2 = Math.max(to, area.r1);
  else if (edge === 'left') next.c1 = Math.min(to, area.c2);
  else if (edge === 'right') next.c2 = Math.max(to, area.c1);
  return next;
}
