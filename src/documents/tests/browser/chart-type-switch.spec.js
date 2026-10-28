import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A pie or doughnut chart shows one series. Passing over those types in Insert Chart (clicking them, or
// arrowing through the type list) hides the other series for as long as they are chosen, and does not
// delete them.
test('choosing a pie chart and then another type keeps every series of the data', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Insert Chart' });
  const types = chart.getByRole('listbox', { name: 'Chart type' });
  const seriesNames = chart.getByRole('textbox', { name: /^Series \d+ name$/ });
  await expect(seriesNames).toHaveCount(3);
  await chart.getByRole('textbox', { name: 'Series 2 name' }).fill('Costs');
  await chart.getByRole('textbox', { name: 'Series 1, Category 1' }).fill('7');

  await types.getByRole('option', { name: 'Pie', exact: true }).click();
  await expect(seriesNames).toHaveCount(1);
  await chart.getByRole('textbox', { name: 'Series 1, Category 2' }).fill('9');
  // From the type list with the keyboard: through Doughnut to Scatter.
  await types.getByRole('option', { name: 'Pie', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(types.getByRole('option', { name: 'Scatter', exact: true })).toHaveAttribute('aria-selected', 'true');
  await types.getByRole('option', { name: 'Clustered column', exact: true }).click();
  await expect(seriesNames).toHaveCount(3);
  await expect(chart.getByRole('textbox', { name: 'Series 2 name' })).toHaveValue('Costs');

  await chart.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(chart).toBeHidden();
  const series = await page.evaluate(() => {
    const m = window.__docs.current.view.engine.model;
    const image = m.paragraphs.flatMap(p => p.runs).find(r => r.image?.kind === 'chart').image;
    return m.assets[image.assetId].chart.series.map(s => ({ name: s.name, values: s.values ?? s.points?.map(p => p.value) }));
  });
  expect(series.map(s => s.name)).toEqual(['Series 1', 'Costs', 'Series 3']);
  expect(JSON.stringify(series[0])).toContain('7');
  expect(JSON.stringify(series[0])).toContain('9');
  expect(errors).toEqual([]);
});
