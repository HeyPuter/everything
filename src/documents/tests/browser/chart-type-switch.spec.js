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

// Chart parts hold values up to a trillion either way. A larger value used to be saved as exactly a trillion,
// with nothing said; it is now marked in the grid and refused with a message.
test('a chart value too large to store is refused instead of saved as a trillion', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Insert Chart' });
  const cell = chart.getByRole('textbox', { name: 'Series 1, Category 1' });
  await cell.fill('2500000000000');
  await expect(cell).toHaveAttribute('aria-invalid', 'true');
  await chart.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(chart.getByRole('alert')).toContainText('“2500000000000” (Series 1, Category 1) is too large for a chart');
  await expect(chart).toBeVisible();
  // The largest value that can be kept is accepted, and kept exactly.
  await cell.fill('-1000000000000');
  await expect(cell).not.toHaveAttribute('aria-invalid', 'true');
  await chart.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(chart).toBeHidden();
  const values = await page.evaluate(() => {
    const m = window.__docs.current.view.engine.model;
    const image = m.paragraphs.flatMap(p => p.runs).find(r => r.image?.kind === 'chart').image;
    return m.assets[image.assetId].chart.series[0].values;
  });
  expect(values[0]).toBe(-1e12);
  expect(errors).toEqual([]);
});

// Adding or removing a row or series rebuilds the data grid. The button used went with it, and keyboard
// focus fell out of the dialog; it now goes to the control that takes the button's place.
test('the chart data grid keeps keyboard focus when rows and series are added or removed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Insert Chart' });
  const focused = () => page.evaluate(() => document.activeElement.getAttribute('aria-label') || document.activeElement.textContent);
  await chart.getByRole('button', { name: 'Remove Category 2', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(chart.getByRole('textbox', { name: /^Category \d$/ })).toHaveCount(3);
  // The row that moved up into its place.
  expect(await focused()).toBe('Remove Category 3');
  await page.keyboard.press('Space');
  expect(await focused()).toBe('Remove Category 4');
  await page.keyboard.press('Enter');
  // The last one left cannot be removed: on to + Row, which adds a row ready to name (typing replaces its name).
  expect(await focused()).toBe('+ Row');
  await page.keyboard.press('Enter');
  expect(await focused()).toBe('Category 2');
  await page.keyboard.type('North');
  await expect(chart.getByRole('textbox', { name: 'Category 2', exact: true })).toHaveValue('North');
  await chart.getByRole('button', { name: '+ Series', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect(await focused()).toBe('Series 4 name');
  await chart.getByRole('button', { name: '− Series', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect(await focused()).toBe('− Series');
});
