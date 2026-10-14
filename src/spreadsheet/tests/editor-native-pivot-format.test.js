// @vitest-environment jsdom
import { Workbook } from '../src/core/workbook.js';
import { CELL_STYLES } from '../src/core/cellstyles.js';
import { borderSnapshot } from '../src/core/border-regions.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { Doc } from '../src/lib/doc.js';
import { planNativePivotReport } from '../src/core/native-pivot-report.js';
import { readNativePivotFormats } from '../src/core/native-pivot-formats.js';
import { styleToNumFmt } from '../src/core/format.js';
import { nativePivotPaintAt } from '../src/core/native-pivot-paint.js';
import * as notifications from '../src/ui/toast.js';
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function mount({ normalFont = null } = {}) {
  const doc = new Doc({ name: 'Reports', path: 'Spreadsheets/Reports.xlsx' }), wb = doc.wb, id = wb.activeSheetId;
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const xml = (tag, body, attrs = '') => `<${tag} xmlns="${main}" ${attrs}>${body}</${tag}>`;
  if (normalFont) { wb.normalFont = normalFont; wb.normalStyle = new Workbook({ normalFont }).normalStyle; }
  const source = wb.addSheet('Source');
  wb.setCells(source, [{ r: 0, c: 0, cell: { v: 'Region' } }, { r: 0, c: 1, cell: { v: 'Amount' } },
    { r: 1, c: 0, cell: { v: 'East' } }, { r: 1, c: 1, cell: { v: 3 } }, { r: 2, c: 0, cell: { v: 'West' } }, { r: 2, c: 1, cell: { v: 8 } }]);
  const cache = { key: 'c', xml: xml('pivotCacheDefinition', '<cacheSource type="worksheet"><worksheetSource sheet="Source" ref="A1:B3"/></cacheSource><cacheFields count="2"><cacheField name="Region"><sharedItems count="2"><s v="East"/><s v="West"/></sharedItems></cacheField><cacheField name="Amount"/></cacheFields>', 'recordCount="2"'), records: xml('pivotCacheRecords', '<r><x v="0"/><n v="3"/></r><r><x v="1"/><n v="8"/></r>', 'count="2"') };
  const pivot = { owner: id, cache: 'c', name: 'Summary', ref: 'D5:E8', xml: xml('pivotTableDefinition', '<location ref="D5:E8" firstHeaderRow="0" firstDataRow="1" firstDataCol="1"/><pivotFields count="2"><pivotField axis="axisRow"><items count="2"><item x="0"/><item x="1"/></items></pivotField><pivotField dataField="1"/></pivotFields><rowFields count="1"><field x="0"/></rowFields><dataFields count="1"><dataField fld="1" name="Amount"/></dataFields>', 'name="Summary" dataCaption="Values"') };
  const report = planNativePivotReport(pivot, cache);
  wb.nativePivots = { version: 1, caches: [cache], tables: [report.pivot], dxfs: [], formats: {} };
  wb.setCells(id, report.cells.map(({ r, c, value }) => ({ r, c, cell: { v: value } })));
  wb.activeSheetId = id; wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  const go = range => view.goTo(`${wb.sheet(id).name}!${range}`);
  const click = async selector => {
    // Clear Formats lives in Home ▸ Clear rather than on its own button.
    if (selector === '[data-cmd="clearFormat"]') {
      view.el.querySelector('.ribbon-home button[aria-label="Clear"]').click();
      [...document.querySelectorAll('.menu-item')].find(n => n.querySelector('.menu-label')?.textContent === 'Clear Formats').click();
    } else view.el.querySelector(selector).click();
    await vi.advanceTimersByTimeAsync(1);
  };
  const paint = (r, c) => nativePivotPaintAt(planNativePivotReport(wb.nativePivots.tables[0], cache, { nativePivots: wb.nativePivots, paintContext: {} }).formatPaintLayers || [], r, c);
  return { wb, id, go, click, paint };
}
it('formats native labels/values and ordinary cells from the toolbar in one undo step', async () => {
  const { wb, id, go, click, paint } = await mount(); go('D6:F7'); const before = wb.toJSON();
  await click('[data-cmd="italic"]');
  for (let r = 5; r <= 6; r++) for (let c = 3; c <= 5; c++) expect(wb.styleAt(id, r, c).italic).toBe(true);
  expect(paint(5, 3)).toEqual({ italic: true }); expect(paint(6, 4)).toEqual({ italic: true }); expect(paint(7, 4)).toEqual({});
  expect(wb.undoLabels()).toEqual(['Format pivot reports']);
  const after = wb.toJSON(); wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
});
it('retains named number-format settings when a toolbar button authors native rules', async () => {
  const { wb, id, go, click, paint } = await mount(); go('E6:E7');
  await click('[data-cmd="fmt"][data-arg="percent"]');
  for (const r of [5, 6]) { expect(wb.styleAt(id, r, 4)).toMatchObject({ fmt: 'percent', dec: 0 }); expect(paint(r, 4)).toEqual({ fmt: 'custom', code: styleToNumFmt(wb.styleAt(id, r, 4)) }); }
  expect(wb.getValue(id, 5, 4)).toBe(3); expect(wb.getValue(id, 6, 4)).toBe(8);
});
it('omits filtered rows from both cell edits and semantic rules', async () => {
  const { wb, id, go, click, paint } = await mount(); wb.sheet(id).filterHidden.add(5); go('D6:F7');
  await click('[data-cmd="italic"]');
  expect(wb.styleAt(id, 5, 3)?.italic).toBeUndefined(); expect(paint(5, 3)).toEqual({});
  expect(wb.styleAt(id, 6, 3).italic).toBe(true); expect(paint(6, 3)).toEqual({ italic: true });
  expect(wb.getCell(id, 5, 5)).toBeUndefined(); expect(wb.styleAt(id, 6, 5).italic).toBe(true);
});
it('reports an unsupported native selection without partially formatting ordinary cells', async () => {
  const { wb, go, click } = await mount(); go('D6:F8'); const before = wb.toJSON(), native = wb.nativePivots;
  const toast = vi.spyOn(notifications, 'toast'); await click('[data-cmd="italic"]');
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.any(Object));
  expect(wb.toJSON()).toEqual(before); expect(wb.nativePivots).toBe(native); expect(wb.undoLabels()).toEqual([]);
});
it('keeps an active cell edit open while recording keyboard formatting in native rules', async () => {
  const { wb, id, go, paint } = await mount(); go('E6');
  const viewport = view.el.querySelector('.grid-viewport'); viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '9', bubbles: true, cancelable: true }));
  const input = view.el.querySelector('.grid-editor');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.styleAt(id, 5, 4).bold).toBe(true); expect(paint(5, 4)).toEqual({ bold: true });
  expect(wb.getValue(id, 5, 4)).toBe(3); expect(input.value).toBe('9'); expect(document.activeElement).toBe(input);
});
it('keeps ordinary formatting outside native reports on its existing path', async () => {
  const { wb, id, go, click } = await mount(); go('A1:B2'); const native = wb.nativePivots;
  await click('[data-cmd="italic"]'); expect(wb.styleAt(id, 0, 0).italic).toBe(true);
  expect(wb.nativePivots).toBe(native); expect(readNativePivotFormats(native.tables[0], native)).toEqual([]);
});
it('preflights protected cells before recording native rules or any ordinary-cell styles', async () => {
  const { wb, id, go, click } = await mount();
  wb.sheet(id).protectedRanges.push({ range: { r1: 6, r2: 6, c1: 5, c2: 5 } });
  go('D6:F7'); const before = wb.toJSON(), native = wb.nativePivots;
  const toast = vi.spyOn(notifications, 'toast'); await click('[data-cmd="italic"]');
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/protected/i), expect.objectContaining({ icon: 'lock' }));
  expect(wb.toJSON()).toEqual(before); expect(wb.nativePivots).toBe(native); expect(wb.undoLabels()).toEqual([]);
});
it('steps heterogeneous native and ordinary decimal formats together with undo and redo', async () => {
  const { wb, id, go, click, paint } = await mount();
  wb.applyStyle(id, { r1: 5, r2: 5, c1: 4, c2: 4 }, { fmt: 'percent', dec: 2, bold: true });
  wb.applyStyle(id, { r1: 6, r2: 6, c1: 4, c2: 4 }, { fmt: 'currency', cur: 'JPY' });
  wb.setInput(id, 5, 5, '1.5'); wb.setInput(id, 6, 5, '7');
  wb.clearHistory(); go('E6:F7'); const before = wb.toJSON();
  await click('[aria-label="More decimal places"]');
  expect(wb.styleAt(id, 5, 4)).toMatchObject({ fmt: 'percent', dec: 3, bold: true });
  expect(wb.styleAt(id, 6, 4)).toMatchObject({ fmt: 'currency', cur: 'JPY', dec: 1 });
  expect(wb.styleAt(id, 5, 5)).toMatchObject({ fmt: 'number', dec: 2 });
  expect(wb.styleAt(id, 6, 5)).toMatchObject({ fmt: 'number', dec: 1 });
  for (const r of [5, 6]) expect(paint(r, 4)).toEqual({ fmt: 'custom', code: styleToNumFmt(wb.styleAt(id, r, 4)) });
  expect(paint(7, 4)).toEqual({}); expect(wb.undoLabels()).toHaveLength(1);
  const after = wb.toJSON(); wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
  await click('[aria-label="Fewer decimal places"]');
  expect(wb.styleAt(id, 5, 4).dec).toBe(2); expect(wb.styleAt(id, 6, 4).dec).toBe(0);
});
it('skips fixed formats and filtered rows without adding native decimal rules for them', async () => {
  const { wb, id, go, click, paint } = await mount();
  wb.applyStyle(id, { r1: 7, r2: 7, c1: 4, c2: 4 }, { fmt: 'custom', code: '0.00' });
  wb.sheet(id).filterHidden.add(6); wb.clearHistory(); go('E6:E8');
  await click('[aria-label="More decimal places"]');
  expect(wb.styleAt(id, 5, 4)).toMatchObject({ fmt: 'number', dec: 1 });
  expect(paint(5, 4)).toEqual({ fmt: 'custom', code: styleToNumFmt(wb.styleAt(id, 5, 4)) });
  expect(paint(6, 4)).toEqual({}); expect(paint(7, 4)).toEqual({});
  expect(wb.styleAt(id, 7, 4)).toMatchObject({ fmt: 'custom', code: '0.00' });
});
it('rejects decimal edits atomically when a changed total cannot be represented', async () => {
  const { wb, go, click } = await mount(); go('E6:F8'); const before = wb.toJSON();
  const toast = vi.spyOn(notifications, 'toast'); await click('[aria-label="More decimal places"]');
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.any(Object));
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});
it('does not create native rules or undo entries when decimals are already at zero', async () => {
  const { wb, id, go, click } = await mount();
  wb.applyStyle(id, { r1: 5, r2: 6, c1: 4, c2: 4 }, { fmt: 'number', dec: 0 });
  wb.clearHistory(); go('E6:E7'); const before = wb.toJSON();
  await click('[aria-label="Fewer decimal places"]');
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});
it('steps each native and ordinary cell indent without replacing unrelated formatting', async () => {
  const { wb, id, go, click, paint } = await mount();
  wb.applyStyle(id, { r1: 5, r2: 5, c1: 3, c2: 3 }, { indent: 2, italic: true });
  wb.applyStyle(id, { r1: 6, r2: 6, c1: 3, c2: 3 }, { indent: 9 });
  wb.applyStyle(id, { r1: 5, r2: 6, c1: 5, c2: 5 }, { indent: 4 });
  wb.clearHistory(); go('D6:F7'); const before = wb.toJSON();
  await click('[aria-label="Increase indent"]');
  expect(wb.styleAt(id, 5, 3)).toMatchObject({ indent: 3, italic: true });
  expect(wb.styleAt(id, 6, 3).indent).toBe(10); expect(wb.styleAt(id, 5, 5).indent).toBe(5);
  expect(paint(5, 3)).toEqual({ indent: 3 }); expect(paint(6, 3)).toEqual({ indent: 10 });
  expect(paint(5, 4)).toEqual({ indent: 1 }); expect(paint(7, 3)).toEqual({});
  expect(wb.undoLabels()).toHaveLength(1); const after = wb.toJSON();
  wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
  await click('[aria-label="Decrease indent"]');
  expect(wb.styleAt(id, 5, 3).indent).toBe(2); expect(wb.styleAt(id, 6, 3).indent).toBe(9);
  expect(wb.styleAt(id, 5, 4)?.indent ?? 0).toBe(0); expect(paint(5, 4)).toEqual({ indent: 0 });
});
it('excludes filtered report rows and cells already at the indent limit', async () => {
  const { wb, id, go, click, paint } = await mount();
  wb.applyStyle(id, { r1: 5, r2: 5, c1: 4, c2: 4 }, { indent: 10 });
  wb.sheet(id).filterHidden.add(6); wb.clearHistory(); go('D6:E7');
  await click('[aria-label="Increase indent"]');
  expect(paint(5, 3)).toEqual({ indent: 1 }); expect(paint(5, 4)).toEqual({});
  expect(paint(6, 3)).toEqual({}); expect(paint(6, 4)).toEqual({});
  expect(wb.styleAt(id, 5, 4).indent).toBe(10); expect(wb.styleAt(id, 6, 3)?.indent).toBeUndefined();
});
it('leaves mixed selections unchanged when a total indent cannot be represented', async () => {
  const { wb, go, click } = await mount(); go('D6:F8'); const before = wb.toJSON();
  const toast = vi.spyOn(notifications, 'toast'); await click('[aria-label="Increase indent"]');
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.any(Object));
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});
it('keeps pending cell text open when a toolbar indent authors native formatting', async () => {
  const { wb, id, go, click, paint } = await mount(); go('E6');
  const viewport = view.el.querySelector('.grid-viewport'); viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '9', bubbles: true, cancelable: true }));
  await click('[aria-label="Increase indent"]');
  expect(wb.getValue(id, 5, 4)).toBe(3); expect(paint(5, 4)).toEqual({ indent: 1 });
  const input = view.el.querySelector('.grid-editor');
  expect(input.value).toBe('9'); expect(document.activeElement).toBe(input);
});

