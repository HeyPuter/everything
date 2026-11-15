import { test, expect } from '@playwright/test';
import { boot, canvasClick, idle, openImage, run, tool } from './helpers';

// Move tool options: Auto-Select target, Show Transform Controls, the
// distribute buttons and the overflow menu with Align to Canvas.

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ff0000');
  // A 100 x 100 layer at the top left inside a group, over a transparent canvas.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Trim', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 100, height: 100 });
      setLayerPixels(
        l,
        writeRect(e.assets.tiles, { ...l.pixels!, tiles: {}, bounds: null }, 0, 0, img),
        d,
      );
    });
    await e.runCommand('layer.group');
  });
  await idle(page);
  await tool(page, 'Move Tool');
});

test('Auto-Select picks the layer or its outermost group', async ({ page }) => {
  const bar = page.locator('#tool-options');
  await expect(bar.locator('#auto-select-target')).toHaveValue('layer');
  // A click on the content of the selected group keeps the group, so start with nothing selected.
  await page.evaluate(() => window.photoStudio.selectLayers([]));
  await canvasClick(page, 50, 50);
  expect(await page.evaluate(() => window.photoStudio.layer?.kind)).toBe('pixel');
  await bar.locator('#auto-select-target').selectOption('group');
  await canvasClick(page, 50, 50);
  expect(await page.evaluate(() => window.photoStudio.layer?.kind)).toBe('group');
  // The target only applies while Auto-Select is on.
  await bar.locator('#auto-select').uncheck();
  await expect(bar.locator('#auto-select-target')).toBeDisabled();
});

test('Show Transform Controls hides the frame until a transform starts', async ({ page }) => {
  await canvasClick(page, 50, 50);
  await expect(page.locator('[data-transform-handle="se"]')).toHaveCount(1);
  await page.locator('#show-transform-controls').uncheck();
  await expect(page.locator('[data-transform-handle="se"]')).toHaveCount(0);
  await run(page, 'edit.free-transform');
  await expect(page.locator('[data-transform-handle="se"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await idle(page);
});

test('the overflow menu lists distribute commands, and Align to Canvas aligns several layers to the canvas', async ({
  page,
}) => {
  // Two layers: ungroup, duplicate and offset the copy.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.runCommand('layer.ungroup');
    await e.runCommand('layer.duplicate');
    e.command('Offset', (d) => {
      const l = d.layers.at(-1)!;
      l.pixels = { ...l.pixels!, x: l.pixels!.x + 50, y: l.pixels!.y + 50 };
      l.transform = { ...l.transform, x: l.transform.x + 50, y: l.transform.y + 50 };
    });
    e.selectLayers(e.doc.layers.map((l) => l.id));
  });
  await idle(page);
  await expect(
    page.locator('#tool-options [data-command="layer.distribute-hcenter"]'),
  ).toBeDisabled();
  await page.locator('#move-more').click();
  const pop = page.locator('.context-menu');
  await expect(pop.getByText('Distribute', { exact: true })).toBeVisible();
  await pop.getByText('Align to Canvas').click();
  expect(await page.evaluate(() => window.photoStudio.settings.alignTo)).toBe('canvas');
  await page.locator('#tool-options [data-command="layer.align-right"]').click();
  await idle(page);
  const rights = await page.evaluate(() =>
    window.photoStudio.doc.layers.map((l) => l.transform.x + l.transform.width),
  );
  expect(rights).toEqual([400, 400]);
});
