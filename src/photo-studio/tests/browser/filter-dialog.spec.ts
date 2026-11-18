import { test, expect, type Page } from '@playwright/test';
import { boot, historyLabels, idle, openImage, start } from './helpers';

/** Names of the filter workers started so far. */
const workers = (page: Page) => page.evaluate(() => (window as unknown as { __workers: string[] }).__workers.slice());

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const names: string[] = [];
    (window as unknown as { __workers: string[] }).__workers = names;
    const Base = window.Worker;
    window.Worker = class extends Base {
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        names.push(opts?.name ?? '');
      }
    } as typeof Worker;
  });
  await boot(page);
});

test('OK during the canvas preview render waits for it instead of starting over', async ({ page }) => {
  await openImage(page, 2400, 1800, '#808080');
  await start(page, 'filter.apply.median');
  const dialog = page.locator('dialog.filter-dialog[open]');
  await expect(dialog).toBeVisible();
  const field = dialog.locator('input[type=number][data-key="radius"]');
  await field.fill('40');
  await field.dispatchEvent('input');
  // The debounced full-resolution render starts and shows progress.
  await expect(dialog.locator('.fd-progress')).toBeVisible();
  await expect.poll(async () => (await workers(page)).filter((n) => n === 'filters-full').length).toBe(1);
  await dialog.locator('.fd-ok').click();
  await expect(page.locator('dialog.filter-dialog[open]')).toHaveCount(0, { timeout: 90_000 });
  await idle(page);
  expect(await historyLabels(page)).toEqual(['Median']);
  // The running render was reused: no second full-resolution worker.
  expect((await workers(page)).filter((n) => n === 'filters-full').length).toBe(1);
});

test('OK and Fade accept typed values between the field steps', async ({ page }) => {
  await openImage(page, 120, 80, '#808080');
  await start(page, 'filter.apply.gaussian-blur');
  const dialog = page.locator('dialog.filter-dialog[open]');
  await expect(dialog).toBeVisible();
  // The radius field steps by 0.1; 2.55 is still a usable radius.
  const radius = dialog.locator('input[type=number][data-key="radius"]');
  await radius.fill('2.55');
  await radius.press('Tab');
  await dialog.locator('.fd-ok').click();
  await expect(page.locator('dialog.filter-dialog[open]')).toHaveCount(0);
  await idle(page);
  expect(await historyLabels(page)).toEqual(['Gaussian Blur']);
  await start(page, 'edit.fade');
  const fade = page.locator('dialog.fade-dialog[open]');
  await expect(fade).toBeVisible();
  const opacity = fade.locator('#fade-opacity');
  await opacity.fill('50.5');
  await opacity.press('Tab');
  await fade.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('dialog.fade-dialog[open]')).toHaveCount(0);
  await idle(page);
  expect(await historyLabels(page)).toEqual(['Gaussian Blur', 'Fade Gaussian Blur']);
});

test('replaced and cancelled filter previews free their pixels', async ({ page }) => {
  await openImage(page, 600, 400, '#808080');
  const tiles = () => page.evaluate(() => window.photoStudio.assets.tiles.size);
  // Tile IDs of the layer the canvas shows (the dialog's preview while it runs).
  const shown = () =>
    page.evaluate(() => JSON.stringify(window.photoStudio.shownDoc.layers[0].pixels?.tiles));
  const initial = await tiles();
  const dialog = page.locator('dialog.filter-dialog[open]');
  const preview = async (radius: string) => {
    const before = await shown();
    const field = dialog.locator('input[type=number][data-key="radius"]');
    await field.fill(radius);
    await field.dispatchEvent('input');
    await expect.poll(shown).not.toBe(before);
  };
  await start(page, 'filter.apply.gaussian-blur');
  await expect(dialog).toBeVisible();
  for (const r of ['4', '9', '15']) await preview(r);
  // Only the preview on the canvas keeps its tiles (six for 600 x 400).
  await expect.poll(tiles).toBe(initial + 6);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await idle(page);
  await expect.poll(tiles).toBe(initial);
  // Applying keeps the result it shows.
  await start(page, 'filter.apply.gaussian-blur');
  await expect(dialog).toBeVisible();
  for (const r of ['5', '12']) await preview(r);
  await dialog.locator('.fd-ok').click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  expect(await historyLabels(page)).toEqual(['Gaussian Blur']);
  await expect.poll(tiles).toBe(initial + 6);
  const px = await page.evaluate(async () => {
    const e = window.photoStudio;
    const p = await e.renderer.documentPixels(e.doc, e.assets);
    return p.length;
  });
  expect(px).toBe(600 * 400 * 4);
});
