/**
 * Data ▸ Sort & Filter: Advanced (filter a list by a criteria range, in place or copied elsewhere,
 * optionally unique records only), Clear and Reapply.
 *
 * Criteria range: a header row naming list columns, then rows of conditions; the conditions of a
 * row must all hold, and any row may match. A condition is a comparison (">10", "<>West", "=Apple"
 * for an exact match) or text, which matches entries that begin with it (wildcards * and ? allowed).
 * A computed condition is a formula under a header that names no list column (or no header): it
 * is written for the first record and judged for each record as if copied down.
 */
import { criteriaMatcher } from './formula/functions.js';
import { sheetFilters } from './sheet-filters.js';

const headerKey = (v) => String(v ?? '').trim().toLowerCase();
const isError = (v) => v != null && typeof v === 'object' && 'error' in v;

/** A predicate for one criteria cell, judged as an advanced filter judges it. */
export function advancedMatcher(criterion) {
  if (criterion == null || criterion === '') return () => true;
  if (typeof criterion !== 'string') return criteriaMatcher(criterion);
  if (/^(<>|<=|>=|<|>|=)/.test(criterion)) return criteriaMatcher(criterion);
  // Plain text matches entries that begin with it.
  const starts = criteriaMatcher(`${criterion}*`);
  const exactNumber = criteriaMatcher(criterion);
  return (v) => (typeof v === 'string' ? starts(v) : exactNumber(v));
}

/** Rows (sheet row numbers) of the list's records that meet the criteria; or { error }. */
export function matchingRows(wb, sheetId, list, criteria) {
  const values = wb.rangeValues(sheetId, list);
  const headers = values[0].map(headerKey);
  const records = values.slice(1);
  if (!criteria) return records.map((_, i) => list.r1 + 1 + i);
  const crit = wb.rangeValues(criteria.sheetId ?? sheetId, criteria.range);
  if (crit.length < 2) return { error: 'The criteria range needs a header row and at least one row of conditions' };
  const critSheet = criteria.sheetId ?? sheetId;
  const tests = [];
  for (let i = 1; i < crit.length; i++) {
    const row = [];
    for (let j = 0; j < crit[0].length; j++) {
      const r = criteria.range.r1 + i, c = criteria.range.c1 + j;
      const cell = wb.getCell(critSheet, r, c);
      const at = headers.indexOf(headerKey(crit[0][j]));
      if (cell?.f != null && at < 0) {
        // Computed criteria: the formula as written judges the first record; others shift with it.
        const formula = `=${cell.f}`;
        row.push({ computed: (sheetRow) => {
          const v = wb.evalRuleFormula(sheetId, formula, { r1: list.r1 + 1, c1: list.c1, r2: list.r1 + 1, c2: list.c1 }, sheetRow, list.c1);
          return v === true || (typeof v === 'number' && v !== 0);
        } });
        continue;
      }
      const v = crit[i][j];
      if (v == null || v === '') continue;
      if (at < 0) return { error: `The criteria header "${crit[0][j] ?? ''}" names no column of the list` };
      row.push({ at, match: advancedMatcher(v) });
    }
    tests.push(row);
  }
  // A criteria row left wholly blank matches every record.
  const out = [];
  records.forEach((rec, i) => {
    const sheetRow = list.r1 + 1 + i;
    if (tests.some((row) => row.every((t) => (t.computed ? t.computed(sheetRow) : t.match(isError(rec[t.at]) ? rec[t.at] : rec[t.at] ?? null))))) out.push(sheetRow);
  });
  return out;
}

/** Keep the first of rows whose `columns` (sheet column numbers) hold the same values. */
function uniqueRows(wb, sheetId, rows, columns) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = JSON.stringify(columns.map((c) => {
      const v = wb.getValue(sheetId, r, c);
      return typeof v === 'string' ? v.toLowerCase() : v && typeof v === 'object' ? v.error : v;
    }));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Run an advanced filter. options: { list, criteria: { sheetId, range } | null, copyTo: { sheetId, range } | null, unique }.
 * In place it hides the records that do not match (one undo step); copying writes the header and the
 * matching records at copyTo (only the columns its headers name, when it has headers). Returns
 * { shown, hidden } or { copied } or { error }.
 */