async function formatCommand(group, label) {
  view.el.querySelector('[data-menu="format"]').click();
  for (const name of [group, label]) {
    [...document.querySelectorAll('.menu-item')].find(el => el.querySelector('.menu-label')?.textContent === name).click();
    await vi.advanceTimersByTimeAsync(1);
  }
}
const textCommand = label => formatCommand('Text', label);
// Sizes are typed in points and stored in pixels (a point is 4/3 px).
const pt = points => points * 4 / 3;
async function customSize(px) {
  await textCommand('Custom font size…');
  const input = document.querySelector('[aria-label="Font size"]'); input.value = String(px * 3 / 4);
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(5);
}
it('steps native and ordinary font sizes and row heights in one undo operation', async () => {
  const { wb, id, go, paint } = await mount();
  wb.applyStyle(id, { r1: 5, r2: 5, c1: 3, c2: 3 }, { size: 24, bold: true });
  wb.applyStyle(id, { r1: 6, r2: 6, c1: 3, c2: 3 }, { size: 36 });
  wb.applyStyle(id, { r1: 5, r2: 5, c1: 5, c2: 5 }, { size: 48 });
  wb.clearHistory(); go('D6:F7'); const before = wb.toJSON();
  await textCommand('Larger font');
  expect(wb.styleAt(id, 5, 3)).toMatchObject({ size: pt(20), bold: true });
  expect(wb.styleAt(id, 6, 3).size).toBe(pt(28)); expect(wb.styleAt(id, 5, 4).size).toBe(pt(10));
  expect(paint(5, 3)).toEqual({ size: pt(20) }); expect(paint(6, 3)).toEqual({ size: pt(28) });
  expect(wb.styleAt(id, 5, 5).size).toBe(pt(48));
  expect(wb.rowHeight(id, 5)).toBeGreaterThanOrEqual(Math.ceil(pt(48) * 1.35) + 8);
  expect(wb.rowHeight(id, 6)).toBeGreaterThanOrEqual(Math.ceil(pt(28) * 1.35) + 8);
  expect(wb.undoLabels()).toEqual(['Font size']); const after = wb.toJSON();
  wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
  const height = wb.rowHeight(id, 5); await textCommand('Smaller font');
  expect(paint(5, 4)).toEqual({ size: pt(9) }); expect(wb.styleAt(id, 5, 4)?.size).toBe(pt(9));
  expect(wb.rowHeight(id, 5)).toBeGreaterThanOrEqual(height);
});
it('applies a fractional custom size and preserves row sizing modes', async () => {
  const { wb, id, go, paint } = await mount();
  wb.setRowHeight(id, 5, 20, { auto: true }); wb.setRowHeight(id, 6, 20);
  wb.clearHistory(); go('D6:F7'); const before = wb.toJSON(); await customSize(25.5);
  for (const r of [5, 6]) for (const c of [3, 4, 5]) expect(wb.styleAt(id, r, c).size).toBe(25.5);
  expect(paint(5, 3)).toEqual({ size: 25.5 }); expect(paint(6, 4)).toEqual({ size: 25.5 });
  expect(wb.sheet(id).rowHeightModes.get(5)).toBe('auto'); expect(wb.sheet(id).rowHeightModes.get(6)).toBe('fixed');
  expect(wb.rowHeight(id, 6)).toBeGreaterThanOrEqual(Math.ceil(25.5 * 1.35) + 8);
  expect(wb.undoLabels()).toEqual(['Font size']); wb.undo(); expect(wb.toJSON()).toEqual(before);
});
it('excludes filtered rows from native font rules and height growth', async () => {
  const { wb, id, go, paint } = await mount(); wb.sheet(id).filterHidden.add(6);
  const height = wb.rowHeight(id, 6); go('D6:F7'); await customSize(36);
  expect(paint(5, 3)).toEqual({ size: 36 }); expect(paint(6, 3)).toEqual({});
  expect(wb.styleAt(id, 6, 3)?.size).toBeUndefined(); expect(wb.rowHeight(id, 6)).toBe(height);
});
it.each(['step', 'custom'])('leaves styles and row heights unchanged when native font %s fails', async mode => {
  const { wb, go } = await mount(); go('D6:F8'); const before = wb.toJSON();
  const toast = vi.spyOn(notifications, 'toast');
  if (mode === 'step') await textCommand('Larger font'); else await customSize(36);
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.any(Object));
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});
it('does not resize rows or add native rules when every font is already at the step limit', async () => {
  const { wb, id, go } = await mount();
  wb.applyStyle(id, { r1: 5, r2: 6, c1: 3, c2: 4 }, { size: pt(72) });
  wb.clearHistory(); go('D6:E7'); const before = wb.toJSON(); await textCommand('Larger font');
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});

