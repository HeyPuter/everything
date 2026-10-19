// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// More or Fewer decimal places on an Automatic (General) cell turned it into the grouped Number format, so a
// plain 1234567 became 1,234,567.0: a command that should only add a place also added thousands separators.
// As in Excel, the cell now takes a plain decimal format (0.0 here) and shows only the extra place; a cell
// already in a grouped Number format keeps its separators.
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

async function setup(texts, selection) {
  const doc = new Doc({ name: 'Decimals', path: 'Spreadsheets/Decimals.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  texts.forEach((t, r) => wb.setInput(id, r, 0, t));
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo(`Sheet1!${selection}`);
  await vi.advanceTimersByTimeAsync(1);
  const click = (label) => { view.el.querySelector(`[aria-label="${label}"]`).click(); return vi.advanceTimersByTimeAsync(1); };
  const shown = () => texts.map((_, r) => wb.getDisplay(id, r, 0));
  return { wb, id, click, shown };
}

it('adds a place to an Automatic number without adding thousands separators', async () => {
  const { click, shown } = await setup(['1234567', '1234.5', '-98765'], 'A1:A3');
  await click('More decimal places');
  expect(shown()).toEqual(['1234567.0', '1234.50', '-98765.0']);
  await click('More decimal places');
  expect(shown()).toEqual(['1234567.00', '1234.500', '-98765.00']);
});

it('removes a place from an Automatic number without adding thousands separators', async () => {
  const { click, shown } = await setup(['12345.67'], 'A1');
  await click('Fewer decimal places');
  expect(shown()).toEqual(['12345.7']);
});

it('keeps the separators of a cell already in a grouped Number format', async () => {
  const { click, shown } = await setup(['1,234.5'], 'A1');
  expect(shown()).toEqual(['1,234.50']);
  await click('More decimal places');
  expect(shown()).toEqual(['1,234.500']);
});
