// Export for Web: cancelling while the preview is still being prepared
// leaves no full-size preview image behind.
import { test, expect } from '@playwright/test';
import { boot, openImage, run, start } from './helpers';

test('cancelling Export for Web early frees its preview image', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await openImage(page, 2400, 1600, '#808080', 'big.png');
  await run(page, 'filter.apply.add-noise', { params: { amount: 80 } });
  await page.evaluate(() => {
    const live = new Map<string, number>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      const url = create(o);
      if (o instanceof Blob && o.size > 200_000) live.set(url, o.size);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      live.delete(url);
      revoke(url);
    };
    (window as unknown as { __live: Map<string, number> }).__live = live;
  });
  await start(page, 'file.export-web');
  const dialog = page.locator('dialog.web-export-dialog');
  await expect(dialog).toBeVisible();
  // The preview starts 200 ms after the dialog opens; cancel while it is prepared.
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(8000);
  expect(
    await page.evaluate(() => [
      ...(window as unknown as { __live: Map<string, number> }).__live.values(),
    ]),
  ).toEqual([]);
});
