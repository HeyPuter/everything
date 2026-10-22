// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { chartData } from '../src/core/charts.js';
import { reorderSeriesFormatting } from '../src/core/chart-design.js';

// A chart keeps a series' colour, line, bars, labels and effects by its place among the series. Removing or
// moving a series in Select Data left that formatting where it was: with South coloured red, removing North
// turned the chart's only series, South, back to blue, and with North red, moving South up made South red.
// In Excel the formatting belongs to the series; it now follows the series to its new place.
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
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(1); };
const dialog = () => document.querySelector('[role="dialog"][aria-label="Select Data Source"]');

async function mount() {
  const doc = new Doc({ name: 'Charts' }); const wb = doc.wb; const id = wb.activeSheetId;
  [['Month', 'North', 'South', 'East'], ['Jan', '12', '9', '4'], ['Feb', '15', '11', '5'], ['Mar', '9', '14', '6']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  view.goTo('Sheet1!A1:D4'); await flush();
  await view.run('chart', { action: 'insert', subtype: 'columnClustered' }); await flush();
  const chart = () => wb.sheet(id).charts[0];
  const names = () => chartData(wb, id, chart()).series.map(s => s.name);
  return { wb, id, chart, names };
}
const option = name => [...dialog().querySelectorAll('[role="option"]')].find(n => n.textContent === name);

it('keeps a series colour on its series when the series before it is removed', async () => {
  const { chart, names } = await mount();
  await view.run('chart', { action: 'format', element: 'series:1', fill: '#ff0000' });
  await view.run('chart', { action: 'format', element: 'series:2', outline: '#00ff00' });
  expect(chart().colors).toEqual([null, '#ff0000']);
  await view.run('chart', { action: 'selectData' }); await flush();
  option('North').click(); await flush();
  dialog().querySelector('button[aria-label="Remove"]').click(); await flush();
  dialog().querySelector('button[type="submit"]').click(); await flush();
  expect(names()).toEqual(['South', 'East']);
  expect(chart().colors).toEqual(['#ff0000']);
  expect(chart().appearance.bars.map(b => b?.stroke ?? null)).toEqual([null, '#00ff00']);
});

it('moves a series colour with its series', async () => {
  const { chart, names } = await mount();
  await view.run('chart', { action: 'format', element: 'series:0', fill: '#ff0000' });
  await view.run('chart', { action: 'selectData' }); await flush();
  option('South').click(); await flush();
  dialog().querySelector('button[aria-label="Move Up"]').click(); await flush();
  dialog().querySelector('button[type="submit"]').click(); await flush();
  expect(names()).toEqual(['South', 'North', 'East']);
  expect(chart().colors).toEqual([null, '#ff0000']);
});

it('remaps lines, labels, effects and legend entries, and leaves pie slices alone', () => {
  const chart = { type: 'line', colors: ['#111111', '#222222'], appearance: {
    lineDefault: { width: 3, marker: false }, lines: [{ width: 1 }, { width: 2 }], effects: { 'series:0': { shadow: true }, chartArea: { shadow: true } },
    legendHidden: [1], valueLabels: [{ show: true, hidden: [2], points: [] }, { show: true, hidden: [], points: [] }] } };
  // The second series first, then one added, then the first.
  const patch = reorderSeriesFormatting(chart, [1, null, 0]);
  expect(patch.colors).toEqual(['#222222', null, '#111111']);
  expect(patch.appearance.lines).toEqual([{ width: 2 }, { width: 3, marker: false }, { width: 1 }]);
  expect(patch.appearance.effects).toEqual({ 'series:2': { shadow: true }, chartArea: { shadow: true } });
  expect(patch.appearance.legendHidden).toEqual([0]);
  expect(patch.appearance.valueLabels.map(l => l.hidden)).toEqual([[], [], [2]]);
  expect(reorderSeriesFormatting(chart, [0, 1])).toEqual({});
  expect(reorderSeriesFormatting({ type: 'pie', colors: ['#111111', '#222222'] }, [1, 0])).toEqual({});
});
