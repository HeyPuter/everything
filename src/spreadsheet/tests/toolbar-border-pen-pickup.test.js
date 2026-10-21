// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createToolbar } from '../src/ui/toolbar.js';
import { closeMenu } from '../src/ui/menu.js';
import { Workbook } from '../src/core/workbook.js';
import { memoryStorage } from './helpers/memory-storage.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { closeMenu(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

// The Borders menu's pen takes up the active cell's border colour and line, but it read only the pen a whole
// cell shares: a side drawn with a pen of its own (Format Cells ▸ Border, Thick bottom border) came back as a
// thin line in the default colour, so the next Bottom border drew thin.
it('takes up the pen of a side drawn with its own pen', () => {
  const wb = new Workbook();
  const run = vi.fn();
  const toolbar = createToolbar({
    wb, run, activeCell: () => ({}), style: () => ({ bb: true, bbBorder: { bs: 'thick', bc: '#C22A2A' } }), active: () => ({ r: 0, c: 0 }),
    range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), sheetId: () => wb.activeSheetId, grid: { editing: false }, subscribe: () => () => {},
  });
  document.body.append(toolbar.el);
  toolbar.refresh();
  toolbar.el.querySelector('[aria-label="Borders"]').click();
  [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.startsWith('Bottom border')).click();
  expect(run).toHaveBeenCalledWith('borders', { kind: 'bottom', color: '#c22a2a', style: 'thick' });
});
