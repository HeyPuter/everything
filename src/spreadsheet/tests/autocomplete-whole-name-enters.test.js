// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createFormulaHints } from '../src/ui/autocomplete.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// A defined name that longer functions also start with (Price beside PRICEDISC and PRICEMAT) kept the list open once
// typed in full, and Enter picked the name again instead of entering the formula: it took a second Enter.
function make(extra = {}) {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const accepted = [];
  const hints = createFormulaHints({ host, onAccept: (a) => accepted.push(a), ...extra });
  return { host, hints, accepted };
}
const rect = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
const keydown = (key) => new KeyboardEvent('keydown', { key, cancelable: true });

it.each(['Enter', 'Tab'])('lets %s through once a name is typed in full, spelt as the name is', (key) => {
  const { hints, accepted } = make({ extraNames: () => ['Price'] });
  hints.update('=2*price', 8, rect);
  expect(hints.isOpen).toBe(true);
  expect(hints.handleKey(keydown(key))).toBe(false);
  expect(accepted).toEqual([{ start: 3, end: 8, text: 'Price' }]);
  expect(hints.isOpen).toBe(false);
});

it('still takes the key for a name only partly typed, or a function picked from the list', () => {
  const partly = make({ extraNames: () => ['Price'] });
  partly.hints.update('=2*Pri', 6, rect);
  expect(partly.hints.handleKey(keydown('Enter'))).toBe(true);
  expect(partly.accepted[0].text).toBe('Price');
  const fn = make({ extraNames: () => ['Price'] });
  fn.hints.update('=2*Price', 8, rect);
  fn.hints.handleKey(keydown('ArrowDown'));
  expect(fn.hints.handleKey(keydown('Enter'))).toBe(true);
  expect(fn.accepted[0].text).toBe('PRICE(');
  // A function typed in full still gets its parenthesis from Enter.
  const days = make();
  days.hints.update('=DAYS', 5, rect);
  expect(days.hints.handleKey(keydown('Enter'))).toBe(true);
  expect(days.accepted[0].text).toBe('DAYS(');
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('enters a formula ending in such a name with one Enter', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Names' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 1, 5);
  wb.defineName('Price', 'Sheet1!$B$1');
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '=2*Price';
  editor.setSelectionRange(8, 8);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'e' }));
  expect(view.el.querySelector('.fx-hints').hidden).toBe(false);
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(id, 0, 0)?.f).toBe('2*Price');
  expect(wb.getValue(id, 0, 0)).toBe(10);
  view.destroy();
});
