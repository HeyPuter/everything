// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartTitles } from '../src/core/charts.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup(type) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Month', 'Sales', 'Costs'], ['Jan', '100', '10'], ['Feb', '200', '15'], ['Mar', '150', '20']]
    .forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  openChartDialog({ wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 3, c2: 2 }), grid: { focus: vi.fn(), selectChart: vi.fn() } });
  document.querySelector(`[data-type="${type}"]`).click();
  const checkbox = (label) => [...document.querySelectorAll('label.check')]
    .find((node) => node.textContent === label).querySelector('input');
  return { wb, id, checkbox, preview: () => document.querySelector('.chart-preview').innerHTML };
}

it('shows live linked titles, preserves links for unrelated edits, and detaches only a title the user edits', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Live heading'); wb.setInput(id, 1, 0, '3'); wb.setInput(id, 1, 1, '4');
  const chartId = wb.addChart(id, { type: 'column', anchor: { r: 5, c: 0 }, range: { r1: 0, c1: 0, r2: 1, c2: 1 }, titleRef: 'A1', xTitleRef: 'B2' });
  const open = () => openChartDialog({ wb, sheetId: () => id, range: () => wb.chartById(id, chartId).range,
    grid: { focus: vi.fn(), selectChart: vi.fn() } }, { chart: wb.chartById(id, chartId) });
  open();
  expect(document.querySelector('[aria-label="Title"]').value).toBe('Live heading');
  expect(document.querySelector('.chart-preview').textContent).toContain('Live heading');
  document.querySelector('[aria-label="Horizontal axis title"]').value = 'Custom axis';
  document.querySelector('form').requestSubmit();
  vi.runAllTimers();
  expect(wb.chartById(id, chartId)).toMatchObject({ titleRef: 'A1', xTitle: 'Custom axis' });
  expect(wb.chartById(id, chartId).xTitleRef).toBeUndefined();
  wb.setInput(id, 0, 0, 'New heading');
  expect(chartTitles(wb, id, wb.chartById(id, chartId)).title).toBe('New heading');
  open();
  const input = document.querySelector('[aria-label="Title"]');
  input.value = 'Literal heading'; input.dispatchEvent(new Event('input', { bubbles: true }));
  vi.runAllTimers();
  expect(document.querySelector('.chart-preview').textContent).toContain('Literal heading');
  document.querySelector('form').requestSubmit();
  expect(wb.chartById(id, chartId).titleRef).toBeUndefined();
  wb.undo();
  expect(wb.chartById(id, chartId).titleRef).toBe('A1');
});

it('labels the primary gridline control clearly and retains independent category grids through edits and undo', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Name', 'Value'], ['A', '2'], ['B', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, { type: 'line', range: { r1: 0, c1: 0, r2: 2, c2: 1 }, anchor: { r: 4, c: 0 },
    gridlines: false, appearance: { xGridlines: true, gridlineStyles: { y: { color: 'none', width: 1 } } } });
  openChartDialog({ wb, sheetId: () => id, range: () => wb.chartById(id, chartId).range, grid: { focus: vi.fn(), selectChart: vi.fn() } },
    { chart: wb.chartById(id, chartId) });
  const box = [...document.querySelectorAll('label.check')].find(n => n.textContent === 'Primary value gridlines').querySelector('input');
  expect(document.querySelectorAll('.chart-preview .chart-gridline-x').length).toBeGreaterThan(0);
  expect(document.querySelector('.chart-preview .chart-gridline-y')).toBeNull();
  box.click();
  expect(document.querySelector('.chart-preview .chart-gridline-y').getAttribute('stroke')).not.toBe('none');
  expect(wb.chartById(id, chartId).gridlines).toBe(false); // Preview does not edit the workbook.
  document.querySelector('form').requestSubmit();
  expect(wb.chartById(id, chartId)).toMatchObject({ gridlines: true, appearance: { xGridlines: true } });
  wb.undo();
  expect(wb.chartById(id, chartId)).toMatchObject({ gridlines: false, appearance: { xGridlines: true } });
});

it.each([
  ['column', '100% stacked', 'stack100'],
  ['combo', 'Line on its own axis (right)', 'secondaryAxis'],
])('refreshes the %s preview immediately when %s changes', (type, label, property) => {
  const { wb, id, checkbox, preview } = setup(type);
  if (property === 'stack100') checkbox('Stacked').click();
  const before = preview();
  checkbox(label).click();
  expect(preview()).not.toBe(before);
  expect(wb.sheet(id).charts).toHaveLength(0);
  checkbox(label).click();
  expect(preview()).toBe(before);
  checkbox(label).click();
  document.querySelector('form').requestSubmit();
  expect(wb.sheet(id).charts[0][property]).toBe(true);
  wb.undo();
  expect(wb.sheet(id).charts).toHaveLength(0);
});

