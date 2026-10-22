// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Fill Down (Ctrl+D) over whole columns copied the first row into all 1,048,575 rows below it: a gigabyte of memory
// for one column of formulas, and a sheet selected whole with Ctrl+A ran the page out of memory. Whole columns now
// fill as far as the sheet's content goes, as the data commands take them.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Fill' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  for (let r = 0; r < 50; r++) wb.setInput(id, r, 1, r + 1);
  wb.setInput(id, 0, 2, '=B1*2');
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, view };
}

it('fills a whole column down through the last row of the data', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!C:C');
  await view.run('fillDown');
  expect(wb.getCell(id, 49, 2)?.f).toBe('B50*2');
  expect(wb.getValue(id, 49, 2)).toBe(100);
  expect(wb.getCell(id, 50, 2)).toBeFalsy();
  expect(wb.sheet(id).cells.size).toBe(100);
  wb.undo();
  expect(wb.getCell(id, 1, 2)).toBeFalsy();
  view.destroy();
});

it('fills a sheet selected whole without running out of memory', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!A1:XFD1048576');
  await view.run('fillDown');
  expect(wb.getValue(id, 49, 1)).toBe(1);
  expect(wb.getCell(id, 49, 2)?.f).toBe('B50*2');
  expect(wb.sheet(id).cells.size).toBe(100);
  view.destroy();
});

it('still fills a block of cells as selected', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!C1:C80');
  await view.run('fillDown');
  expect(wb.getCell(id, 79, 2)?.f).toBe('B80*2');
  view.destroy();
});
