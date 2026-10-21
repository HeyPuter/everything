// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createToolbar } from '../src/ui/toolbar.js';
import { closeMenu } from '../src/ui/menu.js';
import { Workbook } from '../src/core/workbook.js';
import { memoryStorage } from './helpers/memory-storage.js';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { closeMenu(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

// The Borders menu's pen takes up the active cell's line, which may be a hairline or a dash-dot line from an Excel
// file, but Border style named only the six lines the app first drew: on such a cell it said "Thin" while the next
// border was drawn as a hairline, and offered none of Excel's other lines to pick.
function open(style) {
  const wb = new Workbook();
  const run = vi.fn();
  const toolbar = createToolbar({
    wb, run, activeCell: () => ({}), style: () => style, active: () => ({ r: 0, c: 0 }),
    range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), sheetId: () => wb.activeSheetId, grid: { editing: false }, subscribe: () => () => {},
  });
  document.body.append(toolbar.el);
  toolbar.refresh();
  toolbar.el.querySelector('[aria-label="Borders"]').click();
  return { run, item: (text) => [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes(text)) };
}

it('names a hairline pen, and lists Excel\'s thirteen lines with it checked', () => {
  const { item } = open({ bb: true, bbBorder: { bs: 'hair', bc: null } });
  expect(item('Border style').textContent).toContain('Hair');
  item('Border style').click();
  const lines = [...document.querySelectorAll('.menu-item[role="menuitemradio"]')];
  expect(lines).toHaveLength(13);
  expect(lines.filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent.trim())).toEqual(['Hair']);
});

it('restyles the selection with a medium dash-dot line picked from the list', () => {
  const { run, item } = open({});
  item('Border style').click();
  [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === 'Medium dash-dot').click();
  expect(run).toHaveBeenLastCalledWith('borders', { kind: 'restyle', style: 'mediumDashDot' });
});
