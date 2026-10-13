// A sheet can have an ordinary AutoFilter and one independent AutoFilter
// per table. `filter` is the current editing context; the remaining contexts
// stay live in `otherFilters`. Changing context never clears their criteria.
export const sameFilterRange = (a, b) => !!a?.range && !!b?.range && ['r1', 'r2', 'c1', 'c2'].every(k => a.range[k] === b.range[k]);
export const filterRangeKey = f => f?.range && [f.range.r1, f.range.c1, f.range.r2, f.range.c2].join(',');
export const sheetFilters = sheet => sheet ? [sheet.filter, ...(Array.isArray(sheet.otherFilters) ? sheet.otherFilters : [])].filter(Boolean) : [];
export const filterTable = (sheet, filter) => filter && (sheet.tables || []).find(t => t.headerRow !== false &&
  t.range.r1 === filter.range.r1 && t.range.c1 === filter.range.c1 && t.range.c2 === filter.range.c2
  && t.range.r2 - Number(t.totalsRow) === filter.range.r2);
export const copyFilter = f => f ? { ...f, range: { ...f.range }, criteria: { ...f.criteria },
  ...(f.hiddenButtons ? { hiddenButtons: [...f.hiddenButtons] } : {}) } : null;

/** Apply a structural/reference transform to every context, retaining selection. */
export function mapSheetFilters(sheet, transform) {
  sheet.filter = sheet.filter ? transform(sheet.filter) : null;
  sheet.otherFilters = (sheet.otherFilters || []).map(transform).filter(Boolean);
  // A sheet's views (View ▸ Sheet View) and the default filters kept aside while someone is in one follow
  // the same edits, so each still filters the rows it did. Each is replaced, never changed in place.
  if (sheet.sheetViews?.length) sheet.sheetViews = sheet.sheetViews.map(v => ({ ...v, filter: v.filter ? transform(v.filter) : null,
    otherFilters: (v.otherFilters || []).map(transform).filter(Boolean) }));
  if (sheet.personalView) {
    const saved = sheet.personalView.saved;
    sheet.personalView = { ...sheet.personalView, saved: { filter: saved.filter ? transform(saved.filter) : null, otherFilters: (saved.otherFilters || []).map(transform).filter(Boolean) } };
  }
}

/** Value lists from .xlsx files ignore case; existing app lists retain exact matching unless requested. */
export const filterValueIdentity = (value, criterion) => criterion?.caseSensitive === false && typeof value === 'string' ? value.toLowerCase() : value;
