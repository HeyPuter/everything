// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

const values = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key), clear: () => values.clear(),
} });
let view;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
});
afterEach(() => {
  closeMenu(); view?.destroy(); view = null;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

async function mount(style = { fmt: 'currency', cur: 'USD', dec: 2 }, selection = 'A2') {
  const doc = new Doc({ name: 'Spill formats', path: 'Spreadsheets/Spill formats.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { f: 'SEQUENCE(4)', s: style } }]);
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo(selection);
  await vi.advanceTimersByTimeAsync(1);
  const button = (label) => view.el.querySelector(`[aria-label="${label}"]`);
  const click = async (label) => { button(label).click(); await vi.advanceTimersByTimeAsync(1); };
  const label = () => view.el.querySelector('.tb-fmt-label').textContent;
  // The Number group has no currency toggle: Currency and General are picked from the number-format list.
  const pick = async (name) => {
    view.el.querySelector('.tb-fmt').click(); await vi.advanceTimersByTimeAsync(1);
    [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === name).click();
    await vi.advanceTimersByTimeAsync(1);
  };
  return { wb, id, button, click, label, pick };
}

it('reports a spilled result\'s currency and lets the number-format list take it off and put it back', async () => {
  const { wb, id, label, pick } = await mount();
  expect(wb.getDisplay(id, 1, 0)).toBe('$2.00');
  expect(label()).toBe('Currency');
  await pick('General');
  expect(label()).toBe('General');
  expect(wb.getDisplay(id, 1, 0)).toBe('2');
  await pick('Currency');
  expect(label()).toBe('Currency');
  expect(wb.getDisplay(id, 1, 0)).toBe('$2.00');
  expect(wb.getDisplay(id, 0, 0)).toBe('$1.00');
});

it('steps the displayed decimals of each selected spill without losing currency or changing the anchor', async () => {
  const { wb, id, click } = await mount({ fmt: 'currency', cur: 'EUR', dec: 2 }, 'A2:A3');
  await click('More decimal places');
  expect([0, 1, 2, 3].map((r) => wb.getDisplay(id, r, 0))).toEqual(['€1.00', '€2.000', '€3.000', '€4.00']);
  await click('Fewer decimal places');
  expect(wb.getDisplay(id, 1, 0)).toBe('€2.00');
  wb.undo(); wb.undo();
  expect(wb.getCell(id, 1, 0)).toBeUndefined();
  expect(wb.getDisplay(id, 1, 0)).toBe('€2.00');
  expect(wb.canUndo()).toBe(false);
});

it.each([
  [{ fmt: 'date' }, 'Short Date'],
  [{ fmt: 'custom', code: '[h]:mm' }, '[h]:mm'],
])('disables decimal controls for an inherited %s format', async (style, text) => {
  const { wb, id, button, click, label } = await mount(style);
  const before = wb.getDisplay(id, 1, 0);
  expect(label()).toBe(text);
  expect(button('More decimal places').disabled).toBe(true);
  expect(button('Fewer decimal places').disabled).toBe(true);
  await click('More decimal places');
  expect(wb.getDisplay(id, 1, 0)).toBe(before);
  expect(wb.canUndo()).toBe(false);
});

it('reads the displayed spill format above line defaults and below cell overrides', async () => {
  const { wb, id, click, label } = await mount();
  wb.sheet(id).colStyles.set(0, { fmt: 'percent', dec: 0 });
  view.goTo('A3');
  await vi.advanceTimersByTimeAsync(1);
  expect(label()).toBe('Currency');
  await click('More decimal places');
  expect(wb.getDisplay(id, 2, 0)).toBe('$3.000');
  wb.applyStyle(id, { r1: 2, c1: 0, r2: 2, c2: 0 }, { fmt: 'percent', dec: 1 });
  await vi.advanceTimersByTimeAsync(1);
  expect(label()).toBe('Percentage');
  await click('More decimal places');
  expect(wb.getDisplay(id, 2, 0)).toBe('300.00%');
});
