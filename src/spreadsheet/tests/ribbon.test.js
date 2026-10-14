// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRibbon, RIBBON_TABS } from '../src/ui/ribbon.js';
import { Workbook } from '../src/core/workbook.js';

let ribbon;
afterEach(() => { ribbon?.destroy(); ribbon = null; document.body.replaceChildren(); localStorage.clear(); });
function setup(overrides = {}) {
  const wb = new Workbook();
  const state = { style: {}, gridlines: true, headers: true, singleCell: true, canUndo: false, canRedo: false, hasFormula: false, ...overrides };
  const run = vi.fn(), focus = vi.fn(), listeners = new Set();
  const ctx = { wb, flags: () => state, run, style: () => state.style, active: () => ({ r: 0, c: 0 }),
    range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), sheetId: () => wb.activeSheetId,
    grid: { editing: false, focus }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  ribbon = createRibbon(ctx); document.body.append(ribbon.el);
  return { state, run, wb, ctx, listeners };
}
const tab = name => [...ribbon.el.querySelectorAll('[role="tab"]')].find(b => b.textContent === name);
const button = label => ribbon.el.querySelector(`button[aria-label="${label}"]`);
const panel = () => [...ribbon.el.querySelectorAll('[role="tabpanel"]')].find(p => !p.hidden);
const enabled = () => [...panel().querySelectorAll('.tb-btn')].filter(b => !b.disabled && !b.closest('[hidden]'));
const key = (target, name) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

it('uses named groups and semantic tabs with one active panel and tab stop', () => {
  setup();
  expect([...ribbon.el.querySelectorAll('[role="tab"]')].filter(b => !b.hidden).map(b => b.textContent)).toEqual(RIBBON_TABS);
  expect([...ribbon.el.querySelectorAll('[role="tabpanel"]')].filter(p => !p.hidden)).toHaveLength(1);
  expect(tab('Home').getAttribute('aria-controls')).toBe(panel().id);
  expect(enabled().filter(b => b.tabIndex === 0)).toHaveLength(1);
  expect(panel().querySelector('[aria-label="Font"]')).not.toBeNull();
});

it('switches tabs without changing the workbook or committing a pending entry', () => {
  const { run, wb, ctx } = setup(); ctx.grid.editing = true;
  const original = wb.toJSON();
  tab('Data').click(); tab('Formulas').click(); tab('Home').click();
  expect(wb.toJSON()).toEqual(original); expect(run).not.toHaveBeenCalled();
  expect(enabled().filter(b => b.tabIndex === 0)).toHaveLength(1);
});

it('supports arrow tab navigation, Home/End and entry into controls', () => {
  setup(); tab('Home').focus(); key(tab('Home'), 'ArrowRight');
  expect(document.activeElement).toBe(tab('Insert'));
  key(tab('Insert'), 'End'); expect(document.activeElement).toBe(tab('Automate'));
  key(tab('Automate'), 'ArrowLeft'); expect(document.activeElement).toBe(tab('View'));
  key(tab('View'), 'ArrowDown'); expect(document.activeElement).toBe(enabled()[0]);
  key(document.activeElement, 'End'); expect(document.activeElement).toBe(enabled().at(-1));
  key(document.activeElement, 'Escape'); expect(document.activeElement).toBe(tab('View'));
});

it('steps back up to the Home tab with Escape from a Home command, as from any other tab', () => {
  setup(); tab('Home').focus(); key(tab('Home'), 'ArrowDown');
  key(document.activeElement, 'ArrowRight'); expect(panel().contains(document.activeElement)).toBe(true);
  key(document.activeElement, 'Escape'); expect(document.activeElement).toBe(tab('Home'));
});

it('restores Home control navigation after visiting another tab', () => {
  setup(); tab('Data').click(); tab('Home').click();
  const list = enabled(), stop = list.find(b => b.tabIndex === 0);
  expect(stop).toBeDefined(); stop.focus(); key(stop, 'End'); expect(document.activeElement).toBe(list.at(-1));
});

it('routes data controls to the existing editor commands and arguments', () => {
  const { run } = setup(); tab('Data').click();
  button('Sort Z to A').click(); expect(run).toHaveBeenLastCalledWith('sort', 'desc');
  button('Data Validation').click(); expect(run).toHaveBeenLastCalledWith('validation', null);
  button('Text to Columns').click(); expect(run).toHaveBeenLastCalledWith('splitTextDialog', null);
});