it('resolves source headings from live series names without overwriting name references or fallback caches', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Current'); wb.setInput(id, 0, 1, '=A1&" results"');
  const sourceRefs = [
    { name: 'Old cached heading', nameRef: 'B1', literal: { categories: ['A', 'B'], values: [3, 7] } },
    { name: 'Fallback heading', nameRef: 'C1', literal: { categories: ['A', 'B'], values: [2, 4] } },
    { literal: { categories: ['A', 'B'], values: [1, 5] } },
  ];
  const chartId = wb.addChart(id, { type: 'column', anchor: { r: 5, c: 0 }, range: { r1: 0, c1: 0, r2: 1, c2: 1 }, sourceRefs });
  const sourcesBefore = structuredClone(wb.chartById(id, chartId).sourceRefs);
  openChartDialog({ wb, sheetId: () => id, range: () => wb.chartById(id, chartId).range,
    grid: { focus: vi.fn(), selectChart: vi.fn() } }, { chart: wb.chartById(id, chartId) });
  const headings = () => [...document.querySelectorAll('input[aria-label^="Categories for series"]')]
    .map(input => input.closest('div.field').querySelector(':scope > .field-label').textContent);
  expect(headings()).toEqual(['Current results', 'Fallback heading', 'Series3']);
  expect(document.querySelector('[aria-label="Color of Current results"]')).not.toBeNull();
  expect(wb.chartById(id, chartId).sourceRefs).toEqual(sourcesBefore);
  wb.setInput(id, 0, 0, 'Revised');
  const legend = document.querySelector('[aria-label="Legend"]');
  legend.dispatchEvent(new Event('change', { bubbles: true }));
  expect(headings()[0]).toBe('Revised results');
  expect(document.querySelector('[aria-label="Color of Revised results"]')).not.toBeNull();
  document.querySelector('form').requestSubmit();
  expect(wb.chartById(id, chartId).sourceRefs).toEqual(sourcesBefore);
});

it('edits a linked secondary title independently and only shows its field for a secondary axis', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id,0,4,'Live rate');
  const chartId = wb.addChart(id,{type:'combo',secondaryAxis:true,yTitle:'Primary',y2TitleRef:'E1',
    range:{r1:0,c1:0,r2:1,c2:2},anchor:{r:4,c:0},sourceRefs:[
      {name:'Amount',literal:{categories:['A','B'],values:[20,80]}},
      {name:'Rate',literal:{categories:['A','B'],values:[2,8]}}]});
  const open = () => openChartDialog({wb,sheetId:()=>id,range:()=>wb.chartById(id,chartId).range,
    grid:{focus:vi.fn(),selectChart:vi.fn()}},{chart:wb.chartById(id,chartId)});
  open();
  const input=document.querySelector('[aria-label="Secondary axis title"]');
  expect(input.value).toBe('Live rate');expect(input.closest('label').hidden).toBe(false);
  const secondary=[...document.querySelectorAll('label.check')].find(n=>n.textContent==='Line on its own axis (right)').querySelector('input');
  secondary.click();expect(input.closest('label').hidden).toBe(true);
  secondary.click();expect(input.closest('label').hidden).toBe(false);
  document.querySelector('form').requestSubmit();
  vi.runAllTimers();
  expect(wb.chartById(id,chartId).y2TitleRef).toBe('E1');
  open();
  const edit=document.querySelector('[aria-label="Secondary axis title"]');
  edit.value='Custom rate';edit.dispatchEvent(new Event('input',{bubbles:true}));vi.runAllTimers();
  expect(document.querySelector('.chart-preview').textContent).toContain('Custom rate');
  document.querySelector('form').requestSubmit();
  expect(wb.chartById(id,chartId)).toMatchObject({yTitle:'Primary',y2Title:'Custom rate'});
  expect(wb.chartById(id,chartId).y2TitleRef).toBeUndefined();
  wb.undo();expect(wb.chartById(id,chartId).y2TitleRef).toBe('E1');
});

it('edits alternative text independently of a linked visible title with live preview and undo', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Sales'); wb.setInput(id, 1, 0, '3'); wb.setInput(id, 1, 1, '4');
  const chartId = wb.addChart(id, { type: 'column', anchor: { r: 5, c: 0 }, range: { r1: 0, c1: 0, r2: 1, c2: 1 }, titleRef: 'A1', description: 'Original alternative' });
  const open = () => openChartDialog({ wb, sheetId: () => id, range: () => wb.chartById(id, chartId).range,
    grid: { focus: vi.fn(), selectChart: vi.fn() } }, { chart: wb.chartById(id, chartId) });
  open();
  const input = document.querySelector('[aria-label="Alternative text"]');
  expect(input.value).toBe('Original alternative');
  input.value = 'Sales rise from three to four.\nAdditional context.';
  input.dispatchEvent(new Event('input', { bubbles: true })); vi.runAllTimers();
  expect(document.querySelector('.chart-preview svg').getAttribute('aria-label')).toBe(input.value);
  expect(wb.chartById(id, chartId).description).toBe('Original alternative');
  document.querySelector('form').requestSubmit();
  expect(wb.chartById(id, chartId)).toMatchObject({ titleRef: 'A1', description: input.value });
  vi.runAllTimers();
  open(); document.querySelector('[aria-label="Alternative text"]').value = ''; document.querySelector('form').requestSubmit();
  expect(wb.chartById(id, chartId).description).toBe('');
  wb.undo(); expect(wb.chartById(id, chartId).description).toBe(input.value);
});
