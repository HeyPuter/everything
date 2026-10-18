/**
 * Insert ▸ Slicer and Table Design ▸ Insert Slicer: new slicer controls over a table's columns or
 * a PivotTable's fields, shaped as the importer shapes the ones a file brings, so the same grid
 * control filters them and the same writer exports them (slicerCaches, slicers, the x14/x15
 * extLst entries and the drawing frame).
 *
 * A table slicer filters through the table's AutoFilter: a table without one gets one with its
 * buttons hidden, keeping the Filter Button choice. A PivotTable slicer is a native
 * slicer cache bound to the report's PivotCache (its x14 pivotCacheId) and listing the field's
 * shared items, all selected; choosing items rewrites the report as a file's slicer does.
 */
import { resolveSlicerPaint } from './slicer-paint.js';
import { DEFAULT_SLICER_STYLE } from './slicer-builtin-styles.js';
import { normalizeSlicer, slicerTableReference } from './slicer.js';
import { effectiveColorPalette } from './font-color.js';
import { sheetFilters, filterTable } from './sheet-filters.js';
import { tableRows } from './tables.js';
import { readNativePivotCache } from './native-pivot-cache.js';
import { normalizeNativePivotSlicers } from './native-pivot-slicer-storage.js';
import { indexNativePivotField, withFieldItems } from './native-pivot-index-field.js';
import { nativePivotSlicerAvailability } from './native-pivot-slicer-availability.js';
import { parseModelXml, modelChildren, standaloneModelXml } from './data-model-metadata.js';
import { decodeXlsxString, encodeXlsxAttribute } from './xlsx-string.js';
import { parseRefText, sheetKey } from './refs.js';
import { compareStoredValues } from './formula/functions.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
/** The extension URI for the x14 pivotCacheDefinition that carries the slicer cache identity. */
const X14_CACHE_EXT = '{725AE2AE-9491-48be-B2B4-4EB974FC3084}';

/** A new slicer's size and item height (2 × 2.67 inches; 0.26 inch items). */
export const SLICER_DEFAULTS = { w: 192, h: 256, rowHeight: 241300 };

/** The workbook theme in the shape slicer paint decodes colours against. */
export function slicerThemes(wb) {
  const palette = effectiveColorPalette(wb.colorPalette);
  return { fontTheme: wb.fontTheme, themeElements: { clrScheme: palette.theme.map(rgb => ({ rgb: rgb?.slice(1) })) }, indexedColors: palette.indexed.map(rgb => rgb?.slice(1)) };
}

/** The default slicer style, drawn in this workbook's theme. */
export function defaultSlicerPaint(wb) {
  return resolveSlicerPaint({ name: DEFAULT_SLICER_STYLE, builtIn: true }, slicerThemes(wb));
}

/** Where new slicers go: beside the source, each one cascading a little from the one before. */
function placement(at, i) {
  return { anchor: { r: at.r, c: at.c }, dx: 24 * i, dy: 24 * i };
}

/** How many slicers and timelines already stand at a cell, so new ones cascade on from them instead of covering them. */
function standingAt(sheet, at) {
  return sheet.charts.filter(c => (c.type === 'slicer' || c.type === 'timeline') && c.anchor?.r === at.r && c.anchor?.c === at.c).length;
}

/** Why slicers cannot be inserted for this table now, or null. */
export function tableSlicerProblem(wb, sheetId, table) {
  if (!table) return 'Select a cell in a table or PivotTable to insert slicers.';
  if (table.headerRow === false) return 'Turn on the table’s Header Row to insert slicers.';
  if (wb.isProtected?.(sheetId)) return 'Unprotect the sheet to insert slicers.';
  return null;
}

/**
 * One slicer per chosen column (names as wb.tableColumns gives them). Returns the new control ids.
 * `at` is the cell the first slicer anchors to (default: two columns right of the table).
 */
export function insertTableSlicers(wb, sheetId, tableId, columns, { at = null } = {}) {
  const sheet = wb.sheet(sheetId), table = wb.tableById(sheetId, tableId);
  const problem = tableSlicerProblem(wb, sheetId, table);
  if (problem) throw new Error(problem);
  const names = wb.tableColumns(sheetId, table);
  const chosen = columns.filter(name => names.includes(name));
  if (!chosen.length) return [];
  const paint = defaultSlicerPaint(wb), ids = [];
  const start = at || { r: table.range.r1, c: table.range.c2 + 2 };
  const before = standingAt(sheet, start);
  wb.transaction('Insert slicer', () => {
    // The slicer filters through the table's AutoFilter; a table without one gets one, its buttons hidden.
    if (!sheetFilters(sheet).some(f => filterTable(sheet, f)?.id === table.id)) {
      const rows = tableRows(table);
      wb._setFilter(sheet, { range: { r1: rows.header, c1: table.range.c1, r2: rows.dataEnd, c2: table.range.c2 }, criteria: {}, showButtons: false }, 'Insert slicer', { create: true });
    }
    chosen.forEach((name, i) => {
      const control = normalizeSlicer({ type: 'slicer', tableRef: slicerTableReference(table.name, name), title: name,
        ...placement(start, before + i), w: SLICER_DEFAULTS.w, h: SLICER_DEFAULTS.h, rowHeight: SLICER_DEFAULTS.rowHeight, paint });
      const id = wb.addChart(sheetId, control);
      if (id) ids.push(id);
    });
  });
  return ids;
}

