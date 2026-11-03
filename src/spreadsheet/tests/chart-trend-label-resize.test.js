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
  return { chart: () => wb.chartById(id, chartId), wb, id };
}
const svgNode = sel => view.el.querySelector(`.chart-box .chart-body svg ${sel}`);
const pane = () => view.el.querySelector('.chart-format-pane');

const pd = (node, x, y) => node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
const pu = (x, y) => window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y }));
const label = () => svgNode('[data-el="trendlineLabel"]');
const box = node => ['left', 'top', 'width', 'height', 'size'].reduce((o, k) => ({ ...o, [k]: Number(node.getAttribute(`data-${k}`)) }), {});
// jsdom lays nothing out: the label is given a box on screen so its selection frame is drawn.
function layOutLabel() {
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.closest?.('[data-el="trendlineLabel"]') ? { left: 40, top: 30, right: 140, bottom: 50, width: 100, height: 20, x: 40, y: 30 } : real.call(this);
  });
}
async function selectLabel() {
  pd(label(), 100, 100); pu(100, 100); await flush();
}
const corner = c => view.el.querySelector(`.chart-el-frame.resizable .chart-el-corner.${c}`);
const LABEL = { trendline: true, trendlines: [{ type: 'linear', dispEq: true }, false] };

it('shows resize corners with a Resize hint on a selected trendline label, not on other elements', async () => {
  layOutLabel();
  await mount(LABEL);
  await selectLabel();
  for (const c of ['nw', 'ne', 'sw', 'se']) expect(corner(c)?.title).toBe('Resize');
  pd(svgNode('[data-el="trendline"][data-series="0"]'), 5, 5); pu(5, 5); await flush();
  expect(view.el.querySelector('.chart-el-frame.resizable')).toBeNull();
});

it('scales a trendline label from its bottom-right corner, its top-left staying put', async () => {
  layOutLabel();
  const { chart } = await mount(LABEL);
  await selectLabel();
  const before = box(label()), [, , W, H] = label().closest('svg').getAttribute('viewBox').split(' ').map(Number);
  // Along the diagonal by half the label's own width and height: half as large again.
  pd(corner('se'), 0, 0);
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: before.width / 2, clientY: before.height / 2 }));
  expect(label().getAttribute('transform')).toContain('scale(1.5)');
  pu(before.width / 2, before.height / 2); await flush();
  const t = chart().trendlines[0];
  expect(t.labelSize).toBeCloseTo(before.size * 1.5, 1);
  expect(t.labelPos.x).toBeCloseTo(before.left / W, 4);
  expect(t.labelPos.y).toBeCloseTo(before.top / H, 4);
  const after = box(label());
  expect(after.size).toBeCloseTo(before.size * 1.5, 1);
  expect(after.left).toBeCloseTo(before.left, 0);
  expect(after.top).toBeCloseTo(before.top, 0);
  expect(label().querySelector('text').getAttribute('font-size')).toBe(String(after.size));
  expect(after.width).toBeGreaterThan(before.width * 1.3);
  view.run('undo'); await flush();
  expect(chart().trendlines[0].labelSize).toBeUndefined();
});

it('shrinks a trendline label from its top-left corner, its bottom-right staying put', async () => {
  layOutLabel();
  const { chart } = await mount(LABEL);
  await selectLabel();
  const before = box(label());
  pd(corner('nw'), 0, 0);
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: before.width / 4, clientY: before.height / 4 }));
  pu(before.width / 4, before.height / 4); await flush();
  expect(chart().trendlines[0].labelSize).toBeCloseTo(before.size * .75, 1);
  const after = box(label());
  expect(after.top + after.height).toBeCloseTo(before.top + before.height, 0);
  expect(after.left + after.width).toBeCloseTo(before.left + before.width, 0);
});

it('keeps a resized label within 4pt to 72pt, and a press on a corner that barely moves changes nothing', async () => {
  layOutLabel();
  // A chart large enough to hold the label at 72pt from its top-left corner, so only the size limit stops it.
  const { chart } = await mount({ ...LABEL, w: 2400, h: 1600, trendlines: [{ type: 'linear', dispEq: true, labelPos: { x: 0, y: 0 } }, false] });
  await selectLabel();
  pd(corner('se'), 0, 0); pu(1, 1); await flush();
  expect(chart().trendlines[0].labelSize).toBeUndefined();
  pd(corner('se'), 0, 0); pu(5000, 5000); await flush();
  expect(chart().trendlines[0].labelSize).toBe(96);
  await selectLabel();
  pd(corner('nw'), 0, 0); pu(5000, 5000); await flush();
  expect(chart().trendlines[0].labelSize).toBeCloseTo(5.33, 2);
});

