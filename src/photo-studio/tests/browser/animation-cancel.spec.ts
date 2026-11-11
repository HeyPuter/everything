import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

// Long animation exports show a progress bar that Cancel or Escape stops.

/** A frame animation with many different frames (one layer shown in each). */
async function manyFrames(page: Page, count = 80) {
  await openImage(page, 320, 240, '#f0f0f0', 'many.png');
  await page.evaluate(async (count) => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    e.command('Layers', (d) => {
      for (let i = 0; i < count; i++) {
        const data = new Uint8ClampedArray(40 * 40 * 4);
        for (let p = 0; p < data.length; p += 4) data.set([(i * 37) % 256, (i * 91) % 256, 200, 255], p);
        d.layers.push(newPixelLayer(`L${i}`, d, gridFromImage(e.assets.tiles, { width: 40, height: 40, data }, (i * 7) % 280, (i * 5) % 200)));
      }
    });
  }, count);
  await run(page, 'animation.frames-from-layers');
}

async function cancelExport(page: Page, start: () => Promise<void>) {
  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await start();
  const hud = page.locator('.filter-hud');
  await expect(hud).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hud).toBeHidden();
  await idle(page);
  await expect(page.locator('#status')).toHaveText(/cancelled/i);
  expect(downloaded).toBe(false);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('an image sequence render can be cancelled', async ({ page }) => {
  await manyFrames(page);
  await cancelExport(page, async () => {
    await page.evaluate(() => void window.photoStudio.runCommand('file.render-video'));
    const dialog = page.locator('dialog[open].animation-export-dialog');
    await dialog.locator('select[name="output"]').selectOption('png');
    await dialog.getByRole('button', { name: 'Render' }).click();
  });
});

test('a video render can be cancelled', async ({ page }) => {
  test.skip(!(await page.evaluate(() => typeof VideoEncoder !== 'undefined')), 'WebCodecs video encoding is unavailable');
  await manyFrames(page);
  await cancelExport(page, async () => {
    await page.evaluate(() => void window.photoStudio.runCommand('file.render-video'));
    const dialog = page.locator('dialog[open].animation-export-dialog');
    await dialog.locator('select[name="output"]').selectOption('webm');
    await dialog.locator('select[name="codec"]').selectOption('vp8');
    await dialog.getByRole('button', { name: 'Render' }).click();
  });
});

test('an animation export can be cancelled', async ({ page }) => {
  await manyFrames(page);
  await cancelExport(page, async () => {
    await page.evaluate(() => void window.photoStudio.runCommand('file.export-animation'));
    const dialog = page.locator('dialog[open].animation-export-dialog');
    await dialog.getByRole('button', { name: 'Export' }).click();
  });
});
