// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { workbookFromFile } from '../src/core/io.js';
import { Workbook } from '../src/core/workbook.js';
import { chartXlsx } from './helpers/xlsx-chart-fixture.js';
import { paretoXlsx } from './helpers/xlsx-pareto-fixture.js';
import { chartExXlsx } from './helpers/xlsx-chartex-fixture.js';
import { stackedChartXlsx } from './helpers/xlsx-stacked-chart-fixture.js';
import { regionalChartXlsx } from './helpers/xlsx-regional-chart-fixture.js';
import { progressChartXlsx } from './helpers/xlsx-progress-chart-fixture.js';
import { taskListXlsx } from './helpers/xlsx-task-list-fixture.js';
import { loanXlsx } from './helpers/xlsx-loan-fixture.js';
import { shapeXlsx } from './helpers/xlsx-shape-fixture.js';
import { buildPrintSheet } from '../src/ui/print.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1000; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function () {};
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', id => clearTimeout(id));
});
afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

it('keeps explicit chart corners in the grid and print through edits and undo, independently of the border', async () => {
  const wb = new Workbook(), sheet = wb.activeSheet;
  wb.setInput(sheet.id, 0, 0, 'Value'); wb.setInput(sheet.id, 1, 0, '8');
  const id = wb.addChart(sheet.id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 0 },
    anchor: { r: 4, c: 2 }, appearance: { roundedCorners: false, border: false } });
  const grid = createGrid({ wb, sheetId: sheet.id }); document.body.replaceChildren(grid.el);
  try {
    await flush();
    const frame = () => grid.el.querySelector('.chart-box');
    expect(frame().style.borderRadius).toBe('0px');
    expect(frame().querySelector('.chart-body').style.borderRadius).toBe('0px');
    expect(buildPrintSheet(wb, sheet.id).querySelector('.print-object > svg').hasAttribute('clip-path')).toBe(false);
    const appearance = wb.chartById(sheet.id, id).appearance;
    wb.updateChart(sheet.id, id, { appearance: { ...appearance, roundedCorners: true } }); await flush();
    expect(frame().classList.contains('borderless')).toBe(true);
    expect(parseFloat(frame().style.borderRadius)).toBeGreaterThan(0);
    expect(frame().querySelector('.chart-body').style.borderRadius).toBe(frame().style.borderRadius);
    const paper = buildPrintSheet(wb, sheet.id).querySelector('.print-object');
    expect(paper.style.backgroundColor).toBe('transparent');
    expect(paper.querySelector('svg').getAttribute('clip-path')).toMatch(/^url\(#chart-area-/);
    wb.undo(); await flush();
    expect(frame().style.borderRadius).toBe('0px');
    expect(frame().querySelector('svg').hasAttribute('clip-path')).toBe(false);
  } finally { grid.destroy(); }
});

it('updates linked titles outside a range-authored chart in the grid, print and accessible name', async () => {
  const wb = new Workbook(), sheet = wb.activeSheet, other = wb.addSheet('Labels');
  wb.setInput(sheet.id, 0, 0, 'Value'); wb.setInput(sheet.id, 1, 0, '8');
  wb.setInput(other.id, 2, 3, 'Original title');
  wb.addChart(sheet.id, { type: 'column', anchor: { r: 4, c: 2 }, range: { r1: 0, c1: 0, r2: 1, c2: 0 }, titleRef: 'Labels!D3' });
  const grid = createGrid({ wb, sheetId: sheet.id }); document.body.replaceChildren(grid.el);
  try {
    await flush();
    expect(grid.el.querySelector('[aria-label="Chart: Original title"]')).not.toBeNull();
    wb.setInput(other.id, 2, 3, 'Updated title'); await flush();
    expect(grid.el.querySelector('.chart-body').textContent).toContain('Updated title');
    expect(grid.el.querySelector('[aria-label="Chart: Updated title"]')).not.toBeNull();
    expect(buildPrintSheet(wb, sheet.id).querySelector('.print-object').textContent).toContain('Updated title');
    wb.undo(); await flush();
    expect(grid.el.querySelector('[aria-label="Chart: Original title"]')).not.toBeNull();
  } finally { grid.destroy(); }
});