it('steps native font size down over inherited column formatting', async () => {
  const { wb, id, go, paint } = await mount(); wb.sheet(id).colStyles.set(3, { size: 24, bold: true });
  wb.applyStyle(id, { r1: 5, r2: 6, c1: 3, c2: 3 }, { size: 14 });
  go('D6:D7'); await textCommand('Smaller font');
  for (const r of [5, 6]) {
    expect(wb.styleAt(id, r, 3)).toMatchObject({ bold: true });
    expect(wb.styleAt(id, r, 3).size).toBe(pt(10)); expect(paint(r, 3)).toEqual({ size: pt(10) });
  }
});
it('keeps pending cell text open while custom native font sizing grows its row', async () => {
  const { wb, id, go, paint } = await mount(); go('E6');
  const viewport = view.el.querySelector('.grid-viewport'); viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '9', bubbles: true, cancelable: true }));
  await customSize(36);
  expect(wb.getValue(id, 5, 4)).toBe(3); expect(paint(5, 4)).toEqual({ size: 36 });
  expect(wb.rowHeight(id, 5)).toBeGreaterThanOrEqual(Math.ceil(36 * 1.35) + 8);
  const input = view.el.querySelector('.grid-editor'); expect(input.value).toBe('9'); expect(document.activeElement).toBe(input);
});

