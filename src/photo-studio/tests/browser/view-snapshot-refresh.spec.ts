import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('a no-op snapshot refresh does not block later changes in inactive documents', async ({ page }) => {
  await boot(page);
  await openImage(page, 100, 100, '#ff0000', 'inactive.png');
  const inactive = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 100, 100, '#ffffff', 'active.png');
  await run(page, 'window.tile-all');
  const preview = page.locator('canvas.view-preview');
  const center = () => preview.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data));
  await expect.poll(center).toEqual([255, 0, 0, 255]);
  // Finish pending work, then run an explicit pass with no stale snapshots.
  await page.evaluate(async () => {
    await window.photoStudio.windows.ensureSnapshots();
    await window.photoStudio.windows.ensureSnapshots();
  });
  await page.evaluate(async (id) => {
    const e = window.photoStudio;
    const s = e.sessions.find((s) => s.id === id)!;
    const { layer } = await import('/src/model/document.ts');
    const blue = layer('solid', 'Blue', 100, 100);
    blue.color = '#0000ff';
    s.history.reset({ ...s.doc, layers: [blue] });
    await e.windows.ensureSnapshots();
  }, inactive);
  await idle(page);
  await expect.poll(center, { timeout: 5000 }).toEqual([0, 0, 255, 255]);
});
