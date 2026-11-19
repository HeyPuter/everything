import { test, expect } from '@playwright/test';
import { boot, canvasClick, canvasDrag, client, idle, openImage, run, tool } from './helpers';

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

test('the Magic Eraser erases by its opacity', async ({ page }) => {
  await tool(page, 'Magic Eraser Tool');
  await page.locator('#magic-eraser-opacity').fill('50');
  await page.locator('#magic-eraser-opacity').press('Enter');
  await canvasClick(page, 50, 50);
  await idle(page);
  const alpha = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.layer!;
    return readRGBA(e.assets.tiles, l.pixels!, { x: 50, y: 50, width: 1, height: 1 }).data[3];
  });
  expect(alpha).toBeGreaterThan(120);
  expect(alpha).toBeLessThan(135);
});

test('Sharpen with Protect Detail adds no halo beyond the neighboring values', async ({ page }) => {
  // A soft gray step: 100 on the left, 160 on the right.
  const range = async (protect: boolean) => {
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
      const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
      e.command('Step', (d) => {
        const l = d.layers[0];
        const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 200, height: 100 });
        for (let y = 0; y < 100; y++)
          for (let x = 0; x < 200; x++)
            img.data.set(x < 100 ? [100, 100, 100, 255] : [160, 160, 160, 255], (y * 200 + x) * 4);
        setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 0, 0, img), d);
      });
    });
    await idle(page);
    const box = page.locator('#sharpen-protect');
    if (protect) await box.check();
    else await box.uncheck();
    for (let i = 0; i < 4; i++)
      await canvasDrag(page, [
        [100, 20],
        [100, 80],
      ]);
    await idle(page);
    return page.evaluate(async () => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      const img = readRGBA(e.assets.tiles, e.layer!.pixels!, {
        x: 90,
        y: 50,
        width: 20,
        height: 1,
      });
      const r = Array.from({ length: 20 }, (_, i) => img.data[i * 4]);
      return [Math.min(...r), Math.max(...r)];
    });
  };
  await tool(page, 'Sharpen Tool');
  await page.locator('#tool-strength').fill('100');
  await page.locator('#tool-strength').press('Enter');
  const [lo, hi] = await range(true);
  expect(lo).toBeGreaterThanOrEqual(100);
  expect(hi).toBeLessThanOrEqual(160);
  const [lo2, hi2] = await range(false);
  expect(lo2 < 100 || hi2 > 160).toBe(true);
});
