import { test, expect } from '@playwright/test';

// On a Mac, Control with a letter edits the text in any field (⌃D deletes forward, ⌃P goes up
// a line, ⌃O opens a line). In the app's fields they opened Document details, Print, and the
// file picker instead, and the keystroke was lost. Headless Chromium reports a Mac.
test('Control letters in a field on a Mac edit the field, and ⌘ shortcuts still work', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))).toBe(true);
  await page.keyboard.press('Meta+f');
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  await find.fill('words');
  let chooser = false;
  page.on('filechooser', () => (chooser = true));
  for (const key of ['d', 'p', 'o', 'l', 'b']) await find.press(`Control+${key}`);
  await expect(find).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(chooser).toBe(false);
  // Outside a field Control still works as before, and ⌘ works everywhere.
  await find.press('Meta+d');
  await expect(page.getByRole('dialog', { name: 'Document details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.workspace').focus();
  await page.keyboard.press('Control+d');
  await expect(page.getByRole('dialog', { name: 'Document details' })).toBeVisible();
});
