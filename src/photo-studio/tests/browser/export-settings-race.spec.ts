import { expect, test } from '@playwright/test';
import { boot, downloadFrom, openImage, start } from './helpers';

test('export settings cannot change between encoding and naming the downloaded file', async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 20, '#336699', 'picture.png');
  await start(page, 'file.export-as');
  const dialog = page.locator('dialog.export-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.export-busy')).toBeHidden();
  await page.evaluate(() => {
    const state = { held: [] as (() => void)[], hold: true };
    (window as unknown as { exportJobs: typeof state }).exportJobs = state;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: { settings?: unknown }, ...rest: []) {
      if (state.hold && msg?.settings) state.held.push(() => post.call(this, msg, ...rest));
      else post.call(this, msg, ...rest);
    } as typeof post;
  });
  await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>('dialog.export-dialog input[name="pngLevel"]')!;
    field.value = '1';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('dialog.export-dialog [data-act="export"]')!.click();
  });
  await page.waitForFunction(() => (window as unknown as { exportJobs: { held: unknown[] } }).exportJobs.held.length > 0);
  const formatEnabled = await dialog.locator('select[name="format"]').isEnabled();
  if (formatEnabled) await dialog.locator('select[name="format"]').selectOption('jpeg');
  await expect(dialog.locator('[data-act="cancel"]')).toBeEnabled();
  const file = await downloadFrom(page, () => page.evaluate(() => {
    const state = (window as unknown as { exportJobs: { held: (() => void)[]; hold: boolean } }).exportJobs;
    state.hold = false;
    for (const send of state.held.splice(0)) send();
  }));
  expect(file.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(file.name).toBe('picture.png');
  expect(formatEnabled).toBe(false);
});

test('failed encoding restores editable settings while keeping required controls disabled', async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 20, '#336699', 'picture.png');
  await start(page, 'file.export-as');
  const dialog = page.locator('dialog.export-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.export-busy')).toBeHidden();
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    let fail = true;
    Worker.prototype.postMessage = function (this: Worker, msg: { id: number; settings?: unknown }, ...rest: []) {
      if (fail && msg?.settings && document.querySelector<HTMLButtonElement>('dialog.export-dialog [data-act="export"]')?.disabled) {
        fail = false;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id: msg.id, error: 'Simulated encode failure' } })));
      } else post.call(this, msg, ...rest);
    } as typeof post;
  });
  await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>('dialog.export-dialog input[name="pngLevel"]')!;
    field.value = '1';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('dialog.export-dialog [data-act="export"]')!.click();
  });
  await expect(dialog.locator('.export-busy')).toHaveText('Simulated encode failure');
  await expect(dialog.locator('select[name="format"]')).toBeEnabled();
  await expect(dialog.locator('input[name="pngLevel"]')).toBeEnabled();
  await expect(dialog.locator('input[name="convertSrgb"]')).toBeDisabled();
  await expect(dialog.locator('[data-act="export"]')).toBeEnabled();
  const file = await downloadFrom(page, () => dialog.locator('[data-act="export"]').click());
  expect(file.name).toBe('picture.png');
});