it('shows unavailable host actions disabled', () => {
  setup();
  tab('Review').click(); expect(button('Share').disabled).toBe(true);
});

it('refreshes toggle state and formula-dependent capability on selection changes', () => {
  const { state } = setup(); tab('Formulas').click();
  expect(button('Evaluate Formula').disabled).toBe(true);
  state.hasFormula = true; state.showFormulas = true; ribbon.refresh();
  expect(button('Evaluate Formula').disabled).toBe(false);
  expect(button('Show Formulas').getAttribute('aria-pressed')).toBe('true');
});

it('keeps clipboard actions disabled during an edit and live formatting enabled', () => {
  const { state, ctx } = setup(); state.editing = true; ctx.grid.editing = true; ribbon.refresh();
  expect(button('Paste').disabled).toBe(true); expect(button('Cut').disabled).toBe(true);
  expect(button('Bold').disabled).toBe(false);
});

it('opens the current freeze submenu and dispatches its real operation', () => {
  const { run } = setup(); tab('View').click(); button('Freeze Panes').click();
  const first = [...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('First row'));
  expect(first).toBeDefined(); first.click(); expect(run).toHaveBeenCalledWith('freeze', { rows: 1 });
});

it('provides a Clear menu, with Clear Formats beside Clear Contents', () => {
  const { run } = setup(); button('Clear').click();
  const clear = [...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Clear Formats'));
  expect(clear).toBeDefined(); clear.click(); expect(run).toHaveBeenCalledWith('clearFormat', null);
});

it('collapses without losing control focus, persists the setting and expands when a tab is chosen', () => {
  setup(); const first = enabled()[0]; first.focus(); button('Collapse ribbon').click();
  expect(ribbon.el.querySelector('.ribbon-panels').hidden).toBe(true);
  expect(document.activeElement).toBe(tab('Home'));
  expect(localStorage.getItem('spreadsheet:ribbon')).toBe('collapsed');
  tab('Data').click(); expect(ribbon.el.querySelector('.ribbon-panels').hidden).toBe(false);
});

it('moves along the tabs of a collapsed ribbon without expanding it or changing the setting', () => {
  setup(); button('Collapse ribbon').click();
  tab('Home').focus(); key(tab('Home'), 'ArrowRight');
  expect(document.activeElement).toBe(tab('Insert'));
  expect(tab('Insert').getAttribute('aria-selected')).toBe('true');
  expect(ribbon.el.classList.contains('ribbon-collapsed')).toBe(true);
  expect(localStorage.getItem('spreadsheet:ribbon')).toBe('collapsed');
  key(tab('Insert'), 'End'); expect(document.activeElement).toBe(tab('Automate'));
  expect(ribbon.el.classList.contains('ribbon-collapsed')).toBe(true);
  // ArrowDown, as a click, opens the chosen tab's commands.
  key(tab('Automate'), 'ArrowDown');
  expect(ribbon.el.classList.contains('ribbon-collapsed')).toBe(false);
  expect(panel().getAttribute('aria-labelledby')).toBe(tab('Automate').id);
});

it('collapses and expands on a double-click of a tab, as the collapse button says', () => {
  setup();
  const collapsed = () => ribbon.el.classList.contains('ribbon-collapsed');
  // A browser sends click (detail 1), click (detail 2), then dblclick.
  const doubleClick = t => {
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  };
  doubleClick(tab('Home')); expect(collapsed()).toBe(true);
  doubleClick(tab('Data')); expect(collapsed()).toBe(false);
  expect(tab('Data').getAttribute('aria-selected')).toBe('true');
  expect(localStorage.getItem('spreadsheet:ribbon')).toBe('expanded');
  doubleClick(tab('Data')); expect(collapsed()).toBe(true);
  tab('Home').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); expect(collapsed()).toBe(false);
});

it('removes component subscriptions on destruction', () => {
  const { listeners } = setup(); expect(listeners.size).toBe(2); ribbon.destroy(); ribbon = null;
  expect(listeners.size).toBe(0);
});

it('keeps chart-sheet tools available and restores worksheet groups when returning', () => {
  const { wb } = setup({ chartSheet: true });
  const worksheetId = wb.activeSheetId;
  const [chart] = wb.importSheets(new Workbook({ sheets: [{ name: 'Plot', kind: 'chart' }] }));
  wb.activeSheetId = chart.id; ribbon.refresh();
  expect(button('Paste').closest('[hidden]')).not.toBeNull();
  expect(enabled().map(b => b.getAttribute('aria-label'))).toContain('Edit chart');
  expect(enabled().map(b => b.getAttribute('aria-label'))).toContain('Copy chart as picture');
  wb.activeSheetId = worksheetId; ribbon.refresh();
  expect(button('Paste').closest('[hidden]')).toBeNull();
  expect(button('Bold').closest('[hidden]')).toBeNull();
});

