// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

// A chart in Excel's style shows data labels by its per-series label settings as well as its Labels switch. Once
// labels were taken off with Add Chart Element ▸ Data Labels ▸ None, ticking Show values in the Edit chart dialog (a
// double-click on the chart) saved with nothing drawn, in the preview or on the sheet. The box now turns the
// labels on and off as Data Labels does.
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup(subtype) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'Sales'], ['Jan', '12'], ['Feb', '15'], ['Mar', '9']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, subtype));
  const chart = () => wb.chartById(id, chartId);
  const element = (value) => wb.updateChart(id, chartId, chartElementPatch(chart(), 'dataLabels', value, { seriesCount: subtype === 'pie' ? 3 : 1 }));
  const open = () => openChartDialog({ wb, sheetId: () => id, range: () => chart().range, grid: { focus: vi.fn(), selectChart: vi.fn() } }, { chart: chart() });
  const labelsBox = () => [...document.querySelectorAll('label.check')].find(l => l.textContent.trim() === 'Show values').querySelector('input');
  const save = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save').click();
  const labels = (svg) => (svg.match(/data-el="dataLabels"|class="chart-data-label"|class="chart-pie-label"/g) || []).length;
  const drawn = () => labels(renderChartSvg(chartData(wb, id, chart()), chart(), chart().w, chart().h));
  const preview = () => labels(document.querySelector('.chart-preview').innerHTML);
  return { chart, element, open, labelsBox, save, drawn, preview };
}

it.each(['columnClustered', 'lineMarkers'])('turns the labels of a %s chart back on from the Show values box', subtype => {
  const { chart, element, open, labelsBox, save, drawn, preview } = setup(subtype);
  element('outEnd');
  expect(drawn()).toBe(3);
  element('none');
  expect(drawn()).toBe(0);
  open();
  const box = labelsBox();
  expect(box.checked).toBe(false);
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  expect(preview()).toBe(3);
  save();
  expect(chart().labels).toBe(true);
  expect(drawn()).toBe(3);
  open();
  labelsBox().checked = false;
  labelsBox().dispatchEvent(new Event('change'));
  save();
  expect(drawn()).toBe(0);
});
