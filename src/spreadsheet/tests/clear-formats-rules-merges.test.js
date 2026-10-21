// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { parseRange } from '../src/core/cell.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const open = async (doc) => {
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
};
const setup = () => {
  const doc = new Doc({ name: 'Clear' }); const wb = doc.wb; const id = wb.activeSheetId;
  for (let r = 0; r < 10; r++) wb.setInput(id, r, 0, String(r));
  wb.mergeCells(id, parseRange('A1:B2'));
  wb.addRule(id, { range: parseRange('A1:A10'), type: 'gt', value: 0, style: { bg: '#ff0000' } });
  wb.addRule(id, { range: parseRange('D1:D5'), type: 'gt', value: 0, style: { bold: true } });
  wb.applyStyle(id, parseRange('A1:A10'), { bold: true });
  wb.clearHistory();
  return { doc, wb, id };
};
const areas = (wb, id) => wb.sheet(id).rules.map((rule) => [rule.type, rule.range]);

// Clear Formats (and Clear All) left the selection's conditional formatting and merged cells behind, so a block
// "cleared of its formatting" still lit up red and stayed merged. Excel's take both off the selected cells, and so
// do these now, in the same undo step; rules and merges outside the selection stay.
it.each(['clearFormat', 'clearAll'])('%s takes conditional formats and merges off the selection', async (command) => {
  const { doc, wb, id } = setup();
  await open(doc);
  view.goTo('A1:B5');
  view.run(command);
  expect(wb.sheet(id).merges).toEqual([]);
  expect(areas(wb, id)).toEqual([['gt', parseRange('A6:A10')], ['gt', parseRange('D1:D5')]]);
  expect(wb.conditionalStyle(id, 2, 0, wb.getValue(id, 2, 0))).toBeNull();
  expect(wb.conditionalStyle(id, 7, 0, wb.getValue(id, 7, 0))).toEqual({ bg: '#ff0000' });
  expect(wb.styleAt(id, 2, 0)?.bold).toBeFalsy();
  expect(wb.undoLabels()).toHaveLength(1);
  wb.undo();
  expect(wb.sheet(id).merges).toEqual([parseRange('A1:B2')]);
  expect(areas(wb, id)).toEqual([['gt', parseRange('A1:A10')], ['gt', parseRange('D1:D5')]]);
});
