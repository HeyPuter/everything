import { expect, test } from '@playwright/test';
import { boot, downloadFrom, openImage, start } from './helpers';

test('export cache settings stay paired with bytes while source pixels are loading', async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 20, '#336699', 'picture.png');
  await page.evaluate(() => {
    const e = window.photoStudio;
    const original = e.renderer.documentPixels.bind(e.renderer);
    const state = { started: false, release: () => {} };
    (window as unknown as { exportSource: typeof state }).exportSource = state;
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    let first = true;
    e.renderer.documentPixels = async (...args) => {
      const pixels = await original(...args);
      if (first) { first = false; state.started = true; await gate; }
      return pixels;
    };
    // Keep the debounce window open while the earlier preview finishes.
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
      ms === 220 ? timeout(() => {}, 10000) : timeout(handler, ms, ...args)) as typeof window.setTimeout;
  });
  await start(page, 'file.export-as');
  const dialog = page.locator('dialog.export-dialog');
  await page.waitForFunction(() => (window as unknown as { exportSource: { started: boolean } }).exportSource.started);
  await dialog.locator('select[name="format"]').selectOption('jpeg');
  await page.evaluate(() => (window as unknown as { exportSource: { release(): void } }).exportSource.release());
  await expect(dialog.locator('.export-busy')).toBeHidden();
  await dialog.locator('select[name="format"]').selectOption('png');
  const file = await downloadFrom(page, () => dialog.locator('[data-act="export"]').click());
  expect(file.name).toBe('picture.png');
  expect(file.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
