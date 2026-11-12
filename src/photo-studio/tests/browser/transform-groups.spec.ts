import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run, undo } from './helpers';

// Linked masks of groups follow Free Transform and the Move tool.

const maskAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([x, y]) => {
      const e = window.photoStudio;
      const { readMask } = await import('/src/model/tiles.ts');
      return readMask(e.assets.tiles, e.doc.layers[0].maskGrid!, { x, y, width: 1, height: 1 }).data[0];
    },
    [x, y] as const,
  );

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ff0000');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect, filledMask } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    // A 200 x 100 layer in a group whose mask reveals its left quarter.
    e.command('Trim', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 200, height: 100 });
      setLayerPixels(l, writeRect(e.assets.tiles, { ...l.pixels!, tiles: {}, bounds: null }, 0, 0, img), d);
    });
    await e.runCommand('layer.group');
    e.command('Mask', (d) => {
      d.layers[0].maskGrid = filledMask(e.assets.tiles, { x: 0, y: 0, width: 50, height: 100 });
    });
    e.selectLayers([e.doc.layers[0].id]);
  });
  await idle(page);
});

test('a group’s mask scales with it in Free Transform and moves with nudges', async ({ page }) => {
  await run(page, 'edit.free-transform');
  expect(await page.evaluate(() => window.photoStudio.transform.active)).toBe(true);
  const box = await page.locator('[data-transform-handle="se"] .handle-hit').boundingBox();
  const z = await page.evaluate(() => window.photoStudio.zoom);
  const p = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 200 * z, p.y + 100 * z, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await idle(page);
  const t = await page.evaluate(() => window.photoStudio.doc.layers[0].children[0].transform);
  expect(Math.round(t.width)).toBe(400);
  // The revealed quarter doubled too: x 0–100, y 0–200.
  expect(await maskAt(page, 90, 190)).toBe(255);
  expect(await maskAt(page, 110, 100)).toBe(0);
  await page.keyboard.press('ArrowRight');
  await idle(page);
  expect(await maskAt(page, 96, 100)).toBe(255);
  expect(await maskAt(page, 0, 100)).toBe(0);
  await undo(page);
  await undo(page);
  expect(await maskAt(page, 40, 50)).toBe(255);
  expect(await maskAt(page, 60, 50)).toBe(0);
});
