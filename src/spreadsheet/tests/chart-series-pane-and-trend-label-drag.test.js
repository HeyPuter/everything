// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';

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

async function mount(patch = {}) {
  const doc = new Doc({ name: 'Series' }), wb = doc.wb, id = wb.activeSheetId;
  [['Month', 'North', 'South'], ['Jan', '1', '6'], ['Feb', '4', '5'], ['Mar', '9', '3'], ['Apr', '16', '2']]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, { ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 2 }, 'lineMarkers'), ...patch });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  const box = view.el.querySelector('.chart-box');
  box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  await flush();
  return { chart: () => wb.chartById(id, chartId) };
}
const svgNode = sel => view.el.querySelector(`.chart-box .chart-body svg ${sel}`);
const pane = () => view.el.querySelector('.chart-format-pane');
const menuItem = text => [...document.querySelectorAll('[role="menuitem"]')].find(n => n.textContent.includes(text));

it('opens Format Data Series from a right-click on a series, showing that series\' own line colour', async () => {
  await mount();
  const second = svgNode('path.chart-series[data-series="1"]');
  second.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await flush();
  menuItem('Format Data Series').click(); await flush();
  expect(pane().hidden).toBe(false);
  expect(pane().querySelector('.chart-pane-title').textContent).toBe('Format Data Series');
  const drawn = second.getAttribute('stroke');
  expect(drawn).not.toBe(svgNode('path.chart-series[data-series="0"]').getAttribute('stroke'));
  expect(pane().querySelector('input[aria-label="Line Color"]').value).toBe(drawn);
});

it('offers the Format pane of a trendline from a right-click on it', async () => {
  await mount({ trendline: true });
  svgNode('[data-el="trendline"][data-series="0"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await flush();
  menuItem('Format Trendline').click(); await flush();
  expect(pane().querySelector('.chart-pane-title').textContent).toBe('Format Trendline');
});

it('moves a trendline label where it is dragged, and Reset Position puts it back', async () => {
  const { chart } = await mount({ trendline: true, trendlines: [{ type: 'linear', dispEq: true }, false] });
  const label = () => svgNode('[data-el="trendlineLabel"]');
  const before = { left: Number(label().getAttribute('data-left')), top: Number(label().getAttribute('data-top')) };
  const [, , W, H] = label().closest('svg').getAttribute('viewBox').split(' ').map(Number);
  label().querySelector('text').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: 60, clientY: 130 }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: 60, clientY: 130 }));
  await flush();
  const pos = chart().trendlines[0].labelPos;
  expect(pos.x).toBeCloseTo((before.left - 40) / W, 5);
  expect(pos.y).toBeCloseTo((before.top + 30) / H, 5);
  expect(Number(label().getAttribute('data-left'))).toBeCloseTo(before.left - 40, 1);
  expect(Number(label().getAttribute('data-top'))).toBeCloseTo(before.top + 30, 1);

  view.run('chart', { action: 'formatPane', element: 'trendlineLabel:0' }); await flush();
  [...pane().querySelectorAll('button')].find(b => b.textContent === 'Reset Position').click(); await flush();
  expect(chart().trendlines[0].labelPos).toBeUndefined();
  expect(Number(label().getAttribute('data-left'))).toBeCloseTo(before.left, 1);
});

// A label dragged past the chart's edge was drawn there while it was dragged, then jumped back inside once let go;
// it stops at the edge as it is dragged, where it lands.
it('keeps a dragged trendline label inside the chart, as it will be drawn, while it is dragged', async () => {
  const { chart } = await mount({ trendline: true, trendlines: [{ type: 'linear', dispEq: true }, false] });
  const label = () => svgNode('[data-el="trendlineLabel"]');
  const box = () => ['left', 'top', 'width', 'height'].map(k => Number(label().getAttribute(`data-${k}`)));
  const [left, top, w, h] = box(), [, , W, H] = label().closest('svg').getAttribute('viewBox').split(' ').map(Number);
  for (const [x, y, at] of [[-5000, -5000, [0, 0]], [5000, 5000, [W - w, H - h]]]) {
    label().querySelector('text').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
    const shown = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(label().getAttribute('transform')).slice(1).map(Number);
    const from = box();
    expect(from[0] + shown[0]).toBeCloseTo(at[0], 1);
    expect(from[1] + shown[1]).toBeCloseTo(at[1], 1);
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y }));
    await flush();
    expect(box()[0]).toBeCloseTo(at[0], 1);
    expect(box()[1]).toBeCloseTo(at[1], 1);
    expect(chart().trendlines[0].labelPos).toEqual({ x: expect.closeTo(at[0] / W, 5), y: expect.closeTo(at[1] / H, 5) });
  }
  expect(left > 0 && top > 0).toBe(true);
});

