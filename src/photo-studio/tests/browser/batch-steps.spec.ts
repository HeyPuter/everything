// File > Automate > Batch offers every action as a step and starts with only
// the action chosen in the Actions panel ticked.
import { expect, test } from '@playwright/test';
import { boot, openImage, panel, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('photo-studio-actions'));
  await boot(page);
});

test('Batch ticks only the action selected in the Actions panel', async ({ page }) => {
  await openImage(page, 40, 30, '#808080');
  const actions = await panel(page, 'Actions');
  await actions.locator('.action-row.action', { hasText: 'Mirror Canvas' }).click();
  await start(page, 'file.batch');
  const dialog = page.getByRole('dialog', { name: 'Batch' });
  await expect(dialog.getByRole('checkbox', { name: 'Action: Mirror Canvas' })).toBeChecked();
  for (const name of [
    'Desaturated Copy',
    'Flatten and Auto Contrast',
    'Stamp Visible to New Layer',
    'Trim Transparent Pixels',
  ])
    await expect(dialog.getByRole('checkbox', { name: `Action: ${name}` })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // With a set (not an action) selected, nothing is ticked.
  await actions.locator('.action-row.set', { hasText: 'Default Actions' }).click();
  await start(page, 'file.batch');
  await expect(dialog.getByRole('checkbox', { name: 'Action: Mirror Canvas' })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /^Action: /, checked: true })).toHaveCount(0);
});

test('a deleted action is no longer offered as a Batch step', async ({ page }) => {
  await openImage(page, 40, 30, '#808080');
  const actions = await panel(page, 'Actions');
  await actions.locator('.action-row.action', { hasText: 'Mirror Canvas' }).click();
  await run(page, 'actions.delete');
  await expect(actions.locator('.action-row.action', { hasText: 'Mirror Canvas' })).toHaveCount(0);
  await start(page, 'file.batch');
  const dialog = page.getByRole('dialog', { name: 'Batch' });
  await expect(
    dialog.getByRole('checkbox', { name: 'Action: Trim Transparent Pixels' }),
  ).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Action: Mirror Canvas' })).toHaveCount(0);
});