it('toggles native wrapping with ordinary cells and row fitting in one undo step', async () => {
  const { wb, id, go, click, paint } = await mount();
  wb.setInput(id, 5, 5, 'first line\nsecond line\nthird line');
  wb.applyStyle(id, { r1: 5, r2: 5, c1: 5, c2: 5 }, { wrap: null });
  wb.clearHistory(); go('D6:F7'); const before = wb.toJSON(), height = wb.rowHeight(id, 5);
  await click('[data-cmd="wrap"]');
  expect(paint(5, 3)).toEqual({ wrap: true }); expect(paint(6, 4)).toEqual({ wrap: true });
  expect(wb.styleAt(id, 5, 5).wrap).toBe(true); expect(wb.rowHeight(id, 5)).toBeGreaterThan(height);
  expect(wb.undoLabels()).toHaveLength(1); const after = wb.toJSON();
  wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
  await click('[data-cmd="wrap"]'); expect(paint(5, 3)).toEqual({ wrap: false });
  expect(wb.styleAt(id, 5, 5)?.wrap).toBeUndefined();
});
it('switches native wrapping menu modes and clears cell-only clipping', async () => {
  const { wb, id, go, paint } = await mount();
  wb.applyStyle(id, { r1: 5, r2: 6, c1: 3, c2: 5 }, { clip: true }); go('D6:F7');
  await formatCommand('Wrapping', 'Wrap');
  for (const r of [5, 6]) for (const c of [3, 4, 5]) {
    expect(wb.styleAt(id, r, c).wrap).toBe(true); expect(wb.styleAt(id, r, c).clip).toBeUndefined();
  }
  expect(paint(5, 3)).toEqual({ wrap: true });
  await formatCommand('Wrapping', 'Overflow'); expect(paint(5, 3)).toEqual({ wrap: false });
  expect(wb.styleAt(id, 5, 3)?.wrap).toBeUndefined();
});
it.each([45, -45, 90, -90])('rotates native and ordinary cells by %s degrees and records an explicit reset', async angle => {
  const { wb, id, go, paint } = await mount();
  wb.setInput(id, 5, 5, 'A long ordinary label alongside the native report');
  wb.clearHistory(); go('D6:F7'); const before = wb.toJSON();
  const label = { 45: 'Tilt up (45°)', '-45': 'Tilt down (−45°)', 90: 'Rotate up (90°)', '-90': 'Rotate down (−90°)' }[angle];
  await formatCommand('Rotation', label);
  expect(paint(5, 3)).toEqual({ rot: angle }); expect(paint(6, 4)).toEqual({ rot: angle });
  expect(wb.styleAt(id, 5, 5).rot).toBe(angle); expect(wb.undoLabels()).toHaveLength(1);
  const after = wb.toJSON(); wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
  await formatCommand('Rotation', 'None'); expect(paint(5, 3)).toEqual({ rot: 0 }); expect(wb.styleAt(id, 5, 5)?.rot).toBeUndefined();
});
it.each(['wrap', 'rotate', 'clip'])('rejects unsupported native %s edits without changing cells or row heights', async mode => {
  const { wb, go, click } = await mount(); go(mode === 'clip' ? 'D6:F7' : 'D6:F8'); const before = wb.toJSON();
  const toast = vi.spyOn(notifications, 'toast');
  if (mode === 'wrap') await click('[data-cmd="wrap"]');
  else if (mode === 'clip') await formatCommand('Wrapping', 'Clip');
  else await formatCommand('Rotation', 'Tilt up (45°)');
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.any(Object));
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});
it('excludes filtered rows from wrapping, rotation and row fitting', async () => {
  const { wb, id, go, paint } = await mount(); wb.sheet(id).filterHidden.add(6);
  const height = wb.rowHeight(id, 6); go('D6:F7');
  await formatCommand('Wrapping', 'Wrap'); await formatCommand('Rotation', 'Tilt down (−45°)');
  expect(paint(5, 3)).toEqual({ wrap: true, rot: -45 }); expect(paint(6, 3)).toEqual({});
  expect(wb.styleAt(id, 6, 3)?.wrap).toBeUndefined(); expect(wb.styleAt(id, 6, 3)?.rot).toBeUndefined();
  expect(wb.rowHeight(id, 6)).toBe(height);
});
it('applies outer, inner and cleared borders across native and ordinary cells with undo', async () => {
  const { wb, id, go, paint } = await mount(); go('D6:F7'); const before = wb.toJSON();
  await formatCommand('Borders', 'Outer borders');
  expect(paint(5, 3)).toMatchObject({ bt: true, bl: true }); expect(paint(5, 3).br).toBeUndefined();
  expect(paint(5, 4)).toMatchObject({ bt: true }); expect(paint(5, 4).br).toBeUndefined();
  expect(paint(6, 4)).toMatchObject({ bb: true }); expect(wb.styleAt(id, 5, 5)).toMatchObject({ bt: true, br: true });
  expect(wb.undoLabels()).toHaveLength(1); const after = wb.toJSON();
  wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
  await formatCommand('Borders', 'Inner borders');
  for (const r of [5, 6]) for (const c of [3, 4]) expect(paint(r, c)).toMatchObject({ bt: true, bb: true, bl: true, br: true });
  await formatCommand('Borders', 'No borders');
  for (const r of [5, 6]) for (const c of [3, 4]) expect(paint(r, c)).toMatchObject({ bt: false, bb: false, bl: false, br: false });
  expect(wb.styleAt(id, 5, 5)?.bt).toBeUndefined(); expect(paint(7, 3)).toEqual({});
});
it('uses each visible row run as the border perimeter when rows are filtered', async () => {
  const { wb, id, go, paint } = await mount(); wb.sheet(id).filterHidden.add(6); go('D6:F7');
  await formatCommand('Borders', 'Outer borders');
  expect(paint(5, 3)).toMatchObject({ bt: true, bb: true, bl: true });
  expect(paint(5, 4)).toMatchObject({ bt: true, bb: true }); expect(paint(6, 3)).toEqual({});
  expect(wb.styleAt(id, 6, 3)?.bt).toBeUndefined(); expect(wb.getCell(id, 6, 5)).toBeUndefined();
});
it.each(['total', 'merge'])('reports an unsupported native border selection without partial writes (%s)', async problem => {
  const { wb, id, go } = await mount();
  if (problem === 'merge') wb.mergeCells(id, { r1: 5, r2: 6, c1: 5, c2: 5 });
  wb.clearHistory(); go(problem === 'total' ? 'D6:F8' : 'D6:F7'); const before = wb.toJSON();
  const toast = vi.spyOn(notifications, 'toast'); await formatCommand('Borders', 'All borders');
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.any(Object));
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});
it('keeps a pending edit open while applying native borders', async () => {
  const { wb, id, go, paint } = await mount(); go('E6');
  const viewport = view.el.querySelector('.grid-viewport'); viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '9', bubbles: true, cancelable: true }));
  await formatCommand('Borders', 'All borders');
  expect(wb.getValue(id, 5, 4)).toBe(3); expect(paint(5, 4)).toMatchObject({ bt: true, bb: true, bl: true, br: true });
  const input = view.el.querySelector('.grid-editor'); expect(input.value).toBe('9'); expect(document.activeElement).toBe(input);
});

