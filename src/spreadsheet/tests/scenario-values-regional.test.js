// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';
import { openScenarioEditor } from '../src/ui/scenario-manager.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { setLocale('en-US'); closeAllModals(); document.body.replaceChildren(); });

const panel = () => [...document.querySelectorAll('.modal-panel')].at(-1);
const submit = () => panel().querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));

function scenarioOf(locale, cells) {
  setLocale(locale);
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, cells.map((v, c) => ({ r: 0, c, cell: { v, f: null } })));
  const range = { r1: 0, c1: 0, r2: 0, c2: cells.length - 1 };
  const ctx = { wb, sheetId: () => id, range: () => range, ranges: () => [range], grid: { focus: vi.fn() } };
  openScenarioEditor(ctx, null);
  panel().querySelector('input').value = 'Best case';
  submit();
  const shown = [...panel().querySelectorAll('.sm-values-list input')].map((i) => i.value);
  submit();
  const saved = wb.sheet(id).scenarios?.list?.[0] ?? null;
  return { shown, saved, wb, id };
}

it('offers the changing cells\' values in the regional format, so OK keeps them as they are', () => {
  // Where the decimal mark is a comma, "1.5" reads as the 1st of May and "0.5" as text.
  const { shown, saved } = scenarioOf('de-DE', [1.5, 0.5, 1234.25, true, '007']);
  expect(shown).toEqual(['1,5', '0,5', '1234,25', 'TRUE', "'007"]);
  expect(saved.values).toEqual([1.5, 0.5, 1234.25, true, '007']);
});

it('keeps every digit of a value and text that looks like a number in the en-US format too', () => {
  const { shown, saved } = scenarioOf('en-US', [123456789012.5, 0.1 + 0.2, '1/2']);
  expect(saved.values).toEqual([123456789012.5, 0.3, '1/2']);
  expect(shown[2]).toBe("'1/2");
});