// A button pressed in the Format pane redrew the pane and took the focus with it to the page, so someone working the
// pane from the keyboard had to find their way back to it from the top.
it('keeps the focus in the Format pane when one of its buttons is pressed', async () => {
  const { chart } = await mount({ trendline: true, trendlines: [{ type: 'linear', dispEq: true, labelPos: { x: .2, y: .2 } }, false] });
  view.run('chart', { action: 'formatPane', element: 'trendlineLabel:0' }); await flush();
  const reset = [...pane().querySelectorAll('button')].find(b => b.textContent === 'Reset Position');
  reset.focus();
  reset.click(); await flush();
  expect(chart().trendlines[0].labelPos).toBeUndefined();
  // The button is gone with the position it reset: its section takes the focus.
  expect(document.activeElement.textContent).toBe('Label Options');
  expect(pane().contains(document.activeElement)).toBe(true);
});

it('keeps a click on a trendline label from moving it', async () => {
  const { chart } = await mount({ trendline: true, trendlines: [{ type: 'linear', dispEq: true }, false] });
  const label = svgNode('[data-el="trendlineLabel"]');
  label.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: 101, clientY: 100 }));
  await flush();
  expect(chart().trendlines[0].labelPos).toBeUndefined();
  view.run('chart', { action: 'formatPane' }); await flush();
  expect(pane().querySelector('.chart-pane-title').textContent).toBe('Format Trendline Label');
});

it('saves a moved trendline label in the file and opens it in the same place', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', charts: [{ type: 'line', title: 'Trend', anchor: { r: 0, c: 3 }, range: { r1: 0, c1: 0, r2: 1, c2: 1 },
    trendline: true, trendlines: [{ type: 'linear', dispEq: true, labelPos: { x: 0.25, y: 0.125 } }],
    sourceRefs: [{ name: 'Sales', literal: { categories: ['North', 'South', 'East'], values: [3, 7, 9] } }] }] }] });
  const blob = await workbookToXlsx(wb);
  const zip = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  const xml = new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))].content);
  expect(xml).toContain('<c:trendlineLbl><c:layout><c:manualLayout><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="0.25"/><c:y val="0.125"/></c:manualLayout></c:layout>');
  // Opened as Excel would save it: without this app's own record of the workbook.
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'trend.xlsx');
  expect(back.activeSheet.charts[0].trendlines[0].labelPos).toEqual({ x: 0.25, y: 0.125 });
});

