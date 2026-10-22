// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { looksLikeHeader, openSortDialog } from '../src/ui/sortdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
});
afterEach(() => {
  closeAllModals();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('offers only supported orders when sorting columns', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [3, 1, 2].forEach((v, c) => wb.setInput(id, 0, c, String(v)));
  const modal = openSortDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), grid: { focus() {} } }, parseRange('A1:C1'));
  const direction = modal.panel.querySelector('[aria-label="Sort direction"]');
  expect([...modal.panel.querySelector('[aria-label="Order"]').options].map((o) => o.value).filter((v) => !/^list\d+r?$/.test(v))).toEqual(['asc', 'desc']);
  expect(modal.panel.querySelector('[aria-label="Sort on"] option[value="color"]').disabled).toBe(false);
  direction.value = 'cols';
  direction.dispatchEvent(new Event('change'));
  expect([...modal.panel.querySelector('[aria-label="Order"]').options].map((o) => o.value).filter((v) => !/^list\d+r?$/.test(v))).toEqual(['asc', 'desc']);
  modal.panel.querySelector('form').requestSubmit();
  expect([0, 1, 2].map((c) => wb.getValue(id, 0, c))).toEqual([1, 2, 3]);
  wb.undo();
  expect([0, 1, 2].map((c) => wb.getValue(id, 0, c))).toEqual([3, 1, 2]);
});

describe('looksLikeHeader', () => {
  it('spots a text row above typed data', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const set = (a1, v) => { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, v); };
    set('A1', 'Name'); set('B1', 'Qty'); set('A2', 'Apple'); set('B2', '3'); set('A3', 'Pear'); set('B3', '5');
    expect(looksLikeHeader(wb, id, parseRange('A1:B3'))).toBe(true);
    expect(looksLikeHeader(wb, id, parseRange('A2:B3'))).toBe(false);
    expect(looksLikeHeader(wb, id, parseRange('A1:B1'))).toBe(false);
    set('C1', 'Note'); set('C2', 'text'); set('C3', 'text');
    expect(looksLikeHeader(wb, id, parseRange('C1:C3'))).toBe(true); // all-text head over text is still a header
  });
});

it('refreshes available fill colors when the header enters or leaves the sorted rows', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['Header', '1', '2'].forEach((value, r) => wb.setInput(id, r, 0, value));
  wb.applyStyle(id, parseRange('A1'), { bg: '#ff0000' });
  wb.clearHistory();
  const { panel } = openSortDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), grid: { focus() {} } }, parseRange('A1:A3'));
  const order = panel.querySelector('[aria-label="Order"]');
  const mode = panel.querySelector('[aria-label="Sort on"]');
  mode.value = 'color';
  mode.dispatchEvent(new Event('change'));
  order.value = 'colorBottom';
  order.dispatchEvent(new Event('change'));
  const color = panel.querySelector('[aria-label="Fill color"]');
  const header = panel.querySelector('input[type="checkbox"]');
  expect(header.checked).toBe(true);
  expect(color.disabled).toBe(true);
  header.click();
  expect(color.disabled).toBe(false);
  expect(color.value).toBe('#ff0000');
  header.click();
  expect(color.disabled).toBe(true);
  header.click();
  panel.querySelector('form').requestSubmit();
  expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual([1, 2, 'Header']);
  expect(wb.getCell(id, 2, 0).s.bg).toBe('#ff0000');
  wb.undo();
  expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual(['Header', 1, 2]);
});

it('keeps a selected fill and updates its count when the header option changes', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['Header', '1', '2'].forEach((value, r) => wb.setInput(id, r, 0, value));
  wb.applyStyle(id, parseRange('A1:A2'), { bg: '#ff0000' });
  wb.applyStyle(id, parseRange('A3'), { bg: '#0000ff' });
  const { panel } = openSortDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), grid: { focus() {} } }, parseRange('A1:A3'));
  const order = panel.querySelector('[aria-label="Order"]');
  const mode = panel.querySelector('[aria-label="Sort on"]');
  mode.value = 'color';
  mode.dispatchEvent(new Event('change'));
  order.value = 'colorTop';
  order.dispatchEvent(new Event('change'));
  const color = panel.querySelector('[aria-label="Fill color"]');
  color.value = '#ff0000';
  panel.querySelector('input[type="checkbox"]').click();
  expect(color.value).toBe('#ff0000');
  expect(color.selectedOptions[0].textContent).toBe('#ff0000 (2 rows)');
});

it('offers no fill colors when the only selected row is a header', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Header');
  wb.applyStyle(id, parseRange('A1:A2'), { bg: '#ff0000' });
  const { panel } = openSortDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), grid: { focus() {} } }, parseRange('A1'));
  panel.querySelector('input[type="checkbox"]').click();
  const order = panel.querySelector('[aria-label="Order"]');
  const mode = panel.querySelector('[aria-label="Sort on"]');
  mode.value = 'color';
  mode.dispatchEvent(new Event('change'));
  order.value = 'colorTop';
  order.dispatchEvent(new Event('change'));
  expect(panel.querySelector('[aria-label="Fill color"]').disabled).toBe(true);
});
