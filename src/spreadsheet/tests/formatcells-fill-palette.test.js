// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function open(style = {}, panel = 'fill') {
  const wb = new Workbook(), id = wb.activeSheetId, run = vi.fn();
  wb.setInput(id, 0, 0, '12'); wb.applyStyle(id, parseRange('A1'), style); wb.clearHistory();
  const modal = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }),
    range: () => parseRange('A1'), style: () => wb.styleAt(id, 0, 0) || {}, grid: {}, run }, { panel });
  const field = (label) => modal.panel.querySelector(`[aria-label="${label}"]`);
  const apply = () => modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  return { wb, id, modal, run, field, apply };
}

it('offers the theme colours with their tints and the standard fills as palettes', () => {
  const { field } = open();
  const theme = field('Theme fill colors'), standard = field('Standard fill colors');
  expect(theme.getAttribute('role')).toBe('radiogroup');
  expect(theme.querySelectorAll('[role="radio"]')).toHaveLength(60);
  expect(standard.querySelectorAll('[role="radio"]')).toHaveLength(12);
  // One Tab stop per palette.
  expect([...theme.querySelectorAll('[role="radio"]')].filter((b) => b.tabIndex === 0)).toHaveLength(1);
});

it('applies a picked standard fill, shows it in the sample and unticks No fill', () => {
  const { field, apply, run, modal } = open();
  const swatch = field('Standard fill colors').querySelector('[aria-label="#e0ecff"]');
  swatch.click();
  expect(swatch.getAttribute('aria-checked')).toBe('true');
  expect(field('Fill preview').style.backgroundColor).toBe('rgb(224, 236, 255)');
  expect([...modal.panel.querySelectorAll('label')].find((l) => l.textContent === 'No fill').querySelector('input').checked).toBe(false);
  expect(field('Fill color').value).toBe('#e0ecff');
  apply();
  expect(run).toHaveBeenCalledWith('applyFormat', { patch: { bg: '#e0ecff' }, border: null });
});

it('applies a theme colour as a theme reference, and marks the cell\'s own theme fill as chosen', () => {
  const first = open();
  const accent = first.field('Theme fill colors').querySelectorAll('[role="radio"]')[4];
  accent.click(); first.apply();
  const bg = first.run.mock.calls[0][1].patch.bg;
  expect(bg).toMatchObject({ theme: 4 });
  closeAllModals();
  const again = open({ bg });
  expect(again.field('Theme fill colors').querySelectorAll('[role="radio"]')[4].getAttribute('aria-checked')).toBe('true');
});

it('walks a palette with the arrow keys, picking as it goes', () => {
  const { field } = open();
  const radios = [...field('Theme fill colors').querySelectorAll('[role="radio"]')];
  radios[0].focus();
  const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowRight'); expect(document.activeElement).toBe(radios[1]);
  key('ArrowDown'); expect(document.activeElement).toBe(radios[11]);
  expect(radios[11].getAttribute('aria-checked')).toBe('true');
  key('End'); expect(document.activeElement).toBe(radios[19]);
  key('Home'); expect(document.activeElement).toBe(radios[10]);
  key('ArrowUp'); key('ArrowUp'); expect(document.activeElement).toBe(radios[0]);
});

it('says what the chosen number category does', () => {
  const { modal } = open({}, 'number');
  const note = modal.panel.querySelector('.fc-category-note');
  expect(note.textContent).toMatch(/as they were entered/);
  const category = modal.panel.querySelector('[aria-label="Category"]');
  category.value = 'percent'; category.dispatchEvent(new Event('change', { bubbles: true }));
  expect(note.textContent).toMatch(/multiplied by 100/);
});
