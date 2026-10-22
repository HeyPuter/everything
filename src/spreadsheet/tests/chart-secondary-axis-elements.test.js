// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartDesignGroups } from '../src/ui/chart-ribbon.js';
import { runChartAction } from '../src/ui/chart-actions.js';

// A combo chart's secondary axis, once deleted (select it, press Delete), could not be brought back: Add Chart
// Element ▸ Axes offered the horizontal and vertical axes only, and Axis Titles had no title for it either.
// Both now list the Secondary Vertical axis of a chart that has one, as Excel does.
function setup(subtype) {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'Sales', 'Margin'], ['Jan', 100, 0.2], ['Feb', 150, 0.3]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 2, c2: 2 }, subtype));
  const ctx = { wb, sheetId: () => id, grid: { selectedChart: chartId }, chartUi: null };
  const submenu = label => chartDesignGroups()[0][1].resolve(null, ctx).submenu.find(i => i.label === label).submenu;
  const pick = (menu, label) => { const item = submenu(menu).find(i => i.label === label); runChartAction(ctx, item.arg); return item; };
  return { wb, id, chart: () => wb.chartById(id, chartId), submenu, pick };
}

it('turns the secondary axis and its title off and on again', () => {
  const { chart, submenu, pick } = setup('comboColumnLineSecondary');
  expect(submenu('Axes').find(i => i.label === 'Secondary Vertical Axis').checked).toBe(true);
  pick('Axes', 'Secondary Vertical Axis');
  expect(chart().appearance.hideY2Axis).toBe(true);
  expect(submenu('Axes').find(i => i.label === 'Secondary Vertical Axis').checked).toBe(false);
  pick('Axes', 'Secondary Vertical Axis');
  expect(chart().appearance.hideY2Axis).toBe(false);
  pick('Axis Titles', 'Secondary Vertical Axis Title');
  expect(chart().y2Title).toBe('Axis Title');
  expect(chart().yTitle).toBe('');
  pick('Axis Titles', 'Secondary Vertical Axis Title');
  expect(chart().y2Title).toBe('');
});

it('offers no secondary axis on a chart without one', () => {
  const { submenu } = setup('comboColumnLine');
  expect(submenu('Axes').map(i => i.label)).not.toContain('Secondary Vertical Axis');
  expect(submenu('Axis Titles').map(i => i.label)).not.toContain('Secondary Vertical Axis Title');
});

// The Chart Elements box (Format ▸ Current Selection), the keyboard's way to an element, did not list the
// secondary axis, so its Format pane could only be reached with the pointer.
it('lists the secondary axis in the Chart Elements box while it is shown', async () => {
  const { chartElementKeys } = await import('../src/ui/chart-ribbon.js');
  const { chart, pick } = setup('comboColumnLineSecondary');
  expect(chartElementKeys(chart(), 2)).toContain('y2Axis');
  pick('Axes', 'Secondary Vertical Axis');
  expect(chartElementKeys(chart(), 2)).not.toContain('y2Axis');
  expect(chartElementKeys(setup('comboColumnLine').chart(), 2)).not.toContain('y2Axis');
});
