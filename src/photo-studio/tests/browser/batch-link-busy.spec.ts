// The batch link window when another task holds the editor: Run waits for
// it, keeps the photos, and then runs them.
import { test, expect } from '@playwright/test';
import { boot } from './helpers';

test('Run waits for a running task and keeps the photos', async ({ page }) => {
  await boot(page);
  const hash = await page.evaluate(async () => {
    const { encodeBatchLink } = await import('/src/features/scripting/batch-link-core.ts');
    return encodeBatchLink({
      v: 1,
      name: 'Mirror',
      steps: [{ command: 'image.flip-horizontal' }],
      format: 'png',
      quality: 90,
    });
  });
  await page.goto('about:blank');
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  const d = page.getByRole('dialog', { name: 'Batch: Mirror' });
  await expect(d).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(40, 30);
    c.getContext('2d')!.fillRect(0, 0, 20, 30);
    const file = new File([await c.convertToBlob({ type: 'image/png' })], 'photo.png', {
      type: 'image/png',
    });
    const dt = new DataTransfer();
    dt.items.add(file);
    document
      .querySelector('dialog.batch-link-run')!
      .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(d.locator('.processor-list li')).toHaveText(['photo.png']);
  // Another task holds the editor until the test lets it finish.
  await page.evaluate(() => {
    const w = window as unknown as { finishTask: () => void };
    void window.photoStudio.run(() => new Promise<void>((r) => (w.finishTask = r)));
  });
  expect(await page.evaluate(() => window.photoStudio.busy)).toBe(true);
  await d.getByRole('button', { name: 'Run' }).click();
  await expect(d.locator('.processor-status')).toHaveText(
    'Waiting for the current task to finish…',
  );
  await expect(d.locator('.processor-list li')).toHaveText(['photo.png']);
  await expect(d.getByRole('button', { name: 'Run' })).toBeDisabled();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.evaluate(() => (window as unknown as { finishTask: () => void }).finishTask()),
  ]);
  expect(download.suggestedFilename()).toBe('Mirror.zip');
  await expect(d.locator('.processor-status')).toContainText('Saved 1 file');
  await expect(d.locator('.processor-list li')).toHaveCount(0);
});
