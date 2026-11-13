import { expect, test } from '@playwright/test';
import { boot, compositePixel, idle, openImage, start } from './helpers';

for (const closeCopy of [true, false]) {
test(`closing the ${closeCopy ? 'version copy' : 'original'} leaves the other document pixels intact`, async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#336699', 'original.png');
  const originalId = await page.evaluate(() => window.photoStudio.session.id);
  await start(page, 'file.save-version');
  await page.locator('#dialog').getByLabel('Version name').fill('Snapshot');
  await page.locator('#dialog').getByRole('button', { name: 'Save Version', exact: true }).click();
  const panel = page.locator('.versions-panel');
  await expect(panel.locator('.version-row')).toHaveCount(1);
  await panel.locator('[data-version-act="copy"]').click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.session.id)).not.toBe(originalId);
  await idle(page);
  expect(await compositePixel(page, 8, 8)).toEqual([51, 102, 153, 255]);
  const shared = await page.evaluate(async ({ originalId, closeCopy }) => {
    const e = window.photoStudio;
    const original = e.sessions.find((s) => s.id === originalId)!;
    const copy = e.session;
    const shared = original.assets === copy.assets;
    await e.closeSession(closeCopy ? copy : original, true);
    return shared;
  }, { originalId, closeCopy });
  await idle(page);
  const pixels = await compositePixel(page, 8, 8);
  expect({ shared, pixels }).toEqual({ shared: false, pixels: [51, 102, 153, 255] });
});
}
