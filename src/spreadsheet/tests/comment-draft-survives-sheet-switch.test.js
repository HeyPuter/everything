// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { getThread, addComment } from '../src/core/comments.js';

// A new comment being written keeps its draft until Cancel or Escape, and waits out of sight while its cell is
// scrolled away; but showing another sheet (to look something up for the comment, say) threw the draft away.
// It now waits out of sight there too, and is back as it was on returning to its sheet.
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

it('keeps a comment being written while another sheet is shown, and posts it on its own sheet', async () => {
  const doc = new Doc({ name: 'Comments', path: 'Spreadsheets/Comments.xlsx' });
  const wb = doc.wb;
  const first = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  // The sheet's view, as a browser lays it out, holds the cell the card goes beside.
  view.el.querySelector('.grid-viewport').getBoundingClientRect = () => ({ top: 0, left: 0, right: 2000, bottom: 2000, width: 2000, height: 2000 });
  const second = wb.addSheet();
  wb.setActiveSheet(first);
  await tick();
  view.goTo('B2');
  view.run('newComment');
  await tick();
  const area = document.querySelector('.comment-card textarea');
  area.value = 'Matches the total on the other sheet';
  area.dispatchEvent(new Event('input'));
  wb.setActiveSheet(second.id);
  await tick();
  const card = document.querySelector('.comment-card');
  expect(card).not.toBeNull();
  expect(card.classList.contains('offscreen')).toBe(true); // out of sight beside the other sheet's cells
  wb.setActiveSheet(first);
  await tick();
  expect(card.isConnected).toBe(true);
  expect(card.classList.contains('offscreen')).toBe(false);
  expect(card.querySelector('textarea').value).toBe('Matches the total on the other sheet');
  [...card.querySelectorAll('button')].find((b) => b.textContent === 'Post').click();
  await tick();
  expect(getThread(wb, first, 1, 1)?.items.map((i) => i.text)).toEqual(['Matches the total on the other sheet']);
}, 30000);

it('lets a card that is not being written in go with its sheet', async () => {
  const doc = new Doc({ name: 'Comments', path: 'Spreadsheets/Comments.xlsx' });
  const wb = doc.wb;
  const first = wb.activeSheetId;
  addComment(wb, first, 0, 0, 'Is this final?', 'Grace');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await tick();
  const second = wb.addSheet();
  wb.setActiveSheet(first);
  await tick();
  view.run('showComment');
  await tick();
  expect(document.querySelector('.comment-card')).not.toBeNull();
  wb.setActiveSheet(second.id);
  await tick();
  expect(document.querySelector('.comment-card')).toBeNull();
}, 30000);
