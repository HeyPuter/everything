// The Select and Mask, Color Range and Focus Area workspaces name each slider
// and its number box after the field's caption for screen readers.
import { expect, test } from '@playwright/test';
import { boot, openImage, selectRect, start } from './helpers';

test('workspace sliders and number boxes are named after their captions', async ({ page }) => {
  await boot(page);
  await openImage(page, 120, 90, '#4080c0');
  await selectRect(page, { x: 20, y: 20, width: 60, height: 40 });
  await start(page, 'select.mask-refine');
  let dialog = page.getByRole('dialog', { name: 'Select and Mask' });
  await expect(
    dialog.getByRole('spinbutton', { name: 'Feather (px) value', exact: true }),
  ).toHaveValue('0');
  await expect(dialog.getByRole('slider', { name: 'Feather (px)', exact: true })).toHaveValue('0');
  await expect(
    dialog.getByRole('spinbutton', { name: 'Shift Edge (%) value', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: /^sm-/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await start(page, 'select.color-range');
  dialog = page.getByRole('dialog', { name: 'Color Range' });
  await expect(
    dialog.getByRole('spinbutton', { name: 'Fuzziness value', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('slider', { name: 'Fuzziness', exact: true })).toBeVisible();
});
