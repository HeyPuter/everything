// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openRecommendedPivots } from '../src/ui/recommended-pivots.js';
import { closeAllModals } from '../src/ui/modal.js';

// The Recommended PivotTables list keeps the focus on itself and moves the choice with the arrow keys, but named
// no option as the active one: a screen reader heard nothing as the choice moved. The chosen option is now the
// list's aria-activedescendant.
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

it('names the chosen recommendation as the list\'s active option', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Item', 'Units', 'Price'], ['East', 'a', 3, 2], ['West', 'b', 1, 5], ['East', 'b', 4, 1], ['West', 'a', 2, 3], ['North', 'a', 5, 4]]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const range = { r1: 0, c1: 0, r2: 5, c2: 3 };
  const { panel } = openRecommendedPivots({ wb, sheetId: () => id, grid: { editing: false, focus() {} }, dataRange: () => range, range: () => range, run: vi.fn() });
  const list = panel.querySelector('[role="listbox"]');
  const options = [...list.querySelectorAll('[role="option"]')];
  expect(options.length).toBeGreaterThan(1);
  expect(list.getAttribute('aria-activedescendant')).toBe(options[0].id);
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(list.getAttribute('aria-activedescendant')).toBe(options[1].id);
  expect(options[1].getAttribute('aria-selected')).toBe('true');
  expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
});
