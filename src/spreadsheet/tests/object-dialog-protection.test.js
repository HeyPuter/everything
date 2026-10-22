// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { defaultChart } from '../src/core/charts.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { openTextBoxDialog } from '../src/ui/textboxdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each(['chart', 'text'].flatMap((kind) => ['insert', 'edit', 'delete'].map((action) => [kind, action])))('retains the %s dialog when protection blocks %s', (kind, action) => {
  const wb = new Workbook();
  const sheetId = wb.activeSheetId;
  const range = { r1: 0, c1: 0, r2: 1, c2: 1 };
  wb.setInput(sheetId, 0, 0, 'Category');
  wb.setInput(sheetId, 0, 1, 'Value');
  wb.setInput(sheetId, 1, 0, 'A');
  wb.setInput(sheetId, 1, 1, '1');
  const spec = kind === 'chart' ? { ...defaultChart(range, { r: 0, c: 2 }), title: 'Original' }
    : { type: 'text', text: 'Original', anchor: { r: 0, c: 2 } };
  const id = action !== 'insert' ? wb.addChart(sheetId, spec) : null;
  const original = wb.sheet(sheetId).charts;
  const ctx = {
    wb, sheetId: () => sheetId, active: () => ({ r: 0, c: 0 }), range: () => range,
    grid: { focus: vi.fn(), selectChart: vi.fn() },
    run: (cmd, arg) => { if (cmd === 'deleteChart') wb.deleteChart(sheetId, arg?.id || arg); },
  };
  const object = id ? wb.chartById(sheetId, id) : null;
  const modal = kind === 'chart' ? openChartDialog(ctx, { chart: object }) : openTextBoxDialog(ctx, { textbox: object });
  const field = modal.panel.querySelector(kind === 'chart' ? '[aria-label="Title"]' : 'textarea');
  field.value = 'Draft';
  wb.setSheetProtected(sheetId, true);
  wb.clearHistory();
  const before = wb.toJSON();
  const submit = () => {
    if (action === 'delete') [...modal.panel.querySelectorAll('button')].find((button) => button.textContent === (kind === 'chart' ? 'Delete chart' : 'Delete')).click();
    else modal.panel.querySelector('form').requestSubmit();
  };
  submit();
  expect(wb.toJSON()).toEqual(before);
  expect(modal.panel.closest('.modal-root').classList.contains('closing')).toBe(false);
  expect(field.value).toBe('Draft');
  expect(modal.panel.querySelector('[role="alert"]').hidden).toBe(false);
  expect(modal.panel.querySelector('[role="alert"]').textContent).toMatch(/protected/i);
  expect(ctx.grid.selectChart).not.toHaveBeenCalled();
  wb.setSheetProtected(sheetId, false);
  submit();
  expect(modal.panel.closest('.modal-root').classList.contains('closing')).toBe(true);
  if (action === 'delete') expect(wb.sheet(sheetId).charts).toHaveLength(0);
  else expect(wb.sheet(sheetId).charts[0][kind === 'chart' ? 'title' : 'text']).toBe('Draft');
  const after = wb.sheet(sheetId).charts;
  wb.undo();
  expect(wb.sheet(sheetId).charts).toEqual(original);
  wb.redo();
  expect(wb.sheet(sheetId).charts).toEqual(after);
});
