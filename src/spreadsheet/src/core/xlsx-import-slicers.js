import { readXlsxSlicers } from './xlsx-slicers.js';
import { slicerDrawingBounds } from './slicer-drawing.js';
import { resolveSlicerPaint } from './slicer-paint.js';
import { DEFAULT_SLICER_STYLE } from './slicer-builtin-styles.js';
import { normalizeSlicer, slicerTableReference } from './slicer.js';
import { decodeModelXml } from './data-model-metadata.js';

/** A style whose paint the app cannot draw yet (a pattern fill, say) must not keep the
 * workbook from opening: its slicers are drawn, and saved, in the default slicer style. */
function slicerPaint(style, themes) {
  try { return resolveSlicerPaint(style, themes); }
  catch (e) {
    console.warn(`Slicer style ${style?.name ?? '(none)'} drawn as ${DEFAULT_SLICER_STYLE}:`, e?.message || e);
    return resolveSlicerPaint({ name: DEFAULT_SLICER_STYLE, builtIn: true }, themes);
  }
}

/** A PivotTable slicer whose cache did not resolve to a worksheet PivotCache reads the Data Model. */
export const olap = cache => cache?.kind === 'pivot' && !cache.pivot && !cache.unsupported;

/** Native slicer views are authoritative, including deletion and external edits.
 * Their selection lives in the native table AutoFilter, not private drawing data.
 */
export function importXlsxSlicers(book, sheets, themes = book.Themes, sheetXml = null) {
  const part = book.Directory?.workbooks?.[0]?.replace(/^\//, '') || 'xl/workbook.xml';
  const bytes = book.files?.[part]?.content;
  // An .xlsb's workbook part is binary records, with no slicers this reader can find.
  if (!bytes || !/\.xml$/i.test(part)) return;
  // Older app exports could not emit slicers. Do not resurrect saved controls
  // after another application deletes the native views or their cache list.
  for (const sheet of sheets) sheet.charts = (sheet.charts || []).filter(c => c.type !== 'slicer');
  if (!decodeModelXml(bytes).xml.includes('slicerCaches') && !sheets.some(s => sheetXml?.(s.name)?.includes('slicerList'))) return;
  const native = readXlsxSlicers(book, { unsupported: (cache, e) => { cache.unsupported = e?.message || String(e); } });
  if (!native) return;
  const caches = new Map(native.caches.map(c => [c.name, c]));
  const styles = new Map(native.styles.map(s => [s.name, s]));
  const paints = new Map();
  for (const view of native.views) {
    const cache = caches.get(view.cache), sheet = sheets.find(s => s.name === view.owner);
    // A slicer over the Data Model (an OLAP cache) cannot filter anything here yet; its
    // reports keep the values Excel saved, and the workbook opens without the control.
    if (olap(cache)) { console.warn(`Slicer ${view.name} filters the Data Model, which is not supported yet; it is not shown`); continue; }
    // Nor can one bound in a way this app cannot model; the rest of the workbook opens all the same.
    if (cache?.unsupported) { console.warn(`Slicer ${view.name} is not shown: ${cache.unsupported}`); continue; }
    if (!sheet || !view.drawing) throw new Error('Missing native slicer drawing or worksheet');
    const styleName = view.style || native.defaultStyle;
    if (!paints.has(styleName)) paints.set(styleName, slicerPaint(styles.get(styleName), themes));
    const control = normalizeSlicer({ ...slicerDrawingBounds(view.drawing, sheet),
      nativeName: view.name, nativeCacheName: cache.name,
      ...(cache.kind === 'pivot' ? { pivotCache: cache.name } : { tableRef: slicerTableReference(cache.table.name, cache.table.column.name) }), title: view.caption || '',
      description: view.drawing.description, print: view.drawing.print, hidden: view.drawing.hidden,
      columnCount: view.columnCount, rowHeight: view.rowHeight, startItem: view.startItem,
      showCaption: view.showCaption, lockedPosition: view.lockedPosition, paint: paints.get(styleName),
      sortOrder: cache.sortOrder, customListSort: cache.customListSort, crossFilter: cache.crossFilter,
      hideItemsWithNoData: cache.hideItemsWithNoData,
    });
    sheet.charts.push(control);
  }
  return native;
}
