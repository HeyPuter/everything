// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// Down arrow on a tab moves into its panel, but on the Border tab it skipped the Line style choices (buttons in
// a radio group, not a select or an input) and landed on the colour picker below them. It now goes to the first
// control of every panel, which on the Border tab is the line style in use.
it.each([['border', 'Thin'], ['number', 'Category'], ['align', 'Horizontal'], ['font', 'Font name'], ['fill', null], ['protect', null]])
  ('Down arrow on the %s tab focuses its first control', (key, label) => {
    const wb = new Workbook();
    const modal = openFormatCellsDialog({ wb, sheetId: () => wb.activeSheetId, active: () => ({ r: 0, c: 0 }), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), style: () => ({}), grid: {}, run: vi.fn() }, { panel: key });
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const panel = modal.panel.querySelector('[role="tabpanel"]:not([hidden])');
    const first = [...panel.querySelectorAll('select, input, button, textarea')].find((node) => !node.disabled && node.tabIndex !== -1);
    expect(document.activeElement).toBe(first);
    if (label) expect(document.activeElement.getAttribute('aria-label')).toBe(label);
  });
