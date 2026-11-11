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
