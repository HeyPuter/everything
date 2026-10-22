import { readNativePivotCache } from './native-pivot-cache.js';
import { decodeXlsxString } from './xlsx-string.js';
import { sheetKey } from './refs.js';

const fail = message => { throw new Error(`Invalid native slicer: ${message}`); };
const one = (values, label) => { if (values.length !== 1) fail(`missing or ambiguous ${label}`); return values[0]; };

/** Join package identities before creating an interactive control. Sheet IDs
 * are not workbook positions; the slicer cache ID is the x14 definition ID,
 * not the core pivot cacheId. A non-worksheet report ignores tabId (MS-XLSX
 * 2.6.73). Read definitions once per cache, without expanding saved records.
 */
export function resolveNativePivotSlicers(slicers, pivots, sheets, { unsupported = null } = {}) {
  const byId = new Map(), byKey = new Map();
  for (const cache of pivots?.caches || []) {
    const data = readNativePivotCache(cache, { includeRecords: false });
    byKey.set(cache.key, { cache, data });
    if (data.slicerCacheId == null) continue;
    if (byId.has(data.slicerCacheId)) fail('duplicate pivot cache identity');
    byId.set(data.slicerCacheId, { cache, data });
  }
  const results = new Map();
  for (const slicer of slicers) {
    // On import, a slicer this app cannot model is told to `unsupported` and left out, rather than
    // keeping the whole workbook from opening.
    if (!unsupported) results.set(slicer, resolve(slicer));
    else try { results.set(slicer, resolve(slicer)); } catch (e) { unsupported(slicer, e); }
  }
  return results;

  function resolve(slicer) {
    const stored = slicer.connections != null;
    const source = stored ? byKey.get(slicer.cache) : byId.get(slicer.pivotCacheId);
    if (!source) fail('missing pivot source cache');
    const { cache, data } = source;
    if (stored && data.slicerCacheId == null) fail('missing pivot source cache identity');
    const index = one(data.fields.flatMap((field, i) => sheetKey(field.name) === sheetKey(slicer.sourceName) ? [i] : []), 'pivot source field');
    const field = data.fields[index];
    if (field.serverField) fail('server field used by a tabular slicer');
    for (const item of slicer.items || []) if (item.index >= field.items.length) fail('pivot slicer member index');
    const seen = new Set();
    const reports = (stored ? slicer.connections : slicer.pivotTables).map(reference => {
      const owners = sheets.filter(sheet => stored ? sheet.id === reference.owner : sheet.tabId === reference.tabId);
      if (owners.length > 1) fail('duplicate worksheet identity');
      const report = one((pivots?.tables || []).filter(report =>
        sheetKey(decodeXlsxString(report.name)) === sheetKey(stored ? decodeXlsxString(reference.name) : reference.name)
        && (stored ? report.owner === reference.owner : report.owner == null || owners.length === 1 && report.owner === owners[0].id)), 'connected pivot report');
      if (report.owner != null && owners.length !== 1) fail('missing report worksheet');
      if (report.cache !== cache.key) fail('connected pivot report uses a different cache');
      if (seen.has(report)) fail('duplicate connected pivot report');
      seen.add(report);
      return { name: decodeXlsxString(report.name), sheet: report.owner == null ? null : owners[0].name };
    });
    return { cacheKey: cache.key, slicerCacheId: data.slicerCacheId, field: { index, ...field }, reports };
  }
}
