import { test, expect, type Page } from '@playwright/test';
import { layer, newDocument, type Layer } from '../../src/model/document';
import { boot, idle, openProject, run } from './helpers';

// Two solid layers side by side: A (red, 10..90) below B (blue, 50..130).
async function fixture(page: Page, setup: (a: Layer, b: Layer) => void = () => {}) {
  const doc = newDocument(200, 100, 'Merge');
  const a = layer('solid', 'A', 80, 80),
    b = layer('solid', 'B', 80, 80);
  a.color = '#ff0000';
  b.color = '#0000ff';
  a.transform.x = 10;
  a.transform.y = 10;
  b.transform.x = 50;
  b.transform.y = 10;
  setup(a, b);
  doc.layers = [a, b];
  await openProject(page, doc, [], 'merge.photo');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selected = e.doc.layers[1].id;
    e.update();
  });
  await idle(page);
}
const layers = (page: Page) => page.evaluate(() => window.photoStudio.doc.layers.map((l) => ({ name: l.name, kind: l.kind, visible: l.visible, clipped: !!l.clipped, background: !!l.background })));
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([x, y]) => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      const l = e.doc.layers[0];
      return l.pixels ? Array.from(readRGBA(e.assets.tiles, l.pixels, { x, y, width: 1, height: 1 }).data) : null;
    },
    [x, y] as const,
  );

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Merge Down combines both layers into the lower one', async ({ page }) => {
  await fixture(page);
  await run(page, 'layer.merge-down');
  expect(await layers(page)).toEqual([{ name: 'A', kind: 'pixel', visible: true, clipped: false, background: false }]);
  expect(await pixel(page, 20, 20)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 120, 20)).toEqual([0, 0, 255, 255]);
});

test('Merge Down refuses hidden layers instead of dropping their pixels', async ({ page }) => {
  await fixture(page, (a) => (a.visible = false));
  await run(page, 'layer.merge-down');
  expect((await layers(page)).map((l) => l.name)).toEqual(['A', 'B']);
  await expect(page.locator('#status')).toHaveText('Show both layers before merging them.');
});

test('Merge Down leaves locked layers alone', async ({ page }) => {
  await fixture(page, (a) => (a.locked = true));
  const before = await page.evaluate(() => window.photoStudio.history.labels.length);
  await run(page, 'layer.merge-down');
  expect((await layers(page)).map((l) => l.name)).toEqual(['A', 'B']);
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(before);
  await expect(page.locator('#status')).toHaveText('Unlock the selected layers and their groups first.');
});

test('Merging a clipped layer into its base keeps it clipped', async ({ page }) => {
  await fixture(page, (_a, b) => (b.clipped = true));
  await run(page, 'layer.merge-down');
  expect(await layers(page)).toHaveLength(1);
  // Inside the base the clipped layer shows; outside it nothing does.
  expect(await pixel(page, 60, 20)).toEqual([0, 0, 255, 255]);
  expect((await pixel(page, 120, 20))![3]).toBe(0);
});

test('Merging into the Background keeps it the Background', async ({ page }) => {
  await fixture(page, (a) => {
    a.background = true;
    a.protection = { transparency: true, composite: false, position: true };
  });
  await run(page, 'layer.merge-down');
  expect(await layers(page)).toEqual([{ name: 'A', kind: 'pixel', visible: true, clipped: false, background: true }]);
});

test('Flatten Image leaves one opaque Background layer', async ({ page }) => {
  await fixture(page);
  await run(page, 'layer.flatten');
  expect(await layers(page)).toEqual([{ name: 'Background', kind: 'pixel', visible: true, clipped: false, background: true }]);
  // Transparency becomes white, as on a Background.
  expect(await pixel(page, 150, 50)).toEqual([255, 255, 255, 255]);
  await expect(page.locator('#layers .layer-row.background-layer')).toHaveCount(1);
});
