import { test, expect, type Page } from '@playwright/test';
import { boot, openImage, start } from './helpers';

const dialog = (page: Page) => page.locator('dialog.liquify-dialog[open]');
/** The workspace canvas pixel at the middle of the stage (after the next frame). */
const centerPixel = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.querySelector<HTMLCanvasElement>('.liquify-dialog .lq-canvas')!;
    return Array.from(c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data);
  });

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150, '#808080');
  await start(page, 'filter.liquify');
  await expect(dialog(page)).toBeVisible();
});

test('Undo after Mask Options → None brings the freeze mask back', async ({ page }) => {
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
