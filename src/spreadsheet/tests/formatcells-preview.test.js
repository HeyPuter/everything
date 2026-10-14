// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function open(range = 'A1', style = {}) {
  const wb = new Workbook(), id = wb.activeSheetId, run = vi.fn();
  wb.setInput(id, 0, 0, '-1234.5'); wb.applyStyle(id, parseRange('A1'), style); wb.clearHistory();
  const before = wb.toJSON();
  const { panel, close } = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }),
    range: () => parseRange(range), style: () => wb.styleAt(id, 0, 0) || {}, grid: {}, run });
  const field = name => panel.querySelector(`[aria-label="${name}"]`);
  const choose = (name, value) => { const node = field(name); node.value = value; node.dispatchEvent(new Event(node.type === 'color' || node.type === 'number' ? 'input' : 'change', { bubbles: true })); };
  return { wb, before, panel, run, close, field, choose };
}

it('offers the existing categories and negative styles as single-selection lists', () => {
  const { field, choose } = open();
  expect(field('Category').size).toBeGreaterThan(1);
  expect(field('Category').multiple).toBe(false);
  choose('Category', 'currency');
  expect(field('Negative numbers').size).toBe(4);
  expect(field('Decimal places').value).toBe('2');
});

it('previews appearance changes across tabs without editing the workbook or creating undo', () => {
  const { wb, before, field, choose, close, run } = open();
  choose('Category', 'currency'); choose('Negative numbers', 'redparen');
  choose('Horizontal', 'center'); choose('Vertical', 'top'); choose('Rotation (degrees, -90 to 90)', '30');
  choose('Fill color', '#ddeeff');
  const box = field('Alignment preview'), text = box.querySelector('.fc-preview-text');
  expect(text.textContent).toBe('($1,234.50)'); expect(text.style.color).toBe('rgb(255, 0, 0)');
  expect(box.style.justifyContent).toBe('center'); expect(box.style.alignItems).toBe('flex-start');
  expect(box.style.backgroundColor).toBe('rgb(221, 238, 255)'); expect(text.style.transform).toBe('rotate(-30deg)');
  expect(wb.toJSON()).toEqual(before); expect(wb.canUndo()).toBe(false);
  close(); expect(run).not.toHaveBeenCalled();
});

it('previews font effects and submits only the selected edits through the existing command', () => {
  const { panel, choose, field, run } = open();
  choose('Size', '18'); choose('Text color', '#224466');
  const bold = [...panel.querySelectorAll('label.find-option')].find(label => label.textContent === 'Bold').querySelector('input');
  bold.click(); choose('Line style', 'dashed'); [...field('Border presets').querySelectorAll('button')].find(b => b.textContent === 'Outline').click();
  const box = field('Font preview'); expect(box.querySelector('span').style.fontSize).toBe('24px'); // 18pt
  expect(box.querySelector('span').style.fontWeight).toBe('600'); expect(box.style.borderTopStyle).toBe('dashed');
  panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith('applyFormat', { patch: { size: 24, bold: true, color: '#224466' }, border: null,
    borders: ['top', 'bottom', 'left', 'right'].map(kind => ({ kind, style: 'dashed', color: null, perSide: true })) });
});

it.each([['A1', false, false], ['A1:B1', false, true], ['A1:A2', true, false], ['A1:B2', true, true]])('previews inside borders for the dimensions of %s', (range, rows, cols) => {
  const { field } = open(range); [...field('Border presets').querySelectorAll('button')].find(b => b.textContent === 'Inside').click();
  const box = field('Border preview');
  expect(box.classList.contains('fc-preview-inside-rows')).toBe(rows);
  expect(box.classList.contains('fc-preview-inside-cols')).toBe(cols);
});

it('moves from a tab into its first field with Down and leaves modified or composing arrows alone', () => {
  const { panel, field } = open();
  const tab = panel.querySelector('[role="tab"][aria-selected="true"]');
  for (const options of [{ isComposing: true }, { ctrlKey: true }, { shiftKey: true }]) {
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true, ...options });
    tab.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    expect(tab.getAttribute('aria-selected')).toBe('true');
  }
  tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(field('Category'));
});
