/**
 * Custom Views in .xlsx: the workbook part lists each view (customWorkbookView: its name, GUID, window and
 * active sheet, whether it keeps print settings and hidden rows and columns), and each worksheet keeps its
 * own part of every view (customSheetView with the same GUID: zoom, view, top-left cell, panes, selection,
 * display switches, sheet state, page setup and AutoFilter). Hidden row and column lists have no place
 * there; the app's own record carries them, matched to the native view by GUID.
 */
import { xmlTag } from './xlsx-export-styles.js';
import { xlsxAttr } from './xlsx-styles.js';
import { cellName, rangeName, parseCellRef, parseRange } from './cell.js';
import { writeXlsxPrint } from './xlsx-export-print.js';
import { readXlsxPrint } from './xlsx-print.js';
import { readXlsxFilter, writeXlsxFilter } from './xlsx-filter.js';
import { normalizeSheetSelection } from './sheet-selection.js';

const VIEW_NAMES = { pageLayout: 'pageLayout', pageBreak: 'pageBreakPreview' };
const bool = (tag, name, fallback) => { const v = xlsxAttr(tag, name)?.trim(); return v == null ? fallback : v === '1' || v === 'true'; };

/** The <customSheetView> for one sheet's part of a view. */
function customSheetView(view, state, sheet) {
  const frozen = state.frozenRows || state.frozenCols;
  const base = state.frozenOrigin || { r: 0, c: 0 };
  const origin = state.origin || { r: base.r + state.frozenRows, c: base.c + state.frozenCols };
  const pane = frozen ? (state.frozenRows && state.frozenCols ? 'bottomRight' : state.frozenRows ? 'bottomLeft' : 'topRight') : null;
  let body = frozen ? xmlTag('pane', { xSplit: state.frozenCols || null, ySplit: state.frozenRows || null,
    topLeftCell: cellName(Math.max(base.r + state.frozenRows, origin.r), Math.max(base.c + state.frozenCols, origin.c)), activePane: pane, state: 'frozen' }) : '';
  if (state.selection) body += xmlTag('selection', { pane, activeCell: cellName(state.selection.active.r, state.selection.active.c),
    activeCellId: state.selection.ranges.length > 1 ? state.selection.activeRange : null, sqref: state.selection.ranges.map(rangeName).join(' ') });
  if (view.print && state.printSettings && sheet.kind !== 'chart') {
    // The page setup the worksheet would carry, in the order CT_CustomSheetView lists its parts.
    const page = writeXlsxPrint('<worksheet></worksheet>', state.printSettings);
    for (const tag of ['rowBreaks', 'colBreaks', 'pageMargins', 'printOptions', 'pageSetup', 'headerFooter']) {
      body += page.match(new RegExp(`<${tag}\\b[^>]*?(?:/>|>[^]*?</${tag}>)`))?.[0] || '';
    }
  }
  const filter = view.hidden ? state.filter : null;
  if (filter) body += xmlTag('autoFilter', { ref: rangeName(filter.range) }, writeXlsxFilter({ ...filter, hiddenButtons: filter.hiddenButtons || [] }) || null);
  const topLeft = frozen ? base : origin;
  return xmlTag('customSheetView', {
    guid: view.id, scale: Math.round((state.zoom || 1) * 100) === 100 ? null : Math.round(state.zoom * 100),
    showGridLines: state.gridlines === false ? 0 : null, showRowCol: state.headers === false ? 0 : null, zeroValues: state.zeros === false ? 0 : null,
    fitToPage: view.print && state.printSettings?.fitToPage ? 1 : null,
    filter: filter ? 1 : null, showAutoFilter: filter ? 1 : null,
    state: state.sheetHidden ? 'hidden' : null, view: VIEW_NAMES[state.mode] || null,
    topLeftCell: topLeft.r || topLeft.c ? cellName(topLeft.r, topLeft.c) : null,
  }, body || null);
}

