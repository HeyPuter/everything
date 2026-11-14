import { expect, test } from '@playwright/test';
import { boot, canvasDrag, compositePixel, idle, menu, openImage, tool } from './helpers';

// Layer > Combine Shapes merges the selected shape layers with a path operation.
async function twoRectangles(page: import('@playwright/test').Page) {
  await boot(page);
  await openImage(page, 300, 200, '#ffffff');
  await tool(page, 'Rectangle Tool');
  await canvasDrag(page, [
    [20, 20],
    [160, 140],
  ]);
  await page.evaluate(() => (window.photoStudio.layer!.name = 'Back'));
  await canvasDrag(page, [
    [100, 60],
    [260, 180],
  ]);
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selectLayers(e.doc.layers.filter((l) => l.kind === 'vector').map((l) => l.id));
  });
  await idle(page);
}
const ink = async (page: import('@playwright/test').Page, x: number, y: number) =>
  (await compositePixel(page, x, y))[0] < 128;

test('Subtract Front Shape cuts the front shape out of the back one and keeps the back layer', async ({
  page,
}) => {
  await twoRectangles(page);
  await menu(page, 'Layer', 'Combine Shapes', 'Subtract Front Shape');
  const state = await page.evaluate(() => {
    const e = window.photoStudio;
    const vectors = e.doc.layers.filter((l) => l.kind === 'vector');
    return {
      names: vectors.map((l) => l.name),
      ops: vectors[0]?.vector!.mask.paths.map((p) => p.operation ?? null),
      label: e.history.labels.at(-1),
    };
  });
  expect(state.names).toEqual(['Back']);
  expect(state.ops?.[1]).toBe('subtract');
  expect(state.label).toBe('Subtract Front Shape');
  expect(await ink(page, 40, 40)).toBe(true); // back only
  expect(await ink(page, 130, 100)).toBe(false); // overlap removed
  expect(await ink(page, 220, 160)).toBe(false); // front only
});

test('Unite Shapes at Overlap keeps only the shared area; Unite covers both', async ({ page }) => {
  await twoRectangles(page);
  await menu(page, 'Layer', 'Combine Shapes', 'Unite Shapes at Overlap');
  expect(await ink(page, 40, 40)).toBe(false);
  expect(await ink(page, 130, 100)).toBe(true);
  expect(await ink(page, 220, 160)).toBe(false);
  await page.keyboard.press('Meta+z');
  await idle(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selectLayers(e.doc.layers.filter((l) => l.kind === 'vector').map((l) => l.id));
  });
  await menu(page, 'Layer', 'Combine Shapes', 'Unite Shapes');
  expect(
    await page.evaluate(
      () => window.photoStudio.doc.layers.filter((l) => l.kind === 'vector').length,
    ),
  ).toBe(1);
  for (const [x, y] of [
    [40, 40],
    [130, 100],
    [220, 160],
  ])
    expect(await ink(page, x, y)).toBe(true);
});

test('Subtract Shapes at Overlap removes only the overlap', async ({ page }) => {
  await twoRectangles(page);
  await menu(page, 'Layer', 'Combine Shapes', 'Subtract Shapes at Overlap');
  expect(await ink(page, 40, 40)).toBe(true);
  expect(await ink(page, 130, 100)).toBe(false);
  expect(await ink(page, 220, 160)).toBe(true);
});
