import { mapTableRefs, parseTableSpec, tableRows } from './tables.js';
import { mapFormulaRefs, quoteSheet, sheetKey, refToText } from './refs.js';
import { toFileFormula } from './xlfn.js';
import { normalizeExternalWorkbooks, rebaseExternalWorkbooks } from './external-workbooks.js';
import { t } from '../i18n/index.js';

/** Preserve both caller-row semantics and the omitted table's data bounds.
 * Plain A1 conversion would read unrelated cells after a paste or table growth. */
function boundedTableRows(wb, owner, formula, tables) {
  const included = new Set(tables.map(name => name.toLowerCase()));
  return mapTableRefs(formula, (name, spec) => {
    if (!name || !included.has(name.toLowerCase()) || parseTableSpec(spec)?.rows !== 'this') return null;
    const found = wb.tableByName(name), rows = tableRows(found.table);
    if (rows.empty) return '#VALUE!';
    const ref = wb.resolveTableRef(owner.id, rows.dataStart, found.table.range.c1, name, spec);
    if (ref.error) return ref.error;
    const range = refToText({ ...ref, kind: rows.dataStart === rows.dataEnd && ref.c1 === ref.c2 ? 'cell' : 'range',
      r1: rows.dataStart, r2: rows.dataEnd, absR1: true, absR2: true, absC1: true, absC2: true });
    return `IF(OR(ROW()<${rows.dataStart + 1},ROW()>${rows.dataEnd + 1}),#VALUE!,INDEX(${range},ROW()-${rows.dataStart},0))`;
  });
}

function requireLocation(location) {
  if (typeof location === 'string' && location.trim()) return;
  const error = new Error(t('externalWorkbookSheetCopy.saveSourceFirst'));
  error.code = 'EXTERNAL_SOURCE_LOCATION_REQUIRED';
  throw error;
}

/** Keep local calculations live while references to omitted sheets read native
 * supporting-cell caches. Cache the values of each referenced source sheet:
 * OFFSET and reference operators may read beyond the formula's written range,
 * including after an input in the copied sheet changes. */
export function externalWorkbookSheetCopy(wb, selected, { sourceWorkbook = null } = {}) {
  for (const book of wb.externalWorkbooks?.books || []) {
    if (book.kind === 'dde') continue;
    if ([book.target, ...(book.relationships || []).map(r => r.target)].some(target => !/^(?:[a-z][\w+.-]*:|\/)/i.test(target))) requireLocation(sourceWorkbook);
  }
  const books = [...(rebaseExternalWorkbooks(wb.externalWorkbooks, sourceWorkbook)?.books || [])];
  const sources = new Set(), index = books.length + 1;
  let includeNames = false;
  const omittedTables = wb.sheets.filter(s => s.id !== selected.id).flatMap(s => s.tables.map(table => table.name));
  const rewrite = (formula, position = { r: 0, c: 0 }) => {
    formula = boundedTableRows(wb, selected, formula, omittedTables);
    for (const table of omittedTables) formula = wb.structuredToA1(selected.id, position.r, position.c, formula, table, true, { relativeRows: !!position.relativeRows });
    return mapFormulaRefs(formula, ref => {
      if (!ref.sheet || ref.sheet.startsWith('[')) return ref;
      if (ref.sheetEnd) {
        const span = wb.sheetsBetween(ref.sheet, ref.sheetEnd);
        if (!span || span.every(name => sheetKey(name) === sheetKey(selected.name))) return ref;
        requireLocation(sourceWorkbook);
        // The span remains a span in its original workbook; do not turn it
        // into a union or truncate it to the one local sheet being copied.
        for (const name of span) sources.add(wb.sheetByName(name));
        return { ...ref, sheet: `[${index}]${ref.sheet}` };
      }
      if (sheetKey(ref.sheet) === sheetKey(selected.name)) return ref;
      const source = wb.sheetByName(ref.sheet);
      if (!source) return ref;
      requireLocation(sourceWorkbook);
      sources.add(source);
      return { ...ref, sheet: `[${index}]${source.name}` };
    }, token => {
      if (token.sheet.startsWith('[') || sheetKey(token.sheet) === sheetKey(selected.name)) return null;
      const source = wb.sheetByName(token.sheet);
      if (!source || !wb.namedEntry(token.value, source.name)) return null;
      requireLocation(sourceWorkbook);
      // Names can call other names and resolve references dynamically. Keep
      // their original namespace and the supporting cells it can address.
      includeNames = true;
      for (const sheet of wb.sheets) sources.add(sheet);
      return `${quoteSheet(`[${index}]${source.name}`)}!${token.value}`;
    });
  };
  const finish = () => {
    if (sources.size) {
      const sheets = [];
      let count = 0;
      for (const source of wb.sheets.filter(sheet => sources.has(sheet))) {
        const cells = {};
        wb._ensureSpills(source);
        const keys = new Set([...source.cells.keys(), ...(wb._spills.get(source.id)?.cover.keys() || [])]);
        for (const key of keys) {
          const [r, c] = key.split(',').map(Number);
          const value = wb.getValue(source.id, r, c);
          if (value != null) {
            if (++count > 1048576) throw new Error(t('externalWorkbookSheetCopy.cacheTooLarge'));
            cells[key] = value;
          }
        }
        sheets.push({ name: source.name, cells, visibility: {
          hiddenRows: [...source.hiddenRows], hiddenCols: [...source.hiddenCols], filteredRows: [...source.filterHidden],
        } });
      }
      const names = includeNames ? wb.names.map(entry => {
        const owner = entry.sheet ? wb.sheetByName(entry.sheet) : selected;
        let ref = boundedTableRows(wb, owner, entry.ref, wb.tableNames());
        for (const table of wb.tableNames()) ref = wb.structuredToA1(owner.id,0,0,ref,table,true);
        if (!entry.relative) ref = mapFormulaRefs(ref, parsed => ({ ...parsed, absR1: true, absR2: true, absC1: true, absC2: true }));
        return { name: entry.name, ref: toFileFormula(ref), ...(entry.sheet ? { sheet: sheets.findIndex(s => sheetKey(s.name) === sheetKey(entry.sheet)) } : {}) };
      }) : [];
      books.push({ target: sourceWorkbook, sheets, names });
    }
    return books.length ? normalizeExternalWorkbooks({ version: 1, books }) : null;
  };
  return { rewrite, rewriteName: rewrite, finish };
}