it.each(CELL_STYLES)('applies the $label cell style to native and ordinary cells atomically', async preset => {
  const { wb, id, go, paint } = await mount(); const range = { r1: 5, r2: 6, c1: 3, c2: 5 };
  wb.applyStyle(id, range, { italic: true, size: 24, bt: true, bc: '#123456' }); wb.clearHistory(); go('D6:F7');
  const before = wb.toJSON(), reference = new Workbook(before);
  reference.applyStyle(id, range, preset.patch);
  for (const b of preset.borders || []) reference.applyBorders(id, range, b.kind, { color: b.color ?? null, style: b.style ?? 'thin' });
  await formatCommand('Cell styles', preset.label);
  for (let r = 5; r <= 6; r++) for (let c = 3; c <= 5; c++) {
    const actual = wb.styleAt(id, r, c), expected = reference.styleAt(id, r, c);
    for (const key of ['bold', 'italic', 'underline', 'strike', 'color', 'bg', 'size']) expect(actual?.[key] ?? null).toEqual(expected?.[key] ?? null);
    expect(borderSnapshot(actual)).toEqual(borderSnapshot(expected));
  }
  expect(Object.keys(paint(5, 3)).length).toBeGreaterThan(0); expect(paint(7, 3)).toEqual({});
  expect(wb.undoLabels()).toHaveLength(1); const after = wb.toJSON();
  wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
});
async function applyCombinedDialog() {
  view.el.querySelector('[data-menu="format"]').click();
  [...document.querySelectorAll('.menu-item')].find(el => el.querySelector('.menu-label')?.textContent === 'Format Cells…').click();
  await vi.advanceTimersByTimeAsync(1);
  const category = document.querySelector('select[aria-label="Category"]'); category.value = 'percent'; category.dispatchEvent(new Event('change'));
  const decimals = document.querySelector('input[aria-label="Decimal places"]'); decimals.value = '1'; decimals.dispatchEvent(new Event('input'));
  [...document.querySelectorAll('.modal-panel label')].find(el => el.textContent.trim() === 'Italic').querySelector('input').click();
  [...document.querySelectorAll('[aria-label="Border presets"] button')].find(b => b.textContent === 'Outline').click();
  document.querySelector('form.fc-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.advanceTimersByTimeAsync(5);
}
it('applies a combined number/font/border dialog edit with native rules and one undo', async () => {
  const { wb, id, go, paint } = await mount(); go('D6:F7'); const before = wb.toJSON();
  await applyCombinedDialog();
  expect(wb.styleAt(id, 5, 4)).toMatchObject({ fmt: 'percent', dec: 1, italic: true });
  expect(wb.styleAt(id, 5, 5)).toMatchObject({ fmt: 'percent', dec: 1, italic: true, br: true });
  expect(paint(5, 3)).toMatchObject({ fmt: 'custom', code: '#,##0.0%', italic: true, bt: true, bl: true });
  expect(paint(5, 4).br).toBeUndefined(); expect(wb.getValue(id, 5, 4)).toBe(3);
  expect(wb.undoLabels()).toHaveLength(1); const after = wb.toJSON();
  wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
});
it('leaves all dialog edits unapplied when the final native border selection is unsupported', async () => {
  const { wb, go } = await mount(); go('D6:F8'); const before = wb.toJSON();
  const toast = vi.spyOn(notifications, 'toast'); await applyCombinedDialog();
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.any(Object));
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});
it('excludes filtered rows from combined dialog styles and border geometry', async () => {
  const { wb, id, go, paint } = await mount(); wb.sheet(id).filterHidden.add(6); go('D6:F7');
  await applyCombinedDialog(); expect(paint(5, 3)).toMatchObject({ italic: true, bt: true, bb: true, bl: true });
  expect(paint(6, 3)).toEqual({}); expect(wb.styleAt(id, 6, 3)?.italic).toBeUndefined();
  expect(wb.getCell(id, 6, 5)).toBeUndefined();
});

