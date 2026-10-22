// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// A new sheet lays out 100 rows and 26 columns. Commands judged a block ending on that last row (A1:B100, a list
// selected with Ctrl+A) as whole columns, as the grid had until it was fixed: Insert rows put in one row instead
// of a hundred, and Group grouped column A instead of the rows.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  const doc = new Doc({ name: 'Lines' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  for (let r = 0; r < 100; r++) { wb.setInput(id, r, 0, r + 1); wb.setInput(id, r, 1, `b${r + 1}`); }
  const view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.sheet(id).rows).toBe(100);
  return { wb, id, view };
}

it('inserts as many rows as a block down to row 100 spans', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!A1:B100');
  await view.run('insertRows', 'above');
  expect(wb.getValue(id, 0, 0)).toBe(null);
  expect(wb.getValue(id, 99, 0)).toBe(null);
  expect(wb.getValue(id, 100, 0)).toBe(1);
  view.destroy();
});

it('groups the rows of a block down to row 100, not its column', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!A1:A100');
  await view.run('group');
  expect(wb.sheet(id).groups.cols).toEqual([]);
  expect(wb.sheet(id).groups.rows).toEqual([expect.objectContaining({ from: 0, to: 99 })]);
  view.destroy();
});

it('still treats columns picked whole as whole columns', async () => {
  const { wb, id, view } = await mount();
  view.goTo('Sheet1!A:A');
  await view.run('group');
  expect(wb.sheet(id).groups.cols).toEqual([expect.objectContaining({ from: 0, to: 0 })]);
  view.goTo('Sheet1!A:B');
  await view.run('insertRows', 'above');
  expect(wb.getValue(id, 0, 0)).toBe(null);
  expect(wb.getValue(id, 1, 0)).toBe(1);
  view.destroy();
});
