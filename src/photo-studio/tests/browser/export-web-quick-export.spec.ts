// Export for Web: exporting right after changing a setting (before the
// previews caught up) writes every image instead of failing.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run, start } from './helpers';

test('Export right after a settings change still writes the images', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await openImage(page, 2400, 1600, '#808080', 'big.png');
  await run(page, 'filter.apply.add-noise', { params: { amount: 80 } });
  await start(page, 'file.export-web');
  const dialog = page.locator('dialog.web-export-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.web-total')).toContainText('1 file', { timeout: 90_000 });
  // Change the format and export at once, as pressing Enter in a field does.
  const format = dialog.locator('select[name=format]');
  await format.selectOption((await format.inputValue()) === 'png' ? 'gif' : 'png');
  const download = page.waitForEvent('download', { timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Export…' }).click();
  expect((await download).suggestedFilename()).toBe('big-web.zip');
  await expect(dialog).toHaveCount(0);
  await idle(page);
});