it('clears native and ordinary formatting from the toolbar with one undo step', async () => {
  const { wb, id, go, click, paint } = await mount({ normalFont: { name: 'Arial', sz: 12 } });
  const range = { r1: 5, r2: 6, c1: 3, c2: 5 };
  wb.sheet(id).colStyles.set(4, { bold: true, bg: '#ff0000' });
  go('D6:F7'); await click('[data-cmd="italic"]'); wb.clearHistory();
  const before = wb.toJSON(), reference = new Workbook(before);
  reference.clearRange(id, range, { contents: false, styles: true });
  await click('[data-cmd="clearFormat"]');
  for (let r = 5; r <= 6; r++) for (let c = 3; c <= 5; c++) expect(wb.styleAt(id, r, c)).toEqual(reference.styleAt(id, r, c));
  expect(paint(5, 3)).toMatchObject({ italic: false, bold: false, bg: 'transparent', font: 'arial', size: 16, code: 'General' });
  expect(paint(7, 4)).toEqual({}); expect(wb.getValue(id, 5, 4)).toBe(3);
  expect(wb.undoLabels()).toHaveLength(1); const after = wb.toJSON();
  wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
});
it('keeps filtered cells and their native paint when clearing visible formatting', async () => {
  const { wb, id, go, click, paint } = await mount({ normalFont: { name: 'Arial', sz: 12 } });
  go('D6:F7'); await click('[data-cmd="italic"]'); wb.sheet(id).filterHidden.add(6);
  await click('[data-cmd="clearFormat"]');
  expect(paint(5, 3).italic).toBe(false); expect(paint(6, 3).italic).toBe(true);
  expect(wb.styleAt(id, 6, 4).italic).toBe(true); expect(wb.styleAt(id, 5, 4).italic).toBeUndefined();
});
it('rejects an unresolved native clear default without partially clearing ordinary cells', async () => {
  const { wb, go, click } = await mount(); go('D6:F7'); await click('[data-cmd="italic"]'); wb.clearHistory();
  const before = wb.toJSON(), toast = vi.spyOn(notifications, 'toast');
  // Home ▸ Clear ▸ Clear Formats.
  await click('.ribbon-home button[aria-label="Clear"]');
  [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === 'Clear Formats').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.any(Object));
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
});

