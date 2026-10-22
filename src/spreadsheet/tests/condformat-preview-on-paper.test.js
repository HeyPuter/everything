// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openConditionalFormatting } from '../src/ui/condformat.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const data = new Map();
  vi.stubGlobal('localStorage', { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// The rules list samples each rule's look. A rule with a fill but no text colour drew its "Aa" in the dialog's ink,
// so in dark mode it was near-white on pale yellow, and a red text colour sat on the dark dialog although the cells
// show it on white. The samples are drawn on paper now, as the cell style gallery's are: the sheet's own ink and
// surface, whatever the app's theme.
const panel = () => document.querySelector('.modal-panel');

it('draws each rule sample on paper, in the sheet ink and surface where the rule names none', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const range = parseRange('A1:A3');
  wb.addRule(id, { range, type: 'gt', value: 1, style: { bg: '#fef3c7' } });
  wb.addRule(id, { range, type: 'lt', value: 1, style: { color: '#9c1c1c' } });
  wb.addRule(id, { range, type: 'icons', set: 'traffic', style: {} });
  openConditionalFormatting({ wb, sheetId: () => id, range: () => range, grid: { focus() {} } });
  const [fill, ink, icons] = panel().querySelectorAll('.cf-preview');
  for (const sample of [fill, ink, icons]) expect(sample.classList.contains('sheet-paper')).toBe(true);
  expect([fill.style.background, fill.style.color]).toEqual(['rgb(254, 243, 199)', 'var(--ink)']);
  expect([ink.style.background, ink.style.color]).toEqual(['var(--surface)', 'rgb(156, 28, 28)']);
  expect(icons.style.background).toBe('var(--surface)');
});
