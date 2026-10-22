// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// On a protected sheet a formula can be typed into an unlocked cell (a form's entry cells), yet AutoSum (Alt+=),
// Insert Function, a name from Use in Formula and Insert Symbol refused the whole sheet with "is protected". As in
// Excel they now act on an unlocked cell; a locked one still refuses them.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Form' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  [1, 2, 3].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.defineName('Rate', 'Sheet1!$A$1');
  for (const r of [3, 4]) wb.applyStyle(id, { r1: r, c1: 0, r2: r, c2: 0 }, { locked: false });
  wb.setSheetProtected(id, true);
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const editor = view.el.querySelector('.grid-editor');
  return { wb, id, view, editor };
}

it('sums into an unlocked cell with AutoSum', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!A4');
  await view.run('autosum');
  expect(wb.getCell(id, 3, 0)?.f).toBe('SUM(A1:A3)');
  expect(wb.getValue(id, 3, 0)).toBe(6);
  view.destroy();
});

it('starts a formula in an unlocked cell from a name or a function, and a symbol', async () => {
  const { view, editor } = await mount();
  view.goTo('Sheet1!A5');
  await view.run('useName', 'Rate');
  expect(editor.hidden).toBe(false);
  expect(editor.value).toBe('=Rate');
  view.destroy();
  const second = await mount();
  second.view.goTo('Sheet1!A5');
  await second.view.run('insertSymbol', '€');
  expect(second.editor.hidden).toBe(false);
  expect(second.editor.value).toBe('€');
  second.view.destroy();
});

it('still refuses them on a locked cell', async () => {
  const { wb, id, view, editor } = await mount();
  view.goTo('Sheet1!B1');
  await view.run('autosum');
  await view.run('useName', 'Rate');
  expect(wb.getCell(id, 0, 1)).toBeFalsy();
  expect(editor.hidden).toBe(true);
  view.destroy();
});
