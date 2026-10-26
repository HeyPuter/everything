import { test, expect } from '@playwright/test';

test('Preferences: a change updates the controls that depend on it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Hello world');
  await input.press('ControlOrMeta+,');
  const dialog = page.getByRole('dialog', { name: 'Preferences' });
  await dialog.getByRole('radio', { name: 'Light' }).click();
  const darkPage = dialog.getByRole('switch', { name: /Dark page/ });
  // The dark page needs the dark appearance; choosing it here makes the switch available at once.
  await expect(darkPage).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Dark' }).click();
  await expect(darkPage).toBeEnabled();
  await dialog.getByRole('radio', { name: 'Light' }).click();
  await expect(darkPage).toBeDisabled();
  expect(errors).toEqual([]);
});

test('Preferences: Show KeyTips puts the dialog away and labels the ribbon', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await page.locator('.ribbon-card').waitFor();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await input.press('ControlOrMeta+,');
  const dialog = page.getByRole('dialog', { name: 'Preferences' });
  await dialog.getByRole('tab', { name: 'Keyboard' }).click();
  await dialog.locator('.pref-row', { hasText: 'KeyTips' }).getByRole('button', { name: 'Show' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.ed-keytip').first()).toBeVisible();
  // The KeyTips work: H goes to the Home tab's commands.
  await page.keyboard.press('h');
  await expect(page.locator('.ed-keytip', { hasText: /^B$/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ed-keytip')).toHaveCount(0);
});