it('keeps focus on a chart-sheet tool when the ribbon refreshes', () => {
  const { wb } = setup({ chartSheet: true });
  const [chart] = wb.importSheets(new Workbook({ sheets: [{ name: 'Plot', kind: 'chart' }] }));
  wb.activeSheetId = chart.id; ribbon.refresh();
  const fit = button('Fit chart to window');
  fit.focus(); expect(document.activeElement).toBe(fit);
  ribbon.refresh(); ribbon.refresh();
  expect(document.activeElement).toBe(fit);
});


it('exposes scrolling controls when the active ribbon overflows and keeps them out of a collapsed ribbon', () => {
  setup(); const tools = panel().querySelector('.ribbon-home');
  Object.defineProperty(tools, 'clientWidth', { value: 400 });
  Object.defineProperty(tools, 'scrollWidth', { value: 1200 });
  ribbon.refresh();
  const navigation = ribbon.el.querySelector('.ribbon-scroll-controls');
  expect(navigation.hidden).toBe(false);
  expect(button('Scroll ribbon left').getAttribute('aria-disabled')).toBe('true');
  button('Scroll ribbon right').click(); expect(tools.scrollLeft).toBe(240);
  button('Scroll ribbon right').focus(); button('Collapse ribbon').click();
  expect(navigation.hidden).toBe(true); expect(document.activeElement).toBe(tab('Home'));
});

it('offers Table only in a table context and restores the previous regular tab', () => {
  const { state } = setup(); tab('Data').click();
  expect(tab('Table').hidden).toBe(true);
  state.hasTable = true; state.table = { id: 't1', name: 'Sales', style: 'green', banded: false, firstColumn: true };
  ribbon.refresh();
  expect(tab('Table').hidden).toBe(false);
  expect(tab('Table').getAttribute('aria-selected')).toBe('true');
  expect(button('Green table style').getAttribute('aria-pressed')).toBe('true');
  expect(button('Banded Rows').getAttribute('aria-pressed')).toBe('false');
  expect(button('First Column').getAttribute('aria-pressed')).toBe('true');
  tab('Home').click(); ribbon.refresh();
  expect(tab('Home').getAttribute('aria-selected')).toBe('true');
  tab('Table').click(); button('Convert to Range').focus();
  state.hasTable = false; state.table = null; ribbon.refresh();
  expect(tab('Table').hidden).toBe(true);
  expect(tab('Home').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement.closest('[hidden]')).toBeNull();
  expect(tab('Table').tabIndex).toBe(-1);
});

it('includes the contextual tab in navigation and preserves native name editing', () => {
  const { state, run } = setup({ hasTable: true, table: { id: 't1', name: 'Sales' } });
  tab('Home').focus(); key(tab('Home'), 'End'); expect(document.activeElement).toBe(tab('Table'));
  key(tab('Table'), 'ArrowDown');
  const name = ribbon.el.querySelector('[aria-label="Table Name"]');
  expect(document.activeElement).toBe(name); expect(name.value).toBe('Sales');
  const arrow = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
  name.dispatchEvent(arrow); expect(arrow.defaultPrevented).toBe(false);
  name.value = 'Pending'; state.canUndo = true; ribbon.refresh(); expect(name.value).toBe('Pending');
  key(name, 'Escape'); expect(name.value).toBe('Sales'); expect(document.activeElement).toBe(tab('Table'));
  key(tab('Table'), 'ArrowDown'); key(name, 'ArrowDown'); expect(document.activeElement).toBe(button('Table properties'));
  expect(run).not.toHaveBeenCalled();
});

it('disables table Refresh (no query behind the table) and table mutations during editing and protection', () => {
  const { state, run } = setup({ hasTable: true, table: { id: 't1', name: 'Sales' } });
  expect(button('Refresh').disabled).toBe(true);
  for (const flags of [{ editing: true }, { editing: false, sheet: { protected: true } }]) {
    Object.assign(state, flags); ribbon.refresh();
    for (const label of ['Banded Rows', 'Total Row', 'Convert to Range', 'Blue table style', 'Table properties', 'Header Row', 'Filter Button', 'Resize Table', 'Insert Slicer']) {
      expect(button(label).disabled).toBe(true); button(label).click();
    }
    expect(ribbon.el.querySelector('[aria-label="Table Name"]').disabled).toBe(true);
  }
  expect(run).not.toHaveBeenCalled();
});

