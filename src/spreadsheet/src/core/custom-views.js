/**
 * Custom Views (View ▸ Custom Views): named, workbook-wide snapshots of how each sheet is shown, to switch
 * between later. A view keeps, for every sheet, its zoom, selection, scroll position, frozen panes or split,
 * view mode and display switches; optionally its hidden rows and columns with its filters, and its page
 * setup. In .xlsx a view is a customWorkbookView with one customSheetView per sheet (see xlsx-custom-views.js).
 *
 * The model: wb.customViews = [{ id: '{GUID}', name, print, hidden, activeSheetId, sheets: { [sheetId]: state } }].
 */
import { MAX_ROW, MAX_COL } from './refs.js';
import { normalizeSheetSelection, normalizeSheetOrigin } from './sheet-selection.js';
import { normalizeSplit } from './split-panes.js';
import { normalizePrintSettings } from './print-settings.js';

/** The most views a workbook keeps. */
export const MAX_CUSTOM_VIEWS = 256;
/** A view's name, as the dialog accepts it. */
export const CUSTOM_VIEW_NAME_MAX = 255;
const MODES = ['normal', 'pageLayout', 'pageBreak'];

const guid = () => `{${(globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`).toUpperCase()}}`;
const lines = (list, max) => Array.isArray(list) ? [...new Set(list.filter(n => Number.isInteger(n) && n >= 0 && n <= max))].sort((a, b) => a - b) : [];

/** Is this a name a view can take: some text, not too long, unlike every other view's name (case aside)? */
export function customViewNameProblem(name, views = [], except = null) {
  const text = String(name ?? '').trim();
  if (!text) return 'Type a name for the view.';
  if (text.length > CUSTOM_VIEW_NAME_MAX) return `A view name can be at most ${CUSTOM_VIEW_NAME_MAX} characters.`;
  if (views.some(v => v.id !== except && v.name.toLowerCase() === text.toLowerCase())) return 'A view with that name already exists.';
  return null;
}

/** One sheet's part of a view, from the sheet as it is now. */
export function captureSheetView(sheet, { print = true, hidden = true, copyFilter = f => f && JSON.parse(JSON.stringify(f)) } = {}) {
  const state = {
    zoom: sheet.viewZoom ?? 1,
    mode: sheet.viewMode || 'normal',
    ...(sheet.viewSelection ? { selection: normalizeSheetSelection(sheet.viewSelection) } : {}),
    ...(sheet.viewOrigin ? { origin: normalizeSheetOrigin(sheet.viewOrigin) } : {}),
    frozenRows: sheet.frozenRows || 0, frozenCols: sheet.frozenCols || 0,
    ...(sheet.frozenOrigin ? { frozenOrigin: normalizeSheetOrigin(sheet.frozenOrigin) } : {}),
    ...(sheet.split ? { split: normalizeSplit(sheet.split) } : {}),
    gridlines: sheet.gridlines !== false, headers: sheet.headers !== false, zeros: sheet.zeros !== false,
    sheetHidden: !!sheet.hidden,
  };
  if (hidden) Object.assign(state, {
    hiddenRows: [...sheet.hiddenRows].sort((a, b) => a - b), hiddenCols: [...sheet.hiddenCols].sort((a, b) => a - b),
    filter: copyFilter(sheet.filter) || null, otherFilters: (sheet.otherFilters || []).map(copyFilter),
  });
  if (print) state.printSettings = sheet.printSettings ? normalizePrintSettings(sheet.printSettings) : null;
  return state;
}

/**
 * A stored sheet state made safe: numbers in range, lines inside the grid. `normalizeFilter` is the
 * workbook's own filter check, which the stored filter must pass before it drives a reapply.
 */
export function normalizeSheetViewState(raw, normalizeFilter = f => f) {
  if (!raw || typeof raw !== 'object') return null;
  const zoom = Number(raw.zoom);
  const state = {
    zoom: Number.isFinite(zoom) && zoom >= 0.1 && zoom <= 4 ? zoom : 1,
    mode: MODES.includes(raw.mode) ? raw.mode : 'normal',
    frozenRows: Math.max(0, Math.min(50, raw.frozenRows | 0)), frozenCols: Math.max(0, Math.min(20, raw.frozenCols | 0)),
    gridlines: raw.gridlines !== false, headers: raw.headers !== false, zeros: raw.zeros !== false, sheetHidden: raw.sheetHidden === true,
  };
  const selection = normalizeSheetSelection(raw.selection);
  if (selection) state.selection = selection;
  const origin = normalizeSheetOrigin(raw.origin);
  if (origin) state.origin = origin;
  const frozenOrigin = normalizeSheetOrigin(raw.frozenOrigin);
  if (frozenOrigin && (state.frozenRows || state.frozenCols)) state.frozenOrigin = frozenOrigin;
  const split = !state.frozenRows && !state.frozenCols ? normalizeSplit(raw.split) : null;
  if (split) state.split = split;
  if (Array.isArray(raw.hiddenRows) || Array.isArray(raw.hiddenCols) || 'filter' in raw) {
    state.hiddenRows = lines(raw.hiddenRows, MAX_ROW);
    state.hiddenCols = lines(raw.hiddenCols, MAX_COL);
    state.filter = raw.filter ? normalizeFilter(raw.filter) : null;
    state.otherFilters = (Array.isArray(raw.otherFilters) ? raw.otherFilters : []).map(normalizeFilter).filter(Boolean);
  }
  if ('printSettings' in raw) state.printSettings = raw.printSettings ? normalizePrintSettings(raw.printSettings) : null;
  return state;
}

/** The views as stored with a workbook whose sheets have these ids: unknown sheets are dropped, names kept unique. */
export function normalizeCustomViews(raw, sheetIds, normalizeFilter) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(sheetIds), seen = new Set(), out = [];
  for (const v of raw.slice(0, MAX_CUSTOM_VIEWS)) {
    const name = typeof v?.name === 'string' ? v.name.trim().slice(0, CUSTOM_VIEW_NAME_MAX) : '';
    if (!name || seen.has(name.toLowerCase())) continue;
    const sheets = {};
    for (const [id, state] of Object.entries(v.sheets && typeof v.sheets === 'object' ? v.sheets : {})) {
      if (!ids.has(id)) continue;
      const s = normalizeSheetViewState(state, normalizeFilter);
      if (s) sheets[id] = s;
    }
    if (!Object.keys(sheets).length) continue;
    seen.add(name.toLowerCase());
    out.push({ id: typeof v.id === 'string' && /^\{[0-9A-F-]{36}\}$/i.test(v.id) ? v.id.toUpperCase() : guid(), name,
      print: v.print !== false, hidden: v.hidden !== false,
      activeSheetId: ids.has(v.activeSheetId) ? v.activeSheetId : Object.keys(sheets)[0], sheets });
  }
  return out;
}

/** A fresh view of the workbook as it is now. */
export function captureCustomView(wb, name, { print = true, hidden = true, copyFilter } = {}) {
  const sheets = {};
  for (const sheet of wb.sheets) sheets[sheet.id] = captureSheetView(sheet, { print, hidden, copyFilter });
  return { id: guid(), name: String(name).trim().slice(0, CUSTOM_VIEW_NAME_MAX), print: !!print, hidden: !!hidden, activeSheetId: wb.activeSheetId, sheets };
}

/** A copy of the views with sheet ids rewritten through `map` (id → id or null to drop the sheet). */
export function remapCustomViews(views, map) {
  return views.map(v => {
    const sheets = {};
    for (const [id, state] of Object.entries(v.sheets)) { const to = map(id); if (to != null) sheets[to] = state; }
    return { ...v, activeSheetId: map(v.activeSheetId) ?? Object.keys(sheets)[0], sheets };
  }).filter(v => Object.keys(v.sheets).length);
}
