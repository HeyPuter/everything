// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { getThread, addComment } from '../src/core/comments.js';

// A new comment posted with Ctrl+Enter (or its Post button) redrew the card as the thread, taking away the box
// that had the focus: the keyboard fell to the page, where the arrows moved nothing and Escape left it there.
// The focus now moves on to the thread's reply box, from which Escape closes the card and goes back to the sheet.
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

it('moves the keyboard on to the reply box once a new comment is posted', async () => {
  const doc = new Doc({ name: 'Comments', path: 'Spreadsheets/Comments.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  view.el.querySelector('.grid-viewport').getBoundingClientRect = () => ({ top: 0, left: 0, right: 2000, bottom: 2000, width: 2000, height: 2000 });
  view.goTo('C3');
  view.run('newComment');
  await tick();
  const area = document.querySelector('.comment-card textarea');
  expect(document.activeElement).toBe(area);
  area.value = 'Check this total';
  area.dispatchEvent(new Event('input'));
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  await tick();
  expect(getThread(wb, id, 2, 2)?.items.map((i) => i.text)).toEqual(['Check this total']);
  const reply = document.querySelector('.comment-card textarea.cmt-reply');
  expect(reply).not.toBeNull();
  expect(document.activeElement).toBe(reply);
  reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick();
  expect(document.querySelector('.comment-card')).toBeNull();
  expect(document.activeElement).toBe(view.el.querySelector('.grid-viewport'));
}, 30000);

// Resolve, Reopen, and an edit saved or given up with Escape redrew the card the same way, the control pressed
// going with the redraw: each now leaves the keyboard in the card, on the reply box or the Reopen button.
it('keeps the keyboard in the card as a thread is resolved, reopened and edited', async () => {
  const doc = new Doc({ name: 'Comments', path: 'Spreadsheets/Comments.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  view.el.querySelector('.grid-viewport').getBoundingClientRect = () => ({ top: 0, left: 0, right: 2000, bottom: 2000, width: 2000, height: 2000 });
  view.goTo('C3');
  view.run('newComment');
  await tick();
  const area = document.querySelector('.comment-card textarea');
  area.value = 'Check this total';
  area.dispatchEvent(new Event('input'));
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  await tick();
  const card = () => document.querySelector('.comment-card');
  card().querySelector('.cmt-resolve').focus();
  card().querySelector('.cmt-resolve').click();
  await tick();
  expect(getThread(wb, id, 2, 2)?.done).toBe(true);
  expect(document.activeElement).toBe(card().querySelector('.cmt-resolved button'));
  document.activeElement.click();
  await tick();
  expect(getThread(wb, id, 2, 2)?.done).toBeFalsy();
  expect(document.activeElement).toBe(card().querySelector('textarea.cmt-reply'));
  // Edit comment, from the thread's "…" menu, then Escape in the box.
  card().querySelector('.cmt-more').click();
  await tick();
  [...document.querySelectorAll('.menu-item')].find((n) => n.textContent.includes('Edit comment')).click();
  await tick();
  const edit = card().querySelector('textarea[aria-label="Edit comment"]');
  expect(document.activeElement).toBe(edit);
  edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick();
  expect(card()).not.toBeNull();
  expect(document.activeElement).toBe(card().querySelector('textarea.cmt-reply'));
}, 30000);

// The Comments pane redraws its threads the same way, and Resolve or Reopen there dropped the keyboard too.
it('keeps the keyboard on the thread in the Comments pane as it is resolved and reopened', async () => {
  const doc = new Doc({ name: 'Comments', path: 'Spreadsheets/Comments.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  addComment(wb, id, 1, 1, 'First', 'Grace');
  addComment(wb, id, 4, 2, 'Second', 'Alan');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  view.run('toggleComments');
  await tick();
  const thread = () => [...document.querySelectorAll('.comments-pane .cmt-thread')].find((n) => n.dataset.cell === '4,2');
  thread().querySelector('.cmt-resolve').focus();
  thread().querySelector('.cmt-resolve').click();
  await tick();
  expect(getThread(wb, id, 4, 2)?.done).toBe(true);
  expect(document.activeElement).toBe(thread().querySelector('.cmt-resolved button'));
  document.activeElement.click();
  await tick();
  expect(getThread(wb, id, 4, 2)?.done).toBeFalsy();
  expect(document.activeElement).toBe(thread().querySelector('textarea.cmt-reply'));
}, 30000);

// A thread's cell name in the pane goes to its cell, and the pane is redrawn for the new selection: the keyboard was
// put in that thread's reply box, which on a phone brings up the on-screen keyboard over the cell gone to. It stays
// on the cell name, as it was before the redraw.
it('keeps the keyboard on a thread\'s cell name in the Comments pane once it has gone to the cell', async () => {
  const doc = new Doc({ name: 'Comments', path: 'Spreadsheets/Comments.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  addComment(wb, id, 1, 1, 'First', 'Grace');
  addComment(wb, id, 4, 2, 'Second', 'Alan');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  view.run('toggleComments');
  await tick();
  const thread = () => [...document.querySelectorAll('.comments-pane .cmt-thread')].find((n) => n.dataset.cell === '4,2');
  thread().querySelector('.cmt-cell').focus();
  thread().querySelector('.cmt-cell').click();
  await tick();
  expect(thread().classList.contains('active')).toBe(true);
  expect(document.activeElement).toBe(thread().querySelector('.cmt-cell'));
}, 30000);