export function advancedFilter(wb, sheetId, { list, criteria = null, copyTo = null, unique = false }) {
  if (!list || list.r2 <= list.r1) return { error: 'The list range needs a header row and at least one record' };
  let rows = matchingRows(wb, sheetId, list, criteria);
  if (rows.error) return rows;
  const allColumns = []; for (let c = list.c1; c <= list.c2; c++) allColumns.push(c);
  if (!copyTo) {
    if (unique) rows = uniqueRows(wb, sheetId, rows, allColumns);
    const keep = new Set(rows);
    const hide = [], show = [];
    for (let r = list.r1 + 1; r <= list.r2; r++) (keep.has(r) ? show : hide).push(r);
    wb.transaction('Advanced filter', () => {
      wb.setHidden(sheetId, 'row', show, false);
      if (hide.length) wb.setHidden(sheetId, 'row', hide, true);
      // Kept on the sheet, where its ranges follow inserted, deleted and moved rows, for Clear and Reapply.
      const own = !criteria || (criteria.sheetId ?? sheetId) === sheetId;
      wb.setAdvancedFilterState(sheetId, { list, criteria: criteria && { sheetId: own ? null : criteria.sheetId, range: criteria.range }, unique });
    });
    return { shown: show.length, hidden: hide.length };
  }
  const dest = copyTo.sheetId ?? sheetId;
  const headers = wb.rangeValues(sheetId, { ...list, r2: list.r1 })[0];
  // A destination whose first row names list columns takes only those columns, in its order.
  const destHeaders = wb.rangeValues(dest, { r1: copyTo.range.r1, c1: copyTo.range.c1, r2: copyTo.range.r1, c2: copyTo.range.c2 })[0];
  const named = destHeaders.map((h) => headers.findIndex((x) => headerKey(x) === headerKey(h) && headerKey(h)));
  const columns = copyTo.range.c2 > copyTo.range.c1 || named[0] >= 0 ? named.filter((i) => i >= 0).map((i) => list.c1 + i) : allColumns;
  if (!columns.length) return { error: 'The copy-to range must name columns of the list, or be a single cell' };
  if (unique) rows = uniqueRows(wb, sheetId, rows, columns);
  // A one-row destination is filled as far down as the records go; a taller one is the limit.
  const limit = copyTo.range.r2 > copyTo.range.r1 ? copyTo.range.r2 - copyTo.range.r1 : Infinity;
  if (rows.length > limit) return { error: 'The copy-to range is too small for the records that match' };
  const entries = [];
  const copyCell = (fromRow, c, toRow, toCol) => {
    const cell = wb.getCell(sheetId, fromRow, c);
    const v = wb.getValue(sheetId, fromRow, c);
    // An error stays an error (a cell holds one as { error }), not the text it shows.
    entries.push({ r: toRow, c: toCol, cell: v == null && !cell?.s ? null : { v: isError(v) ? { error: v.error } : v && typeof v === 'object' ? null : v, f: null, ...(cell?.s ? { s: cell.s } : {}) } });
  };
  columns.forEach((c, k) => copyCell(list.r1, c, copyTo.range.r1, copyTo.range.c1 + k));
  rows.forEach((r, i) => columns.forEach((c, k) => copyCell(r, c, copyTo.range.r1 + 1 + i, copyTo.range.c1 + k)));
  // Earlier results below (from a previous run) are cleared, as far as the old block went.
  const prev = wb.rangeValues(dest, { r1: copyTo.range.r1 + 1 + rows.length, c1: copyTo.range.c1, r2: Math.min(copyTo.range.r1 + 1 + rows.length + 2000, wb.sheet(dest).rows - 1), c2: copyTo.range.c1 + columns.length - 1 });
  for (let i = 0; i < prev.length; i++) {
    if (!prev[i].some((v) => v != null && v !== '')) break;
    for (let k = 0; k < columns.length; k++) entries.push({ r: copyTo.range.r1 + 1 + rows.length + i, c: copyTo.range.c1 + k, cell: null });
  }
  wb.setCells(dest, entries, 'Advanced filter');
  return { copied: rows.length, columns: columns.length };
}

/** Data ▸ Clear: every filter on the sheet shows all its rows again (criteria cleared, buttons kept). */
export function clearSheetFilters(wb, sheetId) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return false;
  let changed = false;
  wb.transaction('Clear filter', () => {
    for (const f of sheetFilters(sheet)) {
      if (!Object.keys(f.criteria || {}).length) continue;
      wb._setFilter(sheet, { ...f, criteria: {} }, 'Clear filter', { target: f });
      changed = true;
    }
    // The advanced filter run in place shows every record of its list again, wherever the list has moved to.
    const last = sheet.advancedFilter;
    if (last) {
      const hidden = [...sheet.hiddenRows].filter((r) => r > last.list.r1 && r <= last.list.r2);
      if (hidden.length) wb.setHidden(sheetId, 'row', hidden, false);
      wb.setAdvancedFilterState(sheetId, null, 'Clear filter');
      changed = true;
    }
  });
  return changed;
}

/** Whether Clear has anything to clear on the sheet. */
export function sheetHasFiltering(wb, sheetId) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return false;
  return sheetFilters(sheet).some((f) => Object.keys(f.criteria || {}).length) || !!sheet.advancedFilter;
}

/** Data ▸ Reapply: the filters judge the rows again (after edits), and so does the last advanced filter in place. */
export function reapplySheetFilters(wb, sheetId) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return false;
  const last = sheet.advancedFilter;
  if (sheetFilters(sheet).length) wb.reapplyFilter(sheetId);
  // Criteria on a sheet since deleted, or in rows since deleted, can no longer be read: that filter is left as it is.
  const criteria = last?.criteria && { sheetId: last.criteria.sheetId ?? sheetId, range: last.criteria.range };
  const readable = last && last.criteria !== false && (!criteria || wb.sheet(criteria.sheetId));
  if (readable) advancedFilter(wb, sheetId, { list: last.list, criteria, unique: last.unique });
  return !!(sheetFilters(sheet).length || readable);
}
