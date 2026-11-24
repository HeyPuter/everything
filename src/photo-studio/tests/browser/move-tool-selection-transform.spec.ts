import { test, expect } from '@playwright/test';
import { boot, client, idle, layerPixel, openImage, selectRect, tool } from './helpers';

// Move tool > Show Transform Controls with a selection on a pixel layer: the
// frame encloses the selected pixels and its handles transform them (not the
// whole layer).

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ff0000');
  await tool(page, 'Move Tool');
  await selectRect(page, { x: 100, y: 100, width: 100, height: 80 });
});

const handleAt = (page: import('@playwright/test').Page, name: string) =>
  page.evaluate((name) => {
    const c = document.querySelector(`[data-transform-handle="${name}"] .handle-hit`);
    return c && [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))];
  }, name);

test('the frame encloses the selection and its handles scale the selected pixels', async ({
  page,
}) => {
  expect(await handleAt(page, 'nw')).toEqual([100, 100]);
  expect(await handleAt(page, 'se')).toEqual([200, 180]);

  // A corner keeps proportions: 100 x 80 becomes 50 x 40.
  const from = await client(page, 200, 180),
    to = await client(page, 150, 140);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 6 });
  await page.mouse.up();
  await idle(page);
  expect(
    await page.evaluate(
      async () => (await import('/src/features/transform/session-state.ts')).currentSession()?.mode,
    ),
  ).toBe('free');
  await page.keyboard.press('Enter');
  await idle(page);

  const state = await page.evaluate(() => {
    const e = window.photoStudio;
    return {
      transform: e.layer!.transform,
      selection: e.doc.selection,
      label: e.history.labels.at(-1),
      tool: e.tool,
    };
  });
  // The layer keeps its size; the selection follows the scaled pixels.
  expect(state.transform).toMatchObject({ x: 0, y: 0, width: 400, height: 300 });
  expect(state.label).toBe('Transform');
  expect(state.tool).toBe('move');
  expect(state.selection!.x).toBeCloseTo(100, -0.5);
  expect(state.selection!.y).toBeCloseTo(100, -0.5);
  expect(state.selection!.width).toBeLessThanOrEqual(52);
  expect(state.selection!.height).toBeLessThanOrEqual(42);
  // The scaled pixels, the hole they left and the untouched rest of the layer.
  expect(await layerPixel(page, 120, 120)).toEqual([255, 0, 0, 255]);
  expect((await layerPixel(page, 190, 170))[3]).toBe(0);
  expect(await layerPixel(page, 300, 250)).toEqual([255, 0, 0, 255]);
});

test('without a selection the handles still frame the layer', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.runCommand('select.deselect'));
  await idle(page);
  expect(await handleAt(page, 'se')).toEqual([400, 300]);
});
