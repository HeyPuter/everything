// The Layer Style dialog's effect list keeps the keyboard focus when an effect
// is chosen, added or turned on, instead of dropping it on the page behind.
import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

test('choosing, adding and deleting effects from the keyboard keeps the focus in the list', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 60, 40, '#808080');
  await page.keyboard.press('ControlOrMeta+j');
  await idle(page);
  await start(page, 'layer.style-drop-shadow');
  const dialog = page.getByRole('dialog', { name: 'Layer Style' });
  const effects = dialog.getByRole('navigation', { name: 'Effects' });
  const bevel = effects.getByRole('button', { name: 'Bevel & Emboss', exact: true });
  await bevel.focus();
  await page.keyboard.press('Enter');
  await expect(bevel).toBeFocused();
  await expect(dialog.locator('.ls-title')).toHaveText('Bevel & Emboss');
  const stroke = effects.getByRole('checkbox', { name: 'Enable Stroke' });
  await stroke.focus();
  await page.keyboard.press('Space');
  await expect(stroke).toBeChecked();
  await expect(stroke).toBeFocused();
  await effects.getByRole('button', { name: 'Add another Stroke' }).focus();
  await page.keyboard.press('Enter');
  await expect(effects.getByRole('button', { name: 'Stroke', exact: true })).toHaveCount(2);
  await expect(effects.getByRole('button', { name: 'Add another Stroke' }).first()).toBeFocused();
  // Deleting the chosen effect leaves the focus on the effect chosen after it.
  await effects.getByRole('button', { name: 'Delete effect' }).focus();
  await page.keyboard.press('Enter');
  await expect(effects.getByRole('button', { name: 'Stroke', exact: true })).toHaveCount(1);
  await expect(effects.getByRole('button', { name: 'Stroke', exact: true })).toBeFocused();
  // Keys stay in the dialog: the panels behind it and the tool are untouched.
  await page.keyboard.press('b');
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('move');
  expect(
    await page.evaluate(() => window.photoStudio.root.classList.contains('panels-hidden')),
  ).toBe(false);
});
