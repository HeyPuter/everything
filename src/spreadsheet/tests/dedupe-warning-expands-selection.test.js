// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Selecting the scores of a list (B2:B5) and removing duplicates removed the repeated score alone and moved the
// scores below it up, each now beside another name. Excel first warns that data lies next to the selection and
// offers to expand it; so does the app now, and the expanded list loses whole rows.
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
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const LIST = [['Name', 'Score'], ['Ann', '10'], ['Bob', '10'], ['Cid', '20'], ['Dee', '30']];

async function open() {
  const doc = new Doc({ name: 'Dedupe', path: 'Spreadsheets/Dedupe.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  LIST.forEach((row, r) => row.forEach((t, c) => wb.setInput(id, r, c, t)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!B2:B5');
  await vi.advanceTimersByTimeAsync(1);
  const rows = () => LIST.map((_, r) => [0, 1].map((c) => wb.getDisplay(id, r, c)).join('|'));
  return { rows };
}

const top = () => [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')].pop();

it('warns about the data beside the selection and removes whole rows once it is expanded', async () => {
  const { rows } = await open();
  view.run('dedupe');
  await vi.advanceTimersByTimeAsync(1);
  expect(top().getAttribute('aria-label')).toBe('Remove duplicates warning');
  top().querySelector('button[type=submit]').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(top().getAttribute('aria-label')).toBe('Remove duplicates');
  expect(top().textContent).toContain('A1:B5');
  // Duplicates by the score alone: Bob's row repeats Ann's 10 and goes as a whole.
  top().querySelector('[data-c="0"]').checked = false;
  top().querySelector('button[type=submit]').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(rows()).toEqual(['Name|Score', 'Ann|10', 'Cid|20', 'Dee|30', '|']);
});

it('keeps to the selection when asked, and does nothing when cancelled', async () => {
  const { rows } = await open();
  view.run('dedupe');
  await vi.advanceTimersByTimeAsync(1);
  top().querySelector('.btn-ghost').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelector('.modal-root:not(.closing)')).toBe(null);
  view.run('dedupe');
  await vi.advanceTimersByTimeAsync(1);
  top().querySelector('input[value=selection]').checked = true;
  top().querySelector('button[type=submit]').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(top().textContent).toContain('B2:B5');
  expect(rows()).toEqual(['Name|Score', 'Ann|10', 'Bob|10', 'Cid|20', 'Dee|30']);
});