/* ---------- PivotTables ---------- */

/** The PivotTable report whose area holds the cell, or null. */
export function nativePivotAt(wb, sheetId, r, c) {
  for (const pivot of wb.nativePivots?.tables || []) {
    if (pivot.owner !== sheetId) continue;
    const range = parseRefText(pivot.ref || '');
    if (range && r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) return pivot;
  }
  return null;
}

/** The report's source fields a slicer can show: name, index, and why one cannot (no shared items, a server or calculated field). */
export function pivotSlicerFields(wb, pivot) {
  const cache = wb.nativePivots.caches.find(c => c.key === pivot.cache);
  if (!cache) return [];
  const data = readNativePivotCache(cache, { includeRecords: false });
  const used = new Set((wb.nativePivots.slicers || []).filter(s => s.cache === cache.key).map(s => sheetKey(decodeXlsxString(parseModelXml(s.xml).getAttribute('sourceName') || ''))));
  return data.fields.map((field, index) => ({ index, name: field.name, items: field.items,
    problem: !field.databaseField || field.serverField ? 'A calculated or grouped field cannot have a slicer here.'
      : !field.items.length && !cache.records ? 'The file holds no saved records for this field; refresh the PivotTable in the program that saved it, then open it again.' : null,
    existing: used.has(sheetKey(field.name)) }));
}

/** The x14 slicer identity of a PivotCache, giving it one (the next free number) when it has none yet. */
function ensureSlicerCacheId(pivots, cacheKey) {
  const ids = pivots.caches.map(c => readNativePivotCache(c, { includeRecords: false }).slicerCacheId).filter(v => v != null);
  const cache = pivots.caches.find(c => c.key === cacheKey);
  const own = readNativePivotCache(cache, { includeRecords: false }).slicerCacheId;
  if (own != null) return { pivots, id: own };
  const id = Math.max(0, ...ids) + 1;
  const root = parseModelXml(cache.xml), doc = root.ownerDocument;
  const make = (ns, name) => doc.createElementNS(ns, name);
  let list = modelChildren(root, 'extLst', MAIN)[0];
  if (!list) { list = make(MAIN, root.prefix ? `${root.prefix}:extLst` : 'extLst'); root.appendChild(list); }
  const ext = make(MAIN, root.prefix ? `${root.prefix}:ext` : 'ext');
  ext.setAttribute('uri', X14_CACHE_EXT);
  ext.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:x14', X14);
  const definition = make(X14, 'x14:pivotCacheDefinition');
  definition.setAttribute('pivotCacheId', String(id));
  ext.appendChild(definition); list.appendChild(ext);
  const xml = standaloneModelXml(root);
  return { pivots: { ...pivots, caches: pivots.caches.map(c => (c === cache ? { ...c, xml } : c)) }, id };
}

/**
 * Excel keeps slicers only on PivotTables in its 2010 (version 3) format or later: a cache or report
 * written without createdVersion, refreshedVersion and minRefreshableVersion of at least 3 is a
 * compatibility-mode PivotTable, and Excel removes its slicers as unreadable content. Inserting a
 * slicer upgrades both.
 */
function atLeastVersion3(xml, attributes) {
  const root = parseModelXml(xml);
  let changed = false;
  for (const name of attributes) {
    const value = Number(root.getAttribute(name) || 0);
    if (!(value >= 3)) { root.setAttribute(name, '3'); changed = true; }
  }
  return changed ? standaloneModelXml(root) : xml;
}
export function upgradePivotForSlicers(pivots, pivot, fieldIndexes = []) {
  const cache = pivots.caches.find(c => c.key === pivot.cache);
  const counts = cache ? readNativePivotCache(cache, { includeRecords: false }).fields.map(f => f.items.length) : [];
  const withItems = xml => fieldIndexes.reduce((out, i) => withFieldItems(out, i, counts[i] || 0), xml);
  const caches = pivots.caches.map(c => (c.key === pivot.cache ? { ...c, xml: atLeastVersion3(c.xml, ['createdVersion', 'refreshedVersion', 'minRefreshableVersion']) } : c));
  const tables = pivots.tables.map(p => (p.cache === pivot.cache ? { ...p, xml: atLeastVersion3(p === pivot || p.name === pivot.name && p.owner === pivot.owner ? withItems(p.xml) : p.xml, ['createdVersion', 'updatedVersion', 'minRefreshableVersion']) } : p));
  return { ...pivots, caches, tables };
}