it('paints a tiled source block onto native and ordinary cells with one undo step', async () => {
  const { wb, id, go, click, paint } = await mount({ normalFont: { name: 'Arial', sz: 12 } });
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Format', s: { bold: true, bg: '#ffeecc', bt: true } } }]);
  go('A1'); await click('[data-cmd="paintFormat"]'); go('D6:F7');
  const before = wb.toJSON(), reference = new Workbook(before), range = { r1: 5, r2: 6, c1: 3, c2: 5 };
  reference.pasteStyles(id, wb.copyRange(id, { r1: 0, r2: 0, c1: 0, c2: 0 }), 5, 3, range); wb.clearHistory();
  await click('[data-cmd="paintFormat"]');
  for (let r = 5; r <= 6; r++) for (let c = 3; c <= 5; c++) expect(wb.getCell(id, r, c)).toEqual(reference.getCell(id, r, c));
  expect(paint(5, 3)).toMatchObject({ bold: true, bg: '#ffeecc', bt: true, italic: false });
  expect(view.el.querySelector('.grid').classList.contains('painting')).toBe(false);
  expect(wb.undoLabels()).toHaveLength(1); const after = wb.toJSON();
  wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
});
it('detects native cells reached beyond a non-multiple painter target', async () => {
  const { wb, id, go, click, paint } = await mount({ normalFont: { name: 'Arial', sz: 12 } });
  wb.setCells(id, [0, 1].flatMap(r => [0, 1].map(c => ({ r, c, cell: { v: r + c, s: { italic: true } } }))));
  go('A1:B2'); await click('[data-cmd="paintFormat"]'); go('C6:C7');
  await click('[data-cmd="paintFormat"]');
  expect(paint(5, 3).italic).toBe(true); expect(paint(6, 3).italic).toBe(true); expect(paint(5, 4)).toEqual({});
  expect(wb.styleAt(id, 5, 2).italic).toBe(true);
});
it('does not claim painter success or partially modify cells after a native rejection', async () => {
  const { wb, id, go, click } = await mount({ normalFont: { name: 'Arial', sz: 12 } });
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Format', s: { italic: true } } }]);
  go('A1'); await click('[data-cmd="paintFormat"]'); go('D6:F8'); wb.clearHistory();
  const before = wb.toJSON(), toast = vi.spyOn(notifications, 'toast');
  await click('[data-cmd="paintFormat"]');
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
  expect(toast).not.toHaveBeenCalledWith('Formatting painted', expect.anything());
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.anything());
  expect(view.el.querySelector('.grid').classList.contains('painting')).toBe(false);
});

