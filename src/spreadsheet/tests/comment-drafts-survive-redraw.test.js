// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { getThread, addComment } from '../src/core/comments.js';

// The Comments pane is redrawn whenever the selection moves or the workbook changes. A reply being written there, or a
// comment being edited, came back empty once its box had lost the focus: clicking a cell to check a value, or typing
// in one, threw the text away. And a comment being edited took the focus back at each redraw, so the keys meant for
// the cell clicked went into the comment.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const tick = () => vi.advanceTimersByTimeAsync(20);

const typeIn = (area, text) => { area.focus(); area.value = text; area.dispatchEvent(new Event('input')); };

async function open() {
  const doc = new Doc({ name: 'Comments', path: 'Spreadsheets/Comments.xlsx' });
  addComment(doc.wb, doc.wb.activeSheetId, 0, 0, 'Is this final?', 'Grace');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  view.run('toggleComments');
  await tick();
  return doc.wb;
}

it('keeps a reply being written in the pane when a cell is selected and edited', async () => {
  const wb = await open();
  typeIn(document.querySelector('.comments-pane .cmt-reply'), 'Draft reply');
  view.el.querySelector('.grid-viewport').focus();
  view.goTo('C3');
  await tick();
  wb.setInput(wb.activeSheetId, 2, 2, 42);
  await tick();
  const box = document.querySelector('.comments-pane .cmt-reply');
  expect(box.value).toBe('Draft reply');
  expect(document.querySelector('.comments-pane .cmt-post').disabled).toBe(false);
  expect(document.activeElement).not.toBe(box);
}, 30000);

it('keeps a comment being edited in the pane, and leaves the focus on the sheet once a cell is clicked', async () => {
  const wb = await open();
  document.querySelector('.comments-pane .cmt-more').click();
  await tick();
  [...document.querySelectorAll('.menu [role^="menuitem"]')].find((n) => n.textContent.includes('Edit comment')).click();
  await tick();
  const area = document.querySelector('.comments-pane .cmt-edit textarea');
  expect(document.activeElement).toBe(area); // the edit begins in the box
  typeIn(area, 'Is this final? Yes.');
  const sheet = view.el.querySelector('.grid-viewport');
  sheet.focus();
  view.goTo('C3');
  await tick();
  wb.setInput(wb.activeSheetId, 2, 2, 42);
  await tick();
  expect(document.querySelector('.comments-pane .cmt-edit textarea').value).toBe('Is this final? Yes.');
  expect(document.activeElement).toBe(sheet);
  [...document.querySelectorAll('.comments-pane .cmt-edit button')].find((b) => b.textContent === 'Save').click();
  await tick();
  expect(getThread(wb, wb.activeSheetId, 0, 0).items[0].text).toBe('Is this final? Yes.');
}, 30000);