/** Put each view's part for this sheet into the worksheet XML, where the schema has customSheetViews. */
export function writeXlsxSheetCustomViews(xml, views, sheet) {
  xml = xml.replace(/<customSheetViews\b[^>]*>[\s\S]*?<\/customSheetViews>/g, '');
  const parts = views.filter((v) => v.sheets[sheet.id]).map((v) => customSheetView(v, v.sheets[sheet.id], sheet));
  if (!parts.length) return xml;
  const tag = sheet.kind === 'chart' ? null : xmlTag('customSheetViews', {}, parts.join(''));
  if (!tag) return xml;
  return xml.replace(/<(?:mergeCells|phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/,
    (match) => tag + match);
}

/** The workbook part's <customWorkbookViews>, before pivotCaches and the rest, as the schema orders it. */
export function writeXlsxWorkbookCustomViews(workbookXml, views, wb) {
  workbookXml = workbookXml.replace(/<customWorkbookViews\b[^>]*>[\s\S]*?<\/customWorkbookViews>/g, '');
  if (!views.length) return workbookXml;
  // activeSheetId names the sheet by its sheetId in the workbook part's sheet list.
  const sheetIds = [...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => Number(xlsxAttr(m[0], 'sheetId')));
  const body = views.map((v) => xmlTag('customWorkbookView', {
    name: v.name, guid: v.id, includePrintSettings: v.print ? null : 0, includeHiddenRowCol: v.hidden ? null : 0,
    maximized: 1, windowWidth: 1600, windowHeight: 900, activeSheetId: sheetIds[Math.max(0, wb.sheets.findIndex((s) => s.id === v.activeSheetId))] || 1,
  })).join('');
  return workbookXml.replace(/<(?:pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>/,
    (match) => xmlTag('customWorkbookViews', {}, body) + match);
}

/** One worksheet's customSheetView, read back as a sheet state (custom-views.js). */
function readCustomSheetView(xml, sheetName) {
  const head = xml.match(/<(?:\w+:)?customSheetView\b[^>]*>/)[0];
  const zoom = Number(xlsxAttr(head, 'scale') ?? 100);
  const state = {
    zoom: zoom >= 10 && zoom <= 400 ? zoom / 100 : 1,
    mode: { pageLayout: 'pageLayout', pageBreakPreview: 'pageBreak' }[xlsxAttr(head, 'view')] || 'normal',
    gridlines: bool(head, 'showGridLines', true), headers: bool(head, 'showRowCol', true), zeros: bool(head, 'zeroValues', true),
    sheetHidden: /^(hidden|veryHidden)$/.test(xlsxAttr(head, 'state') || ''), frozenRows: 0, frozenCols: 0,
  };
  const topLeft = parseCellRef(xlsxAttr(head, 'topLeftCell'));
  const pane = xml.match(/<(?:\w+:)?pane\b[^>]*>/)?.[0];
  if (pane && /^frozen/.test(xlsxAttr(pane, 'state') || '')) {
    state.frozenRows = Math.max(0, Math.trunc(Number(xlsxAttr(pane, 'ySplit')) || 0));
    state.frozenCols = Math.max(0, Math.trunc(Number(xlsxAttr(pane, 'xSplit')) || 0));
    if (topLeft && (topLeft.r || topLeft.c)) state.frozenOrigin = { r: state.frozenRows ? topLeft.r : 0, c: state.frozenCols ? topLeft.c : 0 };
    const scrolled = parseCellRef(xlsxAttr(pane, 'topLeftCell'));
    if (scrolled) state.origin = { r: scrolled.r, c: scrolled.c };
  } else if (topLeft) state.origin = { r: topLeft.r, c: topLeft.c };
  const selection = xml.match(/<(?:\w+:)?selection\b[^>]*>/)?.[0];
  if (selection) {
    const active = parseCellRef(xlsxAttr(selection, 'activeCell'));
    const ranges = (xlsxAttr(selection, 'sqref') || '').trim().split(/\s+/).map(parseRange).filter(Boolean);
    const sel = normalizeSheetSelection({ active, ranges: ranges.length ? ranges : active ? [{ r1: active.r, c1: active.c, r2: active.r, c2: active.c }] : [], activeRange: Number(xlsxAttr(selection, 'activeCellId') || 0) });
    if (sel) state.selection = sel;
  }
  const page = readXlsxPrint(`<worksheet>${xml.replace(/^<[^>]*>|<\/[^>]*>$/g, '')}</worksheet>`, [], sheetName, -1);
  if (page) state.printSettings = page;
  const filter = xml.match(/<(?:\w+:)?autoFilter\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?autoFilter>)/)?.[0];
  const range = filter && parseRange(xlsxAttr(filter, 'ref'));
  if (range) state.filter = { range, criteria: readXlsxFilter(filter.replace(/^<[^>]*>|<\/[^>]*>$/g, ''), range) || {} };
  return state;
}

/**
 * The views a file holds, keyed to the sheets by name: [{ id, name, print, hidden, activeSheet, sheets: { [name]: state } }].
 * `partOf(name)` is a worksheet's XML. Hidden-line lists come from `saved` (the app's record) for the
 * views it knows by GUID, whose states it then supplies whole.
 */
export function readXlsxCustomViews(workbookXml, sheetNames, partOf, saved = null) {
  const list = [...(workbookXml || '').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(?:\w+:)?customWorkbookView\b[^>]*>/g)].map((m) => m[0]);
  if (!list.length) return [];
  const sheetTags = [...workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => m[0]);
  const parts = new Map(sheetNames.map((name) => [name, partOf(name) || '']));
  const known = new Map((Array.isArray(saved) ? saved : []).filter((v) => typeof v?.id === 'string').map((v) => [v.id.toUpperCase(), v]));
  return list.map((tag) => {
    const id = (xlsxAttr(tag, 'guid') || '').toUpperCase(), name = xlsxAttr(tag, 'name');
    if (!/^\{[0-9A-F-]{36}\}$/.test(id) || !name) return null;
    const activeTag = sheetTags.find((t) => xlsxAttr(t, 'sheetId') === xlsxAttr(tag, 'activeSheetId'));
    const view = { id, name, print: bool(tag, 'includePrintSettings', true), hidden: bool(tag, 'includeHiddenRowCol', true),
      activeSheet: activeTag ? xlsxAttr(activeTag, 'name') : sheetNames[0], sheets: {} };
    for (const [sheetName, xml] of parts) {
      const own = [...xml.matchAll(/<(?:\w+:)?customSheetView\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?customSheetView>)/g)].map((m) => m[0])
        .find((x) => (xlsxAttr(x.match(/^<[^>]*>/)[0], 'guid') || '').toUpperCase() === id);
      if (own) view.sheets[sheetName] = readCustomSheetView(own, sheetName);
    }
    const mine = known.get(id);
    // The app's record of the view is whole (hidden lines too); a sheet another program added keeps its native part.
    if (mine?.sheets && typeof mine.sheets === 'object') for (const [sheetName, state] of Object.entries(mine.sheets)) if (view.sheets[sheetName]) view.sheets[sheetName] = state;
    return Object.keys(view.sheets).length ? view : null;
  }).filter(Boolean);
}