async function clipboardFormatCommand() {
  view.el.querySelector('[data-menu="edit"]').click();
  [...document.querySelectorAll('.menu-item')].find(el => el.querySelector('.menu-label')?.textContent === 'Paste special').click();
  [...document.querySelectorAll('.menu-item')].find(el => el.querySelector('.menu-label')?.textContent === 'Formatting only').click();
  await vi.advanceTimersByTimeAsync(20);
}
it('pastes internal clipboard formats and conditional rules into a native selection', async () => {
  let text = '';
  vi.stubGlobal('navigator', { onLine: true, clipboard: { writeText: async value => { text = value; }, readText: async () => text } });
  const { wb, id, go, paint } = await mount({ normalFont: { name: 'Arial', sz: 12 } });
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Copied', s: { italic: true, bg: '#ffeecc' } } }]);
  wb.addRule(id, { range: { r1: 0, r2: 0, c1: 0, c2: 0 }, type: 'formula', value: 'A1>2', style: { bold: true } });
  go('A1'); view.el.querySelector('[data-menu="edit"]').click();
  [...document.querySelectorAll('.menu-item')].find(el => el.querySelector('.menu-label')?.textContent === 'Copy').click();
  await vi.advanceTimersByTimeAsync(20); go('D6:F7'); wb.clearHistory(); const before = wb.toJSON();
  await clipboardFormatCommand();
  expect(paint(5, 3)).toMatchObject({ italic: true, bg: '#ffeecc', font: 'arial' });
  expect(wb.sheet(id).rules.some(rule => rule.value === 'D6>2')).toBe(true);
  expect(wb.getValue(id, 5, 4)).toBe(3); expect(wb.undoLabels()).toHaveLength(1);
  const after = wb.toJSON(); wb.undo(); expect(wb.toJSON()).toEqual(before); wb.redo(); expect(wb.toJSON()).toEqual(after);
});
it('pastes external HTML formatting into native cells while retaining their values', async () => {
  const html = '<table><tr><td style="font-family:Arial;font-size:12pt;font-style:italic;background:#ffeecc">99</td></tr></table>';
  vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
  const { wb, id, go, paint } = await mount({ normalFont: { name: 'Arial', sz: 12 } }); go('D6:F7'); wb.clearHistory();
  await clipboardFormatCommand();
  expect(paint(5, 3)).toMatchObject({ italic: true, font: 'arial', size: 16, bg: '#ffeecc' });
  expect(wb.getValue(id, 5, 4)).toBe(3); expect(wb.getValue(id, 6, 4)).toBe(8); expect(wb.undoLabels()).toHaveLength(1);
});
it('refuses incoming HTML report merges without applying styles or changing selection', async () => {
  const html = '<table><tr><td rowspan="2" style="font-family:Arial;font-size:12pt;font-style:italic">99</td></tr><tr></tr></table>';
  vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
  const { wb, go } = await mount({ normalFont: { name: 'Arial', sz: 12 } }); go('D6'); wb.clearHistory();
  const before = wb.toJSON(), toast = vi.spyOn(notifications, 'toast'); await clipboardFormatCommand();
  expect(wb.toJSON()).toEqual(before); expect(wb.undoLabels()).toEqual([]);
  expect(view.el.querySelector('.grid-viewport').getAttribute('aria-activedescendant')).toBe('gc-5-3');
  expect(toast).toHaveBeenCalledWith('This formatting cannot be applied to the selected part of the pivot table', expect.anything());
});