it('retains a collapsed ribbon when table context appears and skips it on chart sheets', () => {
  const { state } = setup(); button('Collapse ribbon').click();
  state.hasTable = true; state.table = { id: 't1', name: 'Sales' }; ribbon.refresh();
  expect(tab('Table').hidden).toBe(false); expect(button('Expand ribbon')).not.toBeNull();
  tab('Table').click(); expect(button('Collapse ribbon')).not.toBeNull();
  state.chartSheet = true; ribbon.refresh(); expect(tab('Table').hidden).toBe(true);
  expect(tab('Home').getAttribute('aria-selected')).toBe('true');
});

it('leaves a hidden Table tab when a chart is selected over a collapsed ribbon', () => {
  const { state, wb, ctx } = setup();
  state.hasTable = true; state.table = { id: 't1', name: 'Sales' }; ribbon.refresh();
  expect(tab('Table').getAttribute('aria-selected')).toBe('true');
  button('Collapse ribbon').click();
  ctx.grid.selectedChart = wb.addChart(wb.activeSheetId, { type: 'column', range: { r1: 0, c1: 0, r2: 2, c2: 1 }, anchor: { r: 4, c: 4 }, w: 300, h: 200 }); ribbon.refresh();
  expect(tab('Table').hidden).toBe(true); expect(tab('Chart Design').hidden).toBe(false);
  const selected = [...ribbon.el.querySelectorAll('[role="tab"]')].filter(b => b.getAttribute('aria-selected') === 'true');
  expect(selected.map(b => b.textContent)).toEqual(['Home']);
  // The tab list keeps its one tab stop, and expanding shows that tab's commands.
  expect([...ribbon.el.querySelectorAll('[role="tab"]')].filter(b => b.tabIndex === 0)).toEqual([tab('Home')]);
  button('Expand ribbon').click();
  expect(panel().getAttribute('aria-labelledby')).toBe(tab('Home').id);
});

it('offers Table Design tools: Header Row, Filter Button, Resize Table and Insert Slicer', () => {
  const { state, run } = setup({ hasTable: true, table: { id: 't1', name: 'Sales' }, tableFilterButton: true });
  const groups = [...panel().querySelectorAll('[role="group"]')].map(g => g.getAttribute('aria-label'));
  expect(groups).toEqual(expect.arrayContaining(['Properties', 'Tools', 'External Table Data', 'Table Style Options', 'Table Styles']));
  expect(button('Header Row').getAttribute('aria-pressed')).toBe('true');
  expect(button('Filter Button').getAttribute('aria-pressed')).toBe('true');
  button('Header Row').click(); expect(run).toHaveBeenLastCalledWith('tableOption', 'headerRow');
  button('Filter Button').click(); expect(run).toHaveBeenLastCalledWith('tableOption', 'filterButton');
  button('Resize Table').click(); expect(run).toHaveBeenLastCalledWith('tableResize', null);
  button('Insert Slicer').click(); expect(run).toHaveBeenLastCalledWith('insertSlicer', null);
  state.table = { id: 't1', name: 'Sales', headerRow: false }; state.tableFilterButton = false; ribbon.refresh();
  expect(button('Header Row').getAttribute('aria-pressed')).toBe('false');
  expect(button('Filter Button').disabled).toBe(true);
});

it('enables Insert ▸ Slicer in a table or PivotTable and Timeline in a PivotTable', () => {
  const { state, run } = setup(); tab('Insert').click();
  expect(button('Slicer').disabled).toBe(true); expect(button('Timeline').disabled).toBe(true);
  state.hasTable = true; state.table = { id: 't1', name: 'Sales' }; ribbon.refresh(); tab('Insert').click();
  expect(button('Slicer').disabled).toBe(false); expect(button('Timeline').disabled).toBe(true);
  state.hasTable = false; state.table = null; state.pivotReport = true; ribbon.refresh();
  expect(button('Timeline').disabled).toBe(false);
  button('Slicer').click(); expect(run).toHaveBeenLastCalledWith('insertSlicer', null);
  button('Timeline').click(); expect(run).toHaveBeenLastCalledWith('insertTimeline', null);
});
