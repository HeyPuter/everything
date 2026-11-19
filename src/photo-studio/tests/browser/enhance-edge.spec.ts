import { expect, test, type Page } from '@playwright/test';
import { boot, historyLabels, idle, menu, panel, redo, run, undo } from './helpers';

// Layer → Layer Mask → Enhance Edge: one-click refinement of a mask's edge.

test.beforeEach(async ({ page }) => {
  await boot(page);
  // A bright subject on the left of x = 300 over a dark background, with a
  // rough mask that stops 4 px short of the subject's edge.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(600, 400);
    const g = c.getContext('2d')!;
    g.fillStyle = '#202830';
    g.fillRect(0, 0, 600, 400);
    g.fillStyle = '#e8d0a0';
    g.fillRect(0, 0, 300, 400);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'subject.png');
  });
  await idle(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
    const m = new Uint8Array(600 * 400);
    for (let y = 0; y < 400; y++) for (let x = 0; x < 296; x++) m[y * 600 + x] = 255;
    const grid = writeRect(e.assets.tiles, emptyGrid(1), 0, 0, {
      width: 600,
      height: 400,
      data: m,
    });
    e.command('Rough Mask', (d) => void (d.layers[0].maskGrid = grid));
    e.selectLayers([e.doc.layers[0].id]);
  });
  await idle(page);
});

const maskRow = (page: Page, xs: number[]) =>
  page.evaluate(async (xs) => {
    const e = window.photoStudio;
    const { readMask } = await import('/src/model/tiles.ts');
    const m = readMask(e.assets.tiles, e.doc.layers[0].maskGrid!, {
      x: 0,
      y: 200,
      width: 600,
      height: 1,
    });
    return xs.map((x) => m.data[x]);
  }, xs);

test('enhances the mask edge in one undoable step', async ({ page }) => {
  expect(await maskRow(page, [100, 298, 299, 302, 500])).toEqual([255, 0, 0, 0, 0]);
  await menu(page, 'Layer', 'Layer Mask', 'Enhance Edge');
  await page.waitForFunction(() => window.photoStudio.history.labels.at(-1) === 'Enhance Edge');
  await idle(page);
  // The edge moved onto the subject's edge; far pixels kept their values.
  let row = await maskRow(page, [100, 298, 299, 302, 500]);
  expect(row[0]).toBe(255);
  expect(row[1]).toBe(255);
  expect(row[2]).toBeGreaterThan(200);
  expect(row[3]).toBe(0);
  expect(row[4]).toBe(0);
  expect(await historyLabels(page)).toEqual(['Rough Mask', 'Enhance Edge']);

  await undo(page);
  expect(await maskRow(page, [100, 298, 299, 302, 500])).toEqual([255, 0, 0, 0, 0]);
  expect(await historyLabels(page)).toEqual(['Rough Mask']);
  await redo(page);
  row = await maskRow(page, [298]);
  expect(row[0]).toBe(255);
});

test('runs from the mask section of the Properties panel', async ({ page }) => {
  await panel(page, 'Properties');
  const button = page.locator('#properties .mask-edge').getByRole('button', { name: 'Enhance' });
  await expect(button).toBeVisible();
  await button.click();
  await page.waitForFunction(() => window.photoStudio.history.labels.at(-1) === 'Enhance Edge');
  await idle(page);
  expect((await maskRow(page, [298]))[0]).toBe(255);
  // A mask without an edge is explained, not changed.
  await run(page, 'layer.mask-reveal-all');
  const before = (await historyLabels(page)).length;
  await run(page, 'layer.mask-enhance-edge');
  await expect(page.locator('#status')).toContainText(/no edge to enhance/i);
  expect((await historyLabels(page)).length).toBe(before);
});
