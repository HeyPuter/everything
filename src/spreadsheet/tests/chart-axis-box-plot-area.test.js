// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1); };

// A box round a scientific plot, from Format Axis: each axis boxes the two plot edges it runs along, both box all four.
async function mount() {
  const doc = new Doc({ name: 'Box' }), wb = doc.wb, id = wb.activeSheetId;
  [['x', 'y'], ['1', '2'], ['2', '5'], ['3', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'scatter'));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  const box = view.el.querySelector('.chart-box');
  box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  await flush();
  return { chart: () => wb.chartById(id, chartId), wb };
}
const pane = () => view.el.querySelector('.chart-format-pane');
const boxCheck = () => [...pane().querySelectorAll('label.check')].find(n => n.textContent === 'Box around plot area')?.querySelector('input');
const border = () => view.el.querySelector('.chart-box .chart-body svg .chart-plot-border');
const set = async (input, value) => { input.value = value; input.dispatchEvent(new Event('change')); await flush(); };

const edges = key => [...view.el.querySelectorAll(`.chart-box .chart-body svg .chart-axis-box.chart-axis-${key}`)]
  .map(n => ['x1', 'y1', 'x2', 'y2'].map(k => Number(n.getAttribute(k))));
const plotRect = () => { const r = view.el.querySelector('.chart-box .chart-body svg [data-el="plotArea"]'); return ['x', 'y', 'width', 'height'].map(k => Number(r.getAttribute(k))); };
const near = (got, want) => { expect(got).toHaveLength(want.length); got.forEach((g, i) => g.forEach((v, k) => expect(v).toBeCloseTo(want[i][k], 1))); };
const formatAxis = async element => { view.run('chart', { action: 'formatPane', element }); await flush(); };

it('boxes the top and bottom of the plot from the horizontal axis, darkening its faint default line', async () => {
  const { chart } = await mount();
  await formatAxis('xAxis');
  expect(chart().appearance.axisStyles.x.color).toBe('#d9d9d9');
  boxCheck().click(); await flush();
  expect(chart().appearance.axisStyles.x).toMatchObject({ box: true, color: '#595959' });
  const [x, y, w, h] = plotRect();
  near(edges('x'), [[x, y, x + w, y], [x, y + h, x + w, y + h]]);
  expect(edges('y')).toEqual([]);
  expect(border()).toBeNull();
  // Over the gridlines, so a gridline along the top edge does not hide it.
  const svg = view.el.querySelector('.chart-box .chart-body svg'), all = [...svg.querySelectorAll('*')];
  expect(all.indexOf(svg.querySelector('.chart-axis-box'))).toBeGreaterThan(all.indexOf([...svg.querySelectorAll('.chart-gridline')].at(-1)));
  // The vertical axis is not boxed by it.
  await formatAxis('yAxis');
  expect(boxCheck().checked).toBe(false);
});

it('boxes the left and right of the plot from the vertical axis, in its own line', async () => {
  const { chart } = await mount();
  await formatAxis('yAxis');
  await set(pane().querySelector('select[aria-label="Border"]'), 'solid');
  await set(pane().querySelector('input[aria-label="Line Color"]'), '#112233');
  await set(pane().querySelector('input[aria-label="Width (pt)"]'), '1.5');
  boxCheck().click(); await flush();
  expect(chart().appearance.axisStyles.y).toMatchObject({ box: true, color: '#112233', width: 2 });
  const [x, y, w, h] = plotRect();
  near(edges('y'), [[x, y, x, y + h], [x + w, y, x + w, y + h]]);
  expect(edges('x')).toEqual([]);
  const left = view.el.querySelector('.chart-axis-box.chart-axis-y');
  expect(left.getAttribute('stroke')).toBe('#112233');
  expect(left.getAttribute('stroke-width')).toBe('2');
  // With no line, the axis draws no box either.
  await set(pane().querySelector('select[aria-label="Border"]'), 'none');
  expect(edges('y')).toEqual([]);
});

it('boxes the whole plot with both axes boxed, and unboxing one leaves the other\'s sides', async () => {
  const { chart } = await mount();
  await formatAxis('xAxis'); boxCheck().click(); await flush();
  await formatAxis('yAxis'); boxCheck().click(); await flush();
  expect(edges('x')).toHaveLength(2);
  expect(edges('y')).toHaveLength(2);
  await formatAxis('xAxis');
  expect(boxCheck().checked).toBe(true);
  boxCheck().click(); await flush();
  expect(chart().appearance.axisStyles.x.box).toBeUndefined();
  expect(edges('x')).toEqual([]);
  expect(edges('y')).toHaveLength(2);
  view.run('undo'); await flush();
  expect(edges('x')).toHaveLength(2);
});

async function reopen(wb, { own = true } = {}) {
  const blob = await workbookToXlsx(wb);
  const zip = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  const xml = new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))].content);
  if (!own) {
    // Opened as Excel would save it: without this app's own record of the workbook.
    const book = X.CFB.find(zip, '/xl/workbook.xml');
    book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
    book.size = book.content.length;
  }
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'box.xlsx');
  return { xml, chart: back.activeSheet.charts[0] };
}
const plotAreaLine = xml => /<c:plotArea>.*<\/c:valAx>(?:<c:dTable>.*<\/c:dTable>)?(<c:spPr>.*?<\/c:spPr>)?<\/c:plotArea>/.exec(xml)?.[1] || '';

it('saves a box on both axes as the plot area\'s border for Excel, and keeps each axis\' box in the app', async () => {
  const { wb } = await mount();
  await formatAxis('xAxis'); boxCheck().click(); await flush();
  await formatAxis('yAxis'); boxCheck().click(); await flush();
  const mine = await reopen(wb);
  expect(plotAreaLine(mine.xml)).toContain('<a:ln><a:solidFill><a:srgbClr val="595959">');
  expect(mine.chart.appearance.axisStyles.x.box).toBe(true);
  expect(mine.chart.appearance.axisStyles.y.box).toBe(true);
  expect(mine.chart.appearance.plotStroke).not.toBe('#595959');
  const excel = await reopen(wb, { own: false });
  expect(excel.chart.appearance.plotStroke).toBe('#595959');
});

it('writes no plot-area border for a box on one axis only', async () => {
  const { wb } = await mount();
  await formatAxis('xAxis'); boxCheck().click(); await flush();
  const { xml, chart } = await reopen(wb);
  expect(plotAreaLine(xml)).not.toContain('<a:ln>');
  expect(chart.appearance.axisStyles.x.box).toBe(true);
});