// A label grown past the chart's edge was drawn past it while the corner was dragged, then, let go, was drawn
// pulled back inside the chart, away from the corner that was meant to stay put.
it('stops growing a trendline label at the chart\'s edge, its other corner staying put', async () => {
  layOutLabel();
  const { chart } = await mount(LABEL);
  await selectLabel();
  for (const [c, x, y] of [['se', 5000, 5000], ['nw', -5000, -5000]]) {
    const before = box(label()), [, , W, H] = label().closest('svg').getAttribute('viewBox').split(' ').map(Number);
    pd(corner(c), 0, 0);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
    const scale = Number(/scale\(([\d.e-]+)\)/.exec(label().getAttribute('transform'))[1]);
    // Shown no larger than the room between the corner that stays and the chart's edge.
    if (c === 'se') expect(Math.max(before.left + before.width * scale - W, before.top + before.height * scale - H)).toBeLessThan(.01);
    else expect(Math.min(before.left + before.width * (1 - scale), before.top + before.height * (1 - scale))).toBeGreaterThan(-.01);
    pu(x, y); await flush();
    const after = box(label());
    expect(chart().trendlines[0].labelSize).toBeGreaterThan(before.size);
    if (c === 'se') {
      expect(after.left).toBeCloseTo(before.left, 0);
      expect(after.top).toBeCloseTo(before.top, 0);
    } else {
      expect(after.left + after.width).toBeCloseTo(before.left + before.width, 0);
      expect(after.top + after.height).toBeCloseTo(before.top + before.height, 0);
    }
    expect(after.left >= -.01 && after.top >= -.01 && after.left + after.width <= W + .01 && after.top + after.height <= H + .01).toBe(true);
    await selectLabel();
  }
});

it('does not resize a trendline label on a protected sheet', async () => {
  layOutLabel();
  const { chart, wb, id } = await mount(LABEL);
  await selectLabel();
  expect(corner('se')).not.toBeNull();
  wb.setSheetProtected(id, true); await flush();
  expect(view.el.querySelector('.chart-el-frame.resizable')).toBeNull();
  const plain = view.el.querySelector('.chart-el-frame .chart-el-corner.se');
  if (plain) { pd(plain, 0, 0); pu(50, 50); await flush(); }
  expect(chart().trendlines[0].labelSize).toBeUndefined();
});

it('sets a trendline label\'s text size from Format Trendline Label, and blank goes back to the axis\' size', async () => {
  const { chart } = await mount(LABEL);
  const auto = box(label()).size;
  view.run('chart', { action: 'formatPane', element: 'trendlineLabel:0' }); await flush();
  const input = () => pane().querySelector('input[aria-label="Font Size (pt)"]');
  expect(input().value).toBe('');
  expect(input().placeholder).toBe(String(Math.round(auto * 3 / 4 * 10) / 10));
  input().value = '18'; input().dispatchEvent(new Event('change')); await flush();
  expect(chart().trendlines[0].labelSize).toBe(24);
  expect(box(label()).size).toBe(24);
  input().value = '200'; input().dispatchEvent(new Event('change')); await flush();
  expect(chart().trendlines[0].labelSize).toBe(24);
  input().value = ''; input().dispatchEvent(new Event('change')); await flush();
  expect(chart().trendlines[0].labelSize).toBeUndefined();
  expect(box(label()).size).toBe(auto);
});

it('saves a trendline label\'s text size in the file and opens it at that size', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', charts: [{ type: 'line', title: 'Trend', anchor: { r: 0, c: 3 }, range: { r1: 0, c1: 0, r2: 1, c2: 1 },
    trendline: true, trendlines: [{ type: 'linear', dispEq: true, labelSize: 24 }],
    sourceRefs: [{ name: 'Sales', literal: { categories: ['North', 'South', 'East'], values: [3, 7, 9] } }] }] }] });
  const blob = await workbookToXlsx(wb);
  const zip = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  const xml = new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))].content);
  expect(xml).toMatch(/<c:numFmt formatCode="General" sourceLinked="0"\/><c:txPr>.*?<a:defRPr sz="1800">.*?<\/c:txPr><\/c:trendlineLbl>/);
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'trend.xlsx');
  expect(back.activeSheet.charts[0].trendlines[0].labelSize).toBe(24);
});