// Excel writes a trendline label it moved as an offset from where it lays the label out (factor mode). That place
// is Excel's own, so the label is drawn in the app's; but its offset was dropped too, so saving the file here put the
// label back in Excel's default place for whoever opened it in Excel next.
it('keeps the offset Excel moved a trendline label by through a save, until it is moved here', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', charts: [{ type: 'line', title: 'Trend', anchor: { r: 0, c: 3 }, range: { r1: 0, c1: 0, r2: 1, c2: 1 },
    trendline: true, trendlines: [{ type: 'linear', dispEq: true, labelPos: { x: 0.25, y: 0.125 } }],
    sourceRefs: [{ name: 'Sales', literal: { categories: ['North', 'South', 'East'], values: [3, 7, 9] } }] }] }] });
  const excel = async (book, edit = xml => xml) => {
    const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(book)).arrayBuffer()), { type: 'array' });
    const chart = zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))];
    chart.content = new TextEncoder().encode(edit(new TextDecoder().decode(chart.content))); chart.size = chart.content.length;
    const index = X.CFB.find(zip, '/xl/workbook.xml');
    index.content = new TextEncoder().encode(new TextDecoder().decode(index.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
    index.size = index.content.length;
    return { xml: new TextDecoder().decode(chart.content), back: await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'trend.xlsx') };
  };
  // The label as Excel writes one it moved: no modes, so x and y are offsets.
  const moved = '<c:trendlineLbl><c:layout><c:manualLayout><c:x val="-0.21788"/><c:y val="-6.4E-2"/></c:manualLayout></c:layout>';
  const { back } = await excel(wb, xml => xml.replace(/<c:trendlineLbl><c:layout>.*?<\/c:layout>/, moved));
  expect(back.activeSheet.charts[0].trendlines[0]).toMatchObject({ labelOffset: { x: -0.21788, y: -0.064 } });
  expect(back.activeSheet.charts[0].trendlines[0].labelPos).toBeUndefined();
  const again = await excel(back);
  expect(again.xml).toContain('<c:trendlineLbl><c:layout><c:manualLayout><c:x val="-0.21788"/><c:y val="-0.064"/></c:manualLayout></c:layout>');
  // Moved here, it takes the place it was moved to in the app's own terms instead.
  const chart = again.back.activeSheet.charts[0];
  again.back.updateChart(again.back.activeSheetId, chart.id, { trendlines: [{ ...chart.trendlines[0], labelPos: { x: 0.5, y: 0.5 } }] });
  expect(again.back.activeSheet.charts[0].trendlines[0].labelOffset).toBeUndefined();
  expect((await excel(again.back)).xml).toContain('<c:manualLayout><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="0.5"/><c:y val="0.5"/></c:manualLayout>');
});

// A left-click selects a series (all its points light up); a right-click then formats that series, not one point.
const leftClick = async node => {
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
  node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
  await flush();
};
const rightClick = async node => {
  node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await flush();
};
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map(n => n.textContent);
// jsdom lays nothing out: the series' marks get a box on screen so a selection draws their handles.
const layOutMarks = () => {
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.matches?.('[data-el="series"]') ? { left: 10, top: 10, right: 16, bottom: 16, width: 6, height: 6, x: 10, y: 10 } : real.call(this);
  });
};
const handles = () => view.el.querySelectorAll('.chart-el-overlay .chart-el-handle').length;
const marker = (j, i) => svgNode(`[data-el="series"][data-series="${j}"][data-point="${i}"]`);

it('offers Format Data Series from a right-click on a series a left-click selected', async () => {
  layOutMarks();
  await mount();
  await leftClick(marker(1, 2));
  const all = handles();
  expect(all).toBeGreaterThan(1);
  await rightClick(marker(1, 2));
  expect(menuLabels().some(t => t.includes('Format Data Series'))).toBe(true);
  expect(menuLabels().some(t => t.includes('Format Data Point'))).toBe(false);
  // Still the whole series, not a point.
  expect(handles()).toBe(all);
  menuItem('Format Data Series').click(); await flush();
  expect(pane().querySelector('.chart-pane-title').textContent).toBe('Format Data Series');
});

it('selects the series a right-click lands on, and formats a point once a left-click picked it', async () => {
  layOutMarks();
  await mount();
  expect(handles()).toBe(0);
  await rightClick(marker(0, 1));
  expect(menuLabels().some(t => t.includes('Format Data Series'))).toBe(true);
  closeMenu(); await flush();
  // The series is selected now: its points carry handles.
  expect(handles()).toBeGreaterThan(1);
  // A second left-click picks the point under it; a right-click on it then formats that point.
  await leftClick(marker(0, 1));
  await rightClick(marker(0, 1));
  // Just that point is selected: a frame round it, no handles on the rest of the series.
  expect(handles()).toBe(0);
  expect(view.el.querySelector('.chart-el-overlay .chart-el-frame')).not.toBeNull();
  expect(menuLabels().some(t => t.includes('Format Data Point'))).toBe(true);
});
