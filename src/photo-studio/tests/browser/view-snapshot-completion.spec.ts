import { expect, test } from '@playwright/test';
import { boot, openImage, run } from './helpers';

test('an edit queued as a snapshot pass finishes starts a fresh pass', async ({ page }) => {
  await boot(page);
  await openImage(page, 100, 100, '#ff0000', 'inactive.png');
  const inactive = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 100, 100, '#ffffff', 'active.png');
  await run(page, 'window.tile-all');
  const preview = page.locator('canvas.view-preview');
  const center = () => preview.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data));
  await expect.poll(center).toEqual([255, 0, 0, 255]);
  await page.evaluate(async (id) => {
    const e = window.photoStudio;
    await e.windows.ensureSnapshots();
    const { layer } = await import('/src/model/document.ts');
    const blue = layer('solid', 'Blue', 100, 100);
    blue.color = '#0000ff';
    const draw = e.windows.queueDraw;
    e.windows.queueDraw = function () {
      e.windows.queueDraw = draw;
      draw.call(this);
      // A background edit's continuation is queued before the pass's promise cleanup.
      queueMicrotask(() => {
        const s = e.sessions.find((s) => s.id === id)!;
        s.history.reset({ ...s.doc, layers: [blue] });
        void e.windows.ensureSnapshots();
      });
    };
    await e.windows.ensureSnapshots();
  }, inactive);
  await expect.poll(center, { timeout: 5000 }).toEqual([0, 0, 255, 255]);
});