it('keeps rich shape text in the document layout in the grid and print, including resize and undo', async () => {
  const wb = await workbookFromFile(shapeXlsx({ width: 165, height: 28, rotate: 23, text: 'Two lines of overflowing text' }));
  const sheet = wb.activeSheet, object = sheet.charts[0], grid = createGrid({ wb, sheetId: sheet.id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    const art = () => grid.el.querySelector('.image-box .chart-body > svg');
    expect(art().querySelector('foreignObject').textContent).toContain('Two lines of overflowing text');
    expect(art().style.overflow).toBe('visible');
    expect(art().parentElement.style.overflow).toBe('visible');
    // The whole box turns about its centre (frame and handles with it); the art inside is drawn upright.
    const turn = () => art().closest('.chart-box').style.transform.replace(/^translate\([^)]*\) ?/, '');
    expect(turn()).toBe('rotate(23deg) scale(1, 1)');
    expect(art().style.transform).toBe('');
    const paper = buildPrintSheet(wb, sheet.id).querySelector('.print-object > svg');
    expect(paper.textContent).toBe(art().textContent);
    expect(paper.style.overflow).toBe('visible');
    expect(paper.parentElement.style.overflow).toBe('visible');
    wb.updateChart(sheet.id, object.id, { w: 250, h: 70, rotation: 310 });
    await flush();
    expect(turn()).toBe('rotate(310deg) scale(1, 1)');
    expect(art().closest('.chart-box').style.width).toBe('250px');
    wb.undo();
    await flush();
    expect(art().closest('.chart-box').style.width).toBe('165px');
  } finally { grid.destroy(); }
});

