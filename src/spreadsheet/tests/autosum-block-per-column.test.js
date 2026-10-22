// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// AutoSum (Alt+=) over a block of numbers put one =SUM(A1:C5) under the first column, adding the three columns
// together, where Excel totals each column under it. Each column now gets its own total, in one undo step.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Totals' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) wb.setInput(id, r, c, (c + 1) * 10 + r);
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, view };
}

it('totals each selected column in the row under the block', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!A1:C5');
  await view.run('autosum');
  expect(wb.getCell(id, 5, 0)?.f).toBe('SUM(A1:A5)');
  expect(wb.getCell(id, 5, 1)?.f).toBe('SUM(B1:B5)');
  expect(wb.getCell(id, 5, 2)?.f).toBe('SUM(C1:C5)');
  expect(wb.getValue(id, 5, 0)).toBe(60);
  wb.undo();
  expect(wb.getCell(id, 5, 0)).toBeFalsy();
  expect(wb.getCell(id, 5, 2)).toBeFalsy();
  view.destroy();
});

it('fills an empty last row taken into the selection', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!A1:C6');
  await view.run('autosum');
  expect(wb.getCell(id, 5, 1)?.f).toBe('SUM(B1:B5)');
  expect(wb.getCell(id, 6, 1)).toBeFalsy();
  view.destroy();
});

it('still sums a single column under it', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!B1:B5');
  await view.run('autosum');
  expect(wb.getCell(id, 5, 1)?.f).toBe('SUM(B1:B5)');
  expect(wb.getCell(id, 5, 0)).toBeFalsy();
  view.destroy();
});
