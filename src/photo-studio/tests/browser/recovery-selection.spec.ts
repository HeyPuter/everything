import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('restoring selected documents keeps unchecked recovery copies for later', async ({ page }) => {
  await boot(page);
  for (const name of ['restore-now.png', 'restore-later.png']) {
    await openImage(page, 16, 16, '#336699', name);
    await run(page, 'adjust.invert');
  }
  await run(page, 'file.autosave-now');
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  const dialog = page.locator('#dialog');
  await expect(dialog.locator('.recovery-item')).toHaveCount(2);
  for (const checkbox of await dialog.getByRole('checkbox').all()) await checkbox.uncheck();
  await expect(dialog.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  await dialog.locator('.recovery-item').filter({ hasText: 'restore-now' }).getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.locator('#document-name')).toHaveText('restore-now');
  await idle(page);
  const kept = await page.evaluate(async () => {
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    return (await new RecoveryStore().list()).map((record) => record.name);
  });
  expect(kept).toEqual(['restore-later']);
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  await expect(dialog.locator('.recovery-item')).toHaveCount(1);
  await expect(dialog.locator('.recovery-item')).toContainText('restore-later');
});
