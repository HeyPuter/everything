import { expect, test } from '@playwright/test';
import { boot, openImage, run } from './helpers';

test('refreshing version history releases replaced thumbnail object URLs', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 16, '#336699', 'original.png');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { addVersion } = await import('/src/features/versions/index.ts');
    await addVersion(e, e.session, 'First', 'named');
  });
  await run(page, 'file.version-history');
  const panel = page.locator('.versions-panel');
  await expect(panel.locator('.version-row img')).toHaveCount(1);
  const oldURL = await panel.locator('.version-row img').getAttribute('src');
  expect(oldURL).toMatch(/^blob:/);
  await page.evaluate(async () => {
    const revoked: string[] = [];
    (window as unknown as { revokedVersionURLs: string[] }).revokedVersionURLs = revoked;
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke.call(URL, url); };
    const e = window.photoStudio;
    const { addVersion } = await import('/src/features/versions/index.ts');
    await addVersion(e, e.session, 'Second', 'named');
  });
  await expect(panel.locator('.version-row img')).toHaveCount(2);
  const revoked = await page.evaluate(() => (window as unknown as { revokedVersionURLs: string[] }).revokedVersionURLs);
  expect(revoked).toContain(oldURL);
  await expect.poll(() => panel.locator('.version-row img').evaluateAll((images) => images.every((img) => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
});
