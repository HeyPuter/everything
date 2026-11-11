import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

const dialog = (page: Page) => page.locator('dialog.liquify-dialog[open]');
const nextFrame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** The workspace canvas pixel at the middle of the stage (after the next frame). */
const centerPixel = async (page: Page) => {
  await nextFrame(page);
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.liquify-dialog .lq-canvas')!;
    return Array.from(c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data);
  });
};
/** A cheap signature of everything the workspace canvas shows. */
const canvasSum = async (page: Page) => {
  await nextFrame(page);
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.liquify-dialog .lq-canvas')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2]) % 1e9;
    return s;
  });
};
async function openStripes(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(200, 150);
    const g = c.getContext('2d')!;
    g.fillStyle = '#d0d0d0';
    g.fillRect(0, 0, 200, 150);
    g.fillStyle = '#202020';
    for (let x = 0; x < 200; x += 20) g.fillRect(x, 0, 6, 150);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'stripes.png');
  });
  await idle(page);
}
async function openLiquify(page: Page) {
  await start(page, 'filter.liquify');
  await expect(dialog(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Undo after Mask Options → None brings the freeze mask back', async ({ page }) => {
  await openImage(page, 200, 150, '#808080');
  await openLiquify(page);
  const d = dialog(page);
  expect((await centerPixel(page)).slice(0, 3)).toEqual([128, 128, 128]);
  await d.locator('[data-act="mask-all"]').click();
  const frozen = await centerPixel(page);
  expect(frozen[0]).toBeGreaterThan(160); // red tint
  await d.locator('[data-act="mask-none"]').click();
  expect((await centerPixel(page)).slice(0, 3)).toEqual([128, 128, 128]);
  await d.locator('[data-act="undo"]').click();
  expect(await centerPixel(page)).toEqual(frozen);
  await d.locator('.lq-cancel').click();
  await expect(dialog(page)).toHaveCount(0);
});

test('a stroke made while Reconstruct is open is kept', async ({ page }) => {
  await openStripes(page);
  await openLiquify(page);
  const d = dialog(page);
  const original = await canvasSum(page);
  await d.locator('[data-act="reconstruct"]').click();
  await expect(d.locator('.lq-reconstruct')).toBeVisible();
  // Forward Warp across the middle of the image.
  const box = (await d.locator('.lq-canvas').boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy + i * 2);
  await page.mouse.up();
  const warped = await canvasSum(page);
  expect(warped).not.toBe(original);
  // Painting finished the reconstruction, so its amount can no longer
  // rewind the field to before the stroke.
  const amount = d.locator('#lq-amount');
  if (await amount.isVisible()) {
    await amount.fill('50');
    await amount.dispatchEvent('input');
  }
  expect(await canvasSum(page)).toBe(warped);
  await expect(d.locator('.lq-reconstruct')).toBeHidden();
  // Undo removes the stroke alone.
  await d.locator('[data-act="undo"]').click();
  expect(await canvasSum(page)).toBe(original);
  await d.locator('.lq-cancel').click();
});
