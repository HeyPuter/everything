import { expect, test } from '@playwright/test';
import { boot, openImage, start } from './helpers';

for (const format of ['tiff', 'tga']) {
  test(`${format} keeps its canvas preview after an unchanged-settings refresh`, async ({ page }) => {
    await boot(page);
    await openImage(page, 32, 20, '#336699');
    await page.evaluate((format) => localStorage.setItem('photo-studio-export', JSON.stringify({ format })), format);
    await start(page, 'file.export-as');
    const dialog = page.locator('dialog.export-dialog');
    await expect(dialog.locator('canvas')).toBeVisible();
    await expect(dialog.locator('.export-busy')).toBeHidden();
    // Count completed preview refreshes, including a cache hit with no worker job.
    await page.evaluate(() => {
      const busy = document.querySelector('.export-busy')!;
      const state = { completed: false };
      (window as unknown as { exportRefresh: typeof state }).exportRefresh = state;
      const observer = new MutationObserver(() => {
        if ((busy as HTMLElement).hidden) { state.completed = true; observer.disconnect(); }
      });
      observer.observe(busy, { attributes: true, attributeFilter: ['hidden'] });
    });
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { exportRefresh: { completed: boolean } }).exportRefresh.completed);
    expect(await dialog.locator('canvas').isVisible()).toBe(true);
    expect(await dialog.locator('canvas').evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext('2d')!.getImageData(5, 5, 1, 1).data))).toEqual([51, 102, 153, 255]);
  });
}