/** A slicer cache name (Slicer_Region, Slicer_Region1, ...), free among defined names, tables and caches. */
export function freeSlicerCacheName(wb, field, taken = []) {
  const base = `Slicer_${String(field).replace(/[^A-Za-z0-9_.]/g, '_').replace(/^([^A-Za-z_])/, '_$1')}`.slice(0, 250);
  const used = new Set([...wb.names.map(n => n.name), ...wb.tableNames(), ...(wb.nativePivots?.slicers || []).map(s => s.name), ...taken].map(n => n.toUpperCase()));
  if (!used.has(base.toUpperCase())) return base;
  for (let k = 1; ; k++) if (!used.has(`${base}${k}`.toUpperCase())) return `${base}${k}`;
}

/** Field items in the order a slicer lists them: ascending values, blanks last. */
function sortedMembers(items) {
  const order = items.map((item, index) => ({ item, index }));
  const blank = ({ item }) => item.type === 'blank' || item.value == null || item.value === '';
  return [...order.filter(o => !blank(o)).sort((a, b) => compareStoredValues(a.item.caption ?? a.item.value, b.item.caption ?? b.item.value)), ...order.filter(blank)];
}

/** The native slicer cache XML for one field of a report, every item selected. */
export function pivotSlicerCacheXml({ name, sourceName, pivotCacheId, report, items }) {
  const list = sortedMembers(items).map(({ index }) => `<x14:i x="${index}" s="1"/>`).join('');
  return `<x14:slicerCacheDefinition xmlns:x14="${X14}" name="${encodeXlsxAttribute(name)}" sourceName="${encodeXlsxAttribute(sourceName)}">`
    + `<x14:pivotTables><x14:pivotTable tabId="0" name="${encodeXlsxAttribute(decodeXlsxString(report.name))}"/></x14:pivotTables>`
    + `<x14:data><x14:tabular pivotCacheId="${pivotCacheId}"><x14:items count="${items.length}">${list}</x14:items></x14:tabular></x14:data></x14:slicerCacheDefinition>`;
}

/** Mark the members no record has under the report's other filters (nd). */
function withAvailability(slicer, pivots, sheets) {
  const contexts = [...nativePivotSlicerAvailability([slicer], pivots, sheets).get(slicer).values()];
  if (!contexts.length) return slicer;
  const noData = new Set(contexts[0].filter(item => item.noData).map(item => item.index));
  if (!noData.size) return slicer;
  return { ...slicer, xml: slicer.xml.replace(/<x14:i x="(\d+)" s="1"\/>/g, (all, x) => (noData.has(Number(x)) ? `<x14:i x="${x}" s="1" nd="1"/>` : all)) };
}

/** Insert one slicer per chosen field index of a PivotTable report. Returns the new control ids. */
export function insertPivotSlicers(wb, sheetId, pivot, fieldIndexes, { at = null } = {}) {
  if (wb.isProtected?.(sheetId)) throw new Error('Unprotect the sheet to insert slicers.');
  const fields = pivotSlicerFields(wb, pivot);
  const chosen = fieldIndexes.map(i => fields[i]).filter(f => f && !f.problem);
  if (!chosen.length) return [];
  const before = wb.nativePivots;
  let { pivots, id: pivotCacheId } = ensureSlicerCacheId(before, pivot.cache);
  // A field kept inline in the records gets shared items first.
  for (const field of chosen) pivots = indexNativePivotField(pivots, pivot.cache, field.index);
  pivots = upgradePivotForSlicers(pivots, pivot, chosen.map(field => field.index));
  const indexed = pivotSlicerFields({ nativePivots: pivots }, pivot);
  const range = parseRefText(pivot.ref || '');
  const start = at || { r: range ? range.r1 : 0, c: range ? range.c2 + 2 : 0 };
  const paint = defaultSlicerPaint(wb), taken = [], created = [], standing = standingAt(wb.sheet(sheetId), start);
  for (const field of chosen) {
    const name = freeSlicerCacheName(wb, field.name, taken);
    taken.push(name);
    let slicer = { kind: 'pivot', name, cache: pivot.cache, connections: [{ owner: pivot.owner, name: pivot.name }],
      xml: pivotSlicerCacheXml({ name, sourceName: field.name, pivotCacheId, report: pivot, items: indexed[field.index].items }) };
    slicer = withAvailability(slicer, { ...pivots, slicers: [...(pivots.slicers || []), slicer] }, wb.sheets);
    created.push(slicer);
  }
  pivots = { ...pivots, slicers: normalizeNativePivotSlicers([...(pivots.slicers || []), ...created], pivots) };
  const ids = [];
  wb.transaction('Insert slicer', () => {
    const apply = value => { wb.nativePivots = value; wb._changed('pivots'); };
    apply(pivots);
    wb._push({ label: 'Insert slicer', undo: () => apply(before), redo: () => apply(pivots) });
    created.forEach((slicer, i) => {
      const control = normalizeSlicer({ type: 'slicer', pivotCache: slicer.name, title: chosen[i].name,
        ...placement(start, standing + i), w: SLICER_DEFAULTS.w, h: SLICER_DEFAULTS.h, rowHeight: SLICER_DEFAULTS.rowHeight, paint });
      const id = wb.addChart(sheetId, control);
      if (id) ids.push(id);
    });
  });
  return ids;
}
