import { test, expect } from '@playwright/test';
import { boot, canvasClick, client, idle, openImage, run, tool } from './helpers';

// Sampling options: the Eyedropper's ring and layer choices, the Magic Wand's
// sample size and Select Subject in the assisted selection tools.

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 100, '#ff0000');
});

test('the Eyedropper shows its sampling ring while dragging, unless turned off', async ({
  page,
}) => {
  await tool(page, 'Eyedropper Tool');
  const ring = page.locator('.sampling-ring');
  const [x, y] = await client(page, 50, 50);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(ring).toHaveCount(1);
  await page.mouse.move(x + 10, y);
  await page.mouse.up();
  await expect(ring).toHaveCount(0);
  expect(await page.evaluate(() => window.photoStudio.color)).toBe('#ff0000');
  await page.locator('#sampling-ring').uncheck();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 5, y);
  await expect(ring).toHaveCount(0);
  await page.mouse.up();
});

test('Current & Below ignores the layers above', async ({ page }) => {
  // A blue layer above the red image; the red layer stays selected.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const red = e.selected;
    await e.runCommand('layer.new-quick');
    e.setForeground('#0000ff');
    await e.runCommand('edit.fill-foreground');
    e.selectLayers([red]);
    e.update();
  });
  await idle(page);
  await tool(page, 'Eyedropper Tool');
  const sample = page.locator('#sample-layers');
  await expect(sample.locator('option')).toHaveText([
    'Current Layer',
    'Current & Below',
    'All Layers',
    'All Layers No Adjustments',
    'Current & Below No Adjustments',
  ]);
  await sample.selectOption('all');
  await canvasClick(page, 20, 20);
  await expect.poll(() => page.evaluate(() => window.photoStudio.color)).toBe('#0000ff');
  await sample.selectOption('below');
  await canvasClick(page, 30, 30);
  await expect.poll(() => page.evaluate(() => window.photoStudio.color)).toBe('#ff0000');
});

test('the Magic Wand offers a sample size and Select Subject', async ({ page }) => {
  await tool(page, 'Magic Wand Tool');
  const size = page.locator('#wand-sample-size');
  await size.selectOption('5');
  expect(await page.evaluate(() => window.photoStudio.settings.wandSampleSize)).toBe(5);
  await canvasClick(page, 50, 50);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject({
    x: 0,
    y: 0,
    width: 200,
    height: 100,
  });
  await expect(
    page.locator('#tool-options').getByRole('button', { name: 'Select Subject' }),
  ).toBeEnabled();
  await tool(page, 'Object Selection Tool');
  await expect(
    page.locator('#tool-options').getByRole('button', { name: 'Select Subject' }),
  ).toBeVisible();
  await tool(page, 'Quick Selection Tool');
  await expect(
    page.locator('#tool-options').getByRole('button', { name: 'Select Subject' }),
  ).toBeVisible();
  await run(page, 'select.deselect');
});
