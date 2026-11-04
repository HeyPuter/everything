import { dataModelSheetCopy } from './data-model-sheet-copy.js';
import { modelConnectionId } from './data-model-bindings.js';
import { rebaseWorkbookTarget as rebasePivotWorkbookTarget } from './workbook-location.js';
import { normalizeNativePivots, pivotChartQualifier } from './native-pivots.js';
import { parseModelXml, modelChildren, standaloneModelXml } from './data-model-metadata.js';
import { decodeXlsxString, encodeXlsxAttribute } from './xlsx-string.js';
import { sheetKey } from './refs.js';
import { snapshotChartData } from './charts.js';
import { t } from '../i18n/index.js';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const identity = report => JSON.stringify([report.owner, sheetKey(decodeXlsxString(report.name))]);
const fail = message => { throw new Error(`Cannot copy pivot sheet: ${message}`); };
function requireSourceLocation(sourceWorkbook) {
  if (typeof sourceWorkbook === 'string' && sourceWorkbook.trim()) return;
  const error = new Error(t('nativePivotSheetCopy.saveSourceFirst'));
  error.code = 'PIVOT_SOURCE_LOCATION_REQUIRED'; throw error;
}
export { rebaseWorkbookTarget as rebasePivotWorkbookTarget } from './workbook-location.js';
function chartReport(wb, chart) {
  const source = chart.pivotSource;
  if (!source) return null;
  const reports = wb.nativePivots.tables.filter(report => {
    if (!source.standalone) return report.owner != null && pivotChartQualifier(source.name, wb.sheet(report.owner)?.name || '', report.name);
    if (report.owner != null) return false;
    const quoted = source.name.startsWith("'") && source.name.endsWith("'");
    const value = quoted ? source.name.slice(1, -1).replace(/''/g, "'") : source.name;
    const end = value.startsWith('[') ? value.lastIndexOf(']') : -1;
    return (!value.startsWith('[') || end >= 0) && sheetKey(value.slice(end + 1)) === sheetKey(report.name);
  });
  if (reports.length !== 1) fail('missing or ambiguous chart report');
  return reports[0];
}

/** Extract the report/cache graph without copying cells from omitted sheets.
 * A URI is required only when a formerly local source is left in the original. */
export function nativePivotSheetCopy(wb, sheet, { sourceWorkbook = null } = {}) {
  const model = dataModelSheetCopy(wb, sheet);
  const extra = { dataModel: model.dataModel, entries: model.entries };
  const pivots = wb.nativePivots;
  if (!pivots) return { ...extra, pivots: null, charts: sheet.charts, names: model.formulas };
  const selected = new Set(pivots.tables.filter(p => p.owner === sheet.id));
  const chartReports = new Map();
  for (const chart of sheet.charts) if (chart.pivotSource) {
    const report = chartReport(wb, chart); selected.add(report); chartReports.set(chart, report);
  }
  const reportCopies = new Map([...selected].map(report => [identity(report), { ...report, owner: report.owner === sheet.id ? sheet.id : null }]));
  const viewCaches = new Set(sheet.charts.filter(c => c.type === 'slicer' && c.pivotCache != null).map(c => sheetKey(c.pivotCache)));
  const slicers = (pivots.slicers || []).filter(s => viewCaches.has(sheetKey(s.name)) || s.connections.some(ref => reportCopies.has(identity(ref))))
    .map(s => ({ ...s, connections: s.connections.flatMap(ref => { const report = reportCopies.get(identity(ref)); return report ? [{ owner: report.owner, name: report.name }] : []; }) }));
  for (const name of viewCaches) if (!slicers.some(s => sheetKey(s.name) === name)) fail('missing slicer cache');
  const needed = new Set([...selected].map(p => p.cache));
  for (const slicer of slicers) needed.add(slicer.cache);
  if (!needed.size) return { ...extra, pivots: null, charts: sheet.charts, names: model.formulas };
  const names = [...model.formulas];
  const caches = pivots.caches.filter(cache => needed.has(cache.key)).map(cache => {
    if (cache.sourceWorkbook != null) {
      if (!/^(?:[a-z][\w+.-]*:|\/)/i.test(cache.sourceWorkbook)) requireSourceLocation(sourceWorkbook);
      return { ...cache, sourceWorkbook: rebasePivotWorkbookTarget(cache.sourceWorkbook, sourceWorkbook) };
    }
    const root = parseModelXml(cache.xml), cacheSource = modelChildren(root, 'cacheSource', MAIN)[0];
    if (cacheSource?.getAttribute('type') === 'external' && model.connectionIds.has(modelConnectionId(cacheSource.getAttribute('connectionId') ?? '0'))) return cache;
    if (cacheSource?.getAttribute('type') !== 'worksheet') fail('external connection sheet extraction is not implemented');
    const source = modelChildren(cacheSource, 'worksheetSource', MAIN)[0];
    if (!source || source.hasAttributeNS(REL, 'id')) fail('missing source relationship target');
    const sourceName = decodeXlsxString(source.getAttribute('name'));
    let local = cache.sourceSheetId === sheet.id;
    if (sourceName) {
      const scope = decodeXlsxString(source.getAttribute('sheet')) || null, entry = wb.namedEntry(sourceName, scope);
      if (entry) {
        const ref = !entry.relative && wb.parseNamedRef(entry.ref);
        local = !!ref && sheetKey(ref.sheet || '') === sheetKey(sheet.name) && (!entry.sheet || sheetKey(entry.sheet) === sheetKey(sheet.name));
        if (local) names.push(sourceName);
      } else {
        const table = wb.tableByName(sourceName);
        if (!table) fail('missing named source');
        local = table.sheet.id === sheet.id;
      }
    }
    if (local) return cache;
    requireSourceLocation(sourceWorkbook);
    if (cache.sourceSheetId != null) {
      const owner = wb.sheet(cache.sourceSheetId); if (!owner) fail('missing source sheet');
      source.setAttribute('sheet', encodeXlsxAttribute(owner.name));
    }
    // Export allocates the package relationship from this stable URI.
    return { ...cache, sourceSheetId: null, sourceWorkbook, xml: standaloneModelXml(root) };
  });
  if (caches.length !== needed.size) fail('missing source cache');
  const result = normalizeNativePivots({ ...pivots, ...(model.dataModel ? { connections: model.dataModel.connectionsXml } : {}), caches, tables: [...reportCopies.values()], ...(pivots.slicers ? { slicers } : {}) });
  if (!result) fail('invalid native metadata');
  const charts = sheet.charts.map(chart => {
    const report = chartReports.get(chart);
    if (!report || report.owner === sheet.id || chart.pivotSource.standalone) return chart;
    // Its report becomes non-worksheet, so retain the currently resolved series
    // as native literal vectors instead of dangling worksheet references. Keep
    // the report/cache connection and the chart's independent title references.
    const { sourceRefs } = snapshotChartData(wb, sheet.id, chart);
    return { ...chart, sourceRefs, pivotSource: { ...chart.pivotSource, name: report.name, standalone: true } };
  });
  return { ...extra, pivots: result, charts, names };
}
