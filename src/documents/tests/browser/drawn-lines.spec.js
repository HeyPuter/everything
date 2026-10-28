import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Insert → Shapes → Line draws from where the drag starts to where it ends: slanted, vertical or
// horizontal; and a slanted line stays slanted when its outline is changed.
const line = page => page.evaluate(() => {
  const image = window.__docs.current.view.engine.model.selectedImage;
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(image.shell), xfrm = /<a:xfrm\b([^>]*)>/.exec(image.shell)?.[1] || '';
  return { width: image.width, height: image.height, ext: ext && [Number(ext[1]), Number(ext[2])], flipH: /flipH="1"/.test(xfrm), flipV: /flipV="1"/.test(xfrm), weight: /<a:ln w="(\d+)"/.exec(image.shell)?.[1] };
});
async function drawLine(page, from, to) {
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Line', exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + from[0], box.y + from[1]); await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 5 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
  return line(page);
}

test('a drawn line follows the drag', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  const zoom = await page.evaluate(() => window.__docs.current.view.engine.zoom || 1), emu = px => Math.round(px / zoom * 9525);

  // Down and to the right: the line's box, unflipped.
  let drawn = await drawLine(page, [300, 300], [420, 380]);
  expect(drawn).toMatchObject({ flipH: false, flipV: false });
  expect(Math.abs(drawn.width - emu(120))).toBeLessThan(9525 * 2);
  expect(Math.abs(drawn.height - emu(80))).toBeLessThan(9525 * 2);
  // A heavier outline keeps it slanted.
  await onTab(page, 'shapeFormat');
  await page.getByRole('button', { name: 'Shape Outline', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Weight' }).click();
  await page.getByRole('menuitemradio', { name: '3 pt', exact: true }).click();
  await expect.poll(async () => (await line(page)).weight).toBe('38100');
  expect(await line(page)).toMatchObject({ width: drawn.width, height: drawn.height });

  // Up and to the right: flipped vertically.
  drawn = await drawLine(page, [300, 600], [420, 520]);
  expect(drawn).toMatchObject({ flipH: false, flipV: true });
  expect(drawn.height).toBeGreaterThan(emu(70));
  // Straight down: a vertical line.
  drawn = await drawLine(page, [600, 300], [601, 420]);
  expect(drawn.width).toBe(0);
  expect(drawn.height).toBeGreaterThan(emu(110));
  expect(errors).toEqual([]);
});