it('renders compact loan rows, both charts and conditional palette colors in the grid and print', async () => {
  const wb = await workbookFromFile(loanXlsx(), 'loan.xlsx'), sheet = wb.sheets[0];
  const grid = createGrid({ wb, sheetId: sheet.id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    const input = () => grid.el.querySelector('#gc-2-1');
    expect(input().style.height).toBe('17px');
    expect(input().style.backgroundColor).toBe('rgb(255, 244, 187)');
    expect(grid.el.querySelector('#gc-1-1').style.height).toBe('26px');
    expect(grid.el.querySelectorAll('.chart-body svg')).toHaveLength(2);
    expect(grid.el.querySelector('[aria-label="Rate schedule"]')).not.toBeNull();
    let printed = buildPrintSheet(wb, sheet.id);
    expect(printed.querySelectorAll('svg')).toHaveLength(2);
    const printedInput = [...printed.querySelectorAll('td')].find(n => n.style.backgroundColor === 'rgb(255, 244, 187)');
    expect(printedInput).toBeDefined();
    const paths = () => [...grid.el.querySelectorAll('.chart-series')].map(n => n.getAttribute('d'));
    const original = paths();
    wb.setInput(sheet.id, 3, 1, '1');
    await flush();
    expect(input().style.backgroundColor).toBe('transparent');
    expect(input().style.color).toBe('windowtext');
    expect(paths().at(-1)).not.toEqual(original.at(-1));
    printed = buildPrintSheet(wb, sheet.id);
    expect([...printed.querySelectorAll('td')].some(n => n.style.backgroundColor === 'transparent' && n.style.color === 'windowtext')).toBe(true);
    wb.undo();
    await flush();
    expect(paths()).toEqual(original);
  } finally { grid.destroy(); }
});

it('renders disjoint task summaries, vector groups and bar-only progress in the grid and print', async () => {
  const wb = await workbookFromFile(taskListXlsx(), 'tasks.xlsx'), sheet = wb.sheets[0];
  const grid = createGrid({ wb, sheetId: sheet.id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    expect(grid.el.querySelectorAll('.chart-bar')).toHaveLength(4);
    expect(grid.el.querySelectorAll('.chart-box img')).toHaveLength(1);
    expect(grid.el.querySelector('#gc-0-0').style.fontFamily).toContain('Nyala');
    expect(grid.el.querySelector('#gc-4-8').textContent).toBe('');
    // Native bars default to lengths of 10–90%, interpolated at the progress value.
    const barPercent = node => Number(node.style.backgroundImage.match(/([\d.]+)%/)[1]);
    expect(barPercent(grid.el.querySelector('#gc-4-8'))).toBeCloseTo(10 + 80 / 3);
    const printed = buildPrintSheet(wb, sheet.id);
    expect(printed.querySelectorAll('.chart-bar')).toHaveLength(4);
    expect(printed.querySelector('img').src).toMatch(/^data:image\/svg\+xml;base64,/);
    const progress = [...printed.querySelectorAll('td')].find(n => n.style.backgroundImage);
    expect(progress.textContent).toBe('');
    expect(barPercent(progress)).toBeCloseTo(10 + 80 / 3);
    wb.setInput(sheet.id, 6, 5, 'Completed');
    await flush();
    expect(barPercent(grid.el.querySelector('#gc-4-8'))).toBeCloseTo(10 + 160 / 3);
    wb.setInput(sheet.id, 10, 3, '=TODAY()');
    await flush();
    expect(grid.el.textContent).toContain('This Week: 6');
    openChartDialog({ wb, sheetId: () => sheet.id, grid }, { chart: sheet.charts[1] });
    expect(document.querySelectorAll('.chart-preview .chart-bar')).toHaveLength(2);
    document.querySelector('[aria-label="Title"]').value = 'Weekly tasks';
    document.querySelector('form.chart-form').requestSubmit();
    expect(wb.sheet(sheet.id).charts[1].title).toBe('Weekly tasks');
  } finally { grid.destroy(); }
});

it('renders compact progress charts and the planner fonts in the grid and print, with live edits', async () => {
  const wb = await workbookFromFile(progressChartXlsx(), 'planner.xlsx'), sheet = wb.sheets[0];
  const grid = createGrid({ wb, sheetId: sheet.id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    const bar = () => grid.el.querySelector('.chart-bar');
    const original = +bar().getAttribute('width');
    // These native markers resize with the rows, including automatic fitting.
    const { from, to } = sheet.charts[0].cellAnchor;
    let height = to.dy - from.dy;
    for (let r = from.r; r < to.r; r++) height += wb.rowHeight(sheet.id, r);
    expect(parseFloat(grid.el.querySelector('.chart-box').style.height)).toBeCloseTo(height, 5);
    expect(grid.el.querySelector('#gc-0-0').style.fontFamily).toContain('Impact');
    expect(grid.el.querySelector('#gc-4-4').style.fontFamily).toContain('Corbel');
    expect(buildPrintSheet(wb, sheet.id).querySelectorAll('.chart-bar')).toHaveLength(1);
    wb.setInput(sheet.id, 1, 5, '3');
    await flush();
    expect(+bar().getAttribute('width') / original).toBeCloseTo(3, 2);
    wb.undo();
    await flush();
    expect(+bar().getAttribute('width')).toBe(original);
  } finally { grid.destroy(); }
});

it('keeps regional chart labels attached to the latest month in the grid, print, and chart editor', async () => {
  const wb = await workbookFromFile(regionalChartXlsx(), 'regions.xlsx'), sheet = wb.sheets[0];
  const grid = createGrid({ wb, sheetId: sheet.id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    const label = () => grid.el.querySelector('.chart-data-label');
    const original = label().getAttribute('x');
    expect(label().textContent).toBe('North');
    expect(grid.el.querySelector('.chart-box').style.width).toBe('1168px');
    expect(buildPrintSheet(wb, sheet.id).querySelectorAll('.chart-data-label')).toHaveLength(2);
    wb.setInput(sheet.id, 3, 3, '27000');
    await flush();
    expect(+label().getAttribute('x')).toBeGreaterThan(+original);
    wb.undo();
    await flush();
    expect(label().getAttribute('x')).toBe(original);
    openChartDialog({ wb, sheetId: () => sheet.id, grid }, { chart: sheet.charts[0] });
    expect(document.querySelectorAll('.chart-preview .chart-data-label')).toHaveLength(2);
    document.querySelector('[aria-label="Title"]').value = 'Monthly sales';
    document.querySelector('form.chart-form').requestSubmit();
    expect(wb.sheet(sheet.id).charts[0].title).toBe('Monthly sales');
  } finally { grid.destroy(); }
});

it('renders stacked comparisons in the grid and print with live totals and no hidden helper legend', async () => {
  const wb = await workbookFromFile(stackedChartXlsx(), 'costs.xlsx'), sheet = wb.sheets[0];
  const grid = createGrid({ wb, sheetId: sheet.id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    const svg = () => grid.el.querySelector('.chart-body svg');
    const heights = () => [...svg().querySelectorAll('.chart-column')].map(n => n.getAttribute('height'));
    const original = heights();
    expect(original).toHaveLength(6);
    expect(svg().textContent).toContain('Annual costs comparison');
    expect(svg().textContent).not.toContain('Hidden helper');
    expect(grid.el.querySelector('#gc-0-0').style.fontFamily).toContain('Tahoma');
    expect(grid.el.querySelector('.chart-box').style.width).toBe('738px');
    expect(buildPrintSheet(wb, sheet.id).querySelectorAll('.chart-column')).toHaveLength(6);
    wb.setInput(wb.sheets[1].id, 0, 0, '110');
    await flush();
    expect(heights()).not.toEqual(original);
    expect(svg().textContent).toContain('Purchase cost · Buy a car: $110');
    wb.undo();
    await flush();
    expect(heights()).toEqual(original);
  } finally { grid.destroy(); }
});

it('redraws the open chart sheet when source formulas on another sheet change, including undo', async () => {
  const wb = await workbookFromFile(chartXlsx(), 'chart.xlsx');
  const id = wb.sheets[1].id, source = wb.sheets[0].id;
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    const svg = () => grid.el.querySelector('.chart-body svg');
    const paths = () => [...svg().querySelectorAll('.chart-series')].map(p => p.getAttribute('d'));
    const original = paths(), node = svg();
    expect(original).toHaveLength(2);
    wb.setInput(source, 5, 6, 'Unrelated');
    await flush();
    expect(svg()).toBe(node);
    wb.setInput(source, 0, 1, '3.4');
    await flush();
    expect(paths()[0]).not.toBe(original[0]);
    expect(paths()[1]).not.toBe(original[1]); // the mean is a formula, not a chart cache
    wb.undo();
    await flush();
    expect(paths()).toEqual(original);
  } finally { grid.destroy(); }
});

it('edits imported source ranges in the chart dialog and keeps its design when changing the title', async () => {
  const wb = await workbookFromFile(chartXlsx(), 'chart.xlsx'), sheet = wb.sheets[1], chart = sheet.charts[0];
  document.body.innerHTML = '<div id="app"></div>';
  openChartDialog({ wb, sheetId: () => sheet.id, grid: { focus() {}, selectChart() {} } }, { chart });
  expect(document.querySelector('[aria-label="Values for series 1"]').value).toBe('Data!$B$1:$B$80');
  expect(document.querySelector('.chart-preview').textContent).toContain('Sample mean');
  document.querySelector('[aria-label="Title"]').value = 'Changed title';
  document.querySelector('[aria-label="Values for series 1"]').value = 'Data!B2:B3';
  document.querySelector('form.chart-form').requestSubmit();
  expect(wb.sheet(sheet.id).charts[0]).toMatchObject({ title: 'Changed title', appearance: chart.appearance });
  expect(wb.sheet(sheet.id).charts[0].sourceRefs[0].values).toBe('Data!B2:B3');
});

it('allows title edits with an existing deleted helper reference but rejects new invalid sources', async () => {
  const wb = await workbookFromFile(stackedChartXlsx(), 'costs.xlsx'), sheet = wb.sheets[0], chart = sheet.charts[0];
  document.body.innerHTML = '<div id="app"></div>';
  openChartDialog({ wb, sheetId: () => sheet.id, grid: { focus() {}, selectChart() {} } }, { chart });
  expect(document.querySelectorAll('.chart-preview .chart-column')).toHaveLength(6);
  document.querySelector('[aria-label="Title"]').value = 'Updated comparison';
  const helper = document.querySelector('[aria-label="Values for series 6"]');
  expect(helper.value).toBe('Summary!#REF!');
  helper.value = 'Invalid range';
  document.querySelector('form.chart-form').requestSubmit();
  expect(helper.getAttribute('aria-invalid')).toBe('true');
  expect(wb.sheet(sheet.id).charts[0].title).toBe('Annual costs comparison');
  helper.value = 'Summary!#REF!';
  document.querySelector('form.chart-form').requestSubmit();
  expect(wb.sheet(sheet.id).charts[0]).toMatchObject({ title: 'Updated comparison', appearance: chart.appearance });
  expect(wb.sheet(sheet.id).charts[0].sourceRefs[5].values).toBe('Summary!#REF!');
});

it('draws the imported Pareto bars and mirrored artwork in the grid and print view, including undo', async () => {
  const wb = await workbookFromFile(paretoXlsx(), 'pareto.xlsx'), sheet = wb.sheets[0], picture = sheet.charts[1];
  const grid = createGrid({ wb, sheetId: sheet.id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    expect(grid.el.querySelectorAll('.chart-column')).toHaveLength(3);
    expect(grid.el.querySelector('.chart-box').classList.contains('borderless')).toBe(true);
    const img = () => grid.el.querySelector('.image-box img');
    const turn = () => img().closest('.chart-box').style.transform.replace(/^translate\([^)]*\) ?/, '');
    expect(turn()).toBe('rotate(0deg) scale(-1, 1)');
    expect(img().style.transform).toBe('');
    expect(img().alt).toBe('Cost analysis illustration');
    expect(grid.el.querySelector('#gc-0-0').style.fontFamily).toContain('Aharoni');
    const printed = buildPrintSheet(wb, sheet.id);
    expect(printed.querySelectorAll('.chart-column')).toHaveLength(3);
    expect(printed.querySelector('.print-object img').closest('.print-object').style.transform).toBe('rotate(0deg) scale(-1, 1)');
    wb.updateChart(sheet.id, picture.id, { flipH: false });
    await flush();
    expect(turn()).toBe('');
    wb.undo();
    await flush();
    expect(turn()).toBe('rotate(0deg) scale(-1, 1)');
  } finally { grid.destroy(); }
});

it('renders transparent ChartEx charts, rotated pictures and sidebar shapes in the grid and print', async () => {
  const wb = await workbookFromFile(chartExXlsx(), 'defects.xlsx'), sheet = wb.sheets[0];
  const grid = createGrid({ wb, sheetId: sheet.id });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    expect(grid.el.querySelector('.chart-box').classList.contains('transparent')).toBe(true);
    expect(grid.el.querySelector('.image-box').style.transform).toMatch(/ rotate\(180deg\) scale\(1, 1\)$/);
    expect(grid.el.querySelector('.image-box img').style.transform).toBe('');
    expect(grid.el.querySelector('.image-box .chart-body').style.overflow).toBe('visible');
    expect(grid.el.querySelector('.text-body').style.backgroundColor).toBe('rgb(60, 159, 224)');
    const line = () => grid.el.querySelector('path.chart-series').getAttribute('d');
    const original = line();
    wb.setInput(sheet.id, 4, 1, '50');
    await flush();
    expect(line()).not.toBe(original);
    expect(grid.el.querySelector('.chart-column title').textContent).toContain('Salaries');
    wb.undo();
    await flush();
    expect(line()).toBe(original);
    const printed = buildPrintSheet(wb, sheet.id);
    expect(printed.querySelector('.print-object').style.backgroundColor).toBe('transparent');
    expect(printed.querySelector('.print-object img').closest('.print-object').style.transform).toBe('rotate(180deg) scale(1, 1)');
    expect(printed.querySelector('.print-object img').parentElement.style.overflow).toBe('visible');
    expect(printed.querySelector('.print-text .text-body').style.backgroundColor).toBe('rgb(60, 159, 224)');
    for (const [rotation, w, h] of [[43, 160, 90], [-27, 301, 75]]) {
      wb.updateChart(sheet.id, sheet.charts[1].id, { rotation, w, h, flipH: true, srcRect: { l: .2 }, fillRect: { b: -.2 } });
      await flush();
      const picture = grid.el.querySelector('.image-box .chart-body > svg');
      expect(picture.parentElement.style.overflow).toBe('visible');
      expect(picture.style.overflow).toBe('hidden'); // clip in picture coordinates, before rotation
      expect(picture.closest('.chart-box').style.transform).toMatch(new RegExp(` rotate\\(${(rotation + 360) % 360}deg\\) scale\\(-1, 1\\)$`));
      expect(picture.style.transform).toBe('');
      expect(picture.querySelector('svg').getAttribute('viewBox')).toBe('0.2 0 0.8 1');
      const paper = [...buildPrintSheet(wb, sheet.id).querySelectorAll('.print-object > svg[role="img"]')]
        .find(n => n.querySelector('image'));
      expect(paper.parentElement.style.overflow).toBe('visible');
      expect(paper.style.overflow).toBe('hidden');
      expect(paper.style.transform).toBe('');
      expect(paper.closest('.print-object').style.transform).toBe(`rotate(${(rotation + 360) % 360}deg) scale(-1, 1)`);
    }
    wb.updateChart(sheet.id, sheet.charts[1].id, { rotation: 0, flipH: false, srcRect: null, fillRect: null });
    await flush();
    expect(grid.el.querySelector('.image-box').style.transform).toMatch(/^translate\([^)]*\)$/);
  } finally { grid.destroy(); }
});

it('renders reference font colors in cells, table headers and print, and updates after a color edit', async () => {
  const color = { theme: 4, base: '#286844', rgb: '#286844' };
  const wb = new Workbook({ colorPalette: { theme: [null, '#000000', null, null, '#286844'] }, sheets: [{ cells: {
    '0,0': { v: 'Themed', s: { color } }, '1,0': { v: 3 },
  }, tables: [{ name: 'Items', range: { r1: 0, c1: 0, r2: 2, c2: 0 }, style: 'blue' }] }] });
  const id = wb.activeSheetId, grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  const check = color => {
    expect(grid.el.querySelector('#gc-0-0').style.color).toBe(color);
    expect([...buildPrintSheet(wb, id).querySelectorAll('td')].find(e => e.textContent === 'Themed').style.color).toBe(color);
  };
  try {
    await flush(); check('rgb(40, 104, 68)');
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { color: '#ad3456' });
    await flush(); check('rgb(173, 52, 86)');
    wb.undo(); await flush(); check('rgb(40, 104, 68)');
  } finally { grid.destroy(); }
});

it('refreshes a secondary title linked outside a range-authored chart in the grid and print', async () => {
  const wb=new Workbook(), sheet=wb.activeSheet, labels=wb.addSheet('Labels');
  [['Name','Amount','Rate'],['A','20','2'],['B','80','8']].forEach((row,r)=>row.forEach((v,c)=>wb.setInput(sheet.id,r,c,v)));
  wb.setInput(labels.id,0,0,'Original rate');
  wb.addChart(sheet.id,{type:'combo',secondaryAxis:true,y2TitleRef:'Labels!A1',anchor:{r:4,c:2},range:{r1:0,c1:0,r2:2,c2:2}});
  const grid=createGrid({wb,sheetId:sheet.id});document.body.replaceChildren(grid.el);
  try {
    await flush();expect(grid.el.querySelector('.chart-body').textContent).toContain('Original rate');
    wb.setInput(labels.id,0,0,'Updated rate');await flush();
    expect(grid.el.querySelector('.chart-body').textContent).toContain('Updated rate');
    expect(buildPrintSheet(wb,sheet.id).querySelector('.print-object').textContent).toContain('Updated rate');
    wb.undo();await flush();expect(grid.el.querySelector('.chart-body').textContent).toContain('Original rate');
  } finally {grid.destroy();}
});
