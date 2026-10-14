// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Workbook } from '../src/core/workbook.js';
import { Doc } from '../src/lib/doc.js';
import { parseRange } from '../src/core/cell.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const key = (node, key, extra = {}) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Status bar' }); const wb = doc.wb; const id = wb.activeSheetId;
  [['Item', 'Quantity', 'Price', 'Total'], ['Notebook', '3', '4.5', '=B2*C2'], ['Pencil', '6', '1.25', '=B3*C3'], ['Folder', '2', '3', '=B4*C4']]
    .forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const button = label => [...view.el.querySelectorAll(`button[aria-label="${label}"]`)].find(b => !b.closest('[hidden]'));
async function select(range) {
  const name = view.el.querySelector('.name-box'); name.value = range; key(name, 'Enter'); await flush();
}


// The Customize Status Bar menu reads each item's current value beside it, shown on the bar or not,
// and stays open while items are switched, so several can be changed in one visit.
it('shows every statistic\'s value in the menu and keeps the menu open while switching', async () => {
  await mount(); await select('B2:C4');
  const bar = view.el.querySelector('.status-bar');
  bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await flush();
  const item = label => [...document.querySelectorAll('.menu [role="menuitemcheckbox"]')].find(b => b.querySelector('.menu-label').textContent === label);
  const detail = label => item(label).querySelector('.menu-detail')?.textContent;
  expect(detail('Sum')).toBe('19.75');
  expect(detail('Minimum')).toBe('1.25'); // shown although the bar leaves it out
  expect(detail('Maximum')).toBe('6');
  expect(detail('Count')).toBe('6');
  expect(detail('Selection Address')).toBe('B2:C4');
  expect(detail('Zoom')).toBe('100%');
  expect(detail('View Shortcuts')).toBeUndefined();
  item('Minimum').click(); await flush();
  expect(document.querySelector('.menu')).not.toBeNull();
  expect(item('Minimum').getAttribute('aria-checked')).toBe('true');
  expect(bar.textContent).toContain('Minimum: 1.25');
  item('Maximum').click(); await flush();
  expect(bar.textContent).toContain('Maximum: 6');
  item('Minimum').click(); await flush();
  expect(item('Minimum').getAttribute('aria-checked')).toBe('false');
  expect(bar.textContent).not.toContain('Minimum');
  expect(JSON.parse(localStorage.getItem('spreadsheet:status-bar'))).toMatchObject({ min: false, max: true });
});
