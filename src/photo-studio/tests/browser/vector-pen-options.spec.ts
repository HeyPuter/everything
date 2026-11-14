import { expect, test } from '@playwright/test';
import { boot, canvasClick, compositePixel, idle, openImage, tool } from './helpers';

// Pen options bar: Make buttons in Path mode, paint controls in Shape mode.
test('Make Shape turns the drawn work path into a filled shape layer', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#ffffff');
  await tool(page, 'Pen Tool');
  const bar = page.locator('#tool-options');
  await expect(bar.getByRole('group', { name: 'Make from path' })).toBeVisible();
  for (const [x, y] of [
    [40, 40],
    [200, 40],
    [200, 160],
    [40, 160],
    [40, 40],
  ] as const)
    await canvasClick(page, x, y);
  expect(await page.evaluate(() => window.photoStudio.doc.workPath?.paths.length)).toBe(1);
  await bar.getByRole('button', { name: 'Shape', exact: true }).click();
  await idle(page);
  const state = await page.evaluate(() => ({
    kind: window.photoStudio.layer?.kind,
    work: !!window.photoStudio.doc.workPath,
    label: window.photoStudio.history.labels.at(-1),
  }));
  expect(state).toEqual({ kind: 'vector', work: false, label: 'Make Shape' });
  expect((await compositePixel(page, 120, 100))[0]).toBeLessThan(128);
});

test('Pen in Shape mode shows the fill and stroke controls', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#ffffff');
  await tool(page, 'Pen Tool');
  await page.locator('#pen-mode').selectOption('shape');
  const bar = page.locator('#tool-options');
  await expect(bar.getByRole('button', { name: 'Shape fill' })).toBeVisible();
  await expect(bar.getByLabel('Stroke width (px)')).toBeVisible();
  await expect(bar.getByRole('group', { name: 'Make from path' })).toHaveCount(0);
});
