import { test, expect } from '@playwright/test';

// Switching between the library and a PDF replaces the whole view, and with it the control
// that had the focus. The keyboard lands in the new view instead of at the top of the document.
test('the keyboard follows the switch from the library to a PDF and back', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the menu bar folds into one button on a phone');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  // Nothing takes the focus on its own when the app loads.
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  const sample = page.getByRole('button', { name: 'Try a sample PDF', exact: true });
  await sample.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('region', { name: 'PDF page view' })).toBeFocused();
  const file = page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true });
  await file.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Back to your PDFs', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your PDFs', exact: true })).toBeVisible();
  await expect(page.locator('#main')).toBeFocused();
  // The next Tab goes on from the top of the library's content.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Open a PDF/ })).toBeFocused();
});

test('a PDF opening at launch leaves the focus alone', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});
