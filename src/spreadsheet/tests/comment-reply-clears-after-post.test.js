// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { getThread, addComment } from '../src/core/comments.js';

// A reply posted from the box being typed in (Ctrl+Enter, or Post with the box focused) stayed in the box: the post
// redrew the thread and carried the box's text over to the new one, so the reply looked unsent and invited a second post.
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
const ctrlEnter = (area) => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));

async function open() {
  const doc = new Doc({ name: 'Comments', path: 'Spreadsheets/Comments.xlsx' });
  addComment(doc.wb, doc.wb.activeSheetId, 0, 0, 'Is this final?', 'Grace');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  return doc.wb;
}

it('empties the card’s reply box once the reply is posted', async () => {
  const wb = await open();
  view.run('showComment');
  await tick();
  typeIn(document.querySelector('.comment-card .cmt-reply'), 'Yes');
  ctrlEnter(document.querySelector('.comment-card .cmt-reply'));
  await tick();
  expect(getThread(wb, wb.activeSheetId, 0, 0).items.map((i) => i.text)).toEqual(['Is this final?', 'Yes']);
  const box = document.querySelector('.comment-card .cmt-reply');
  expect(box.value).toBe('');
  expect(document.activeElement).toBe(box); // still there for the next reply
  expect(document.querySelector('.comment-card .cmt-post').disabled).toBe(true);
}, 30000);

it('empties the Comments pane’s reply box once the reply is posted', async () => {
  const wb = await open();
  view.run('toggleComments');
  await tick();
  typeIn(document.querySelector('.comments-pane .cmt-reply'), 'Yes');
  document.querySelector('.comments-pane .cmt-post').click();
  await tick();
  expect(getThread(wb, wb.activeSheetId, 0, 0).items.map((i) => i.text)).toEqual(['Is this final?', 'Yes']);
  expect(document.querySelector('.comments-pane .cmt-reply').value).toBe('');
}, 30000);
