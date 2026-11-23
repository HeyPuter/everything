import { test, expect } from '@playwright/test';

// Bringing the current page's thumbnail into view moved the browser's starting point for Tab
// into the side panel, so the first Tab in the app went to "Go to page 1", past the skip link,
// the menus and the tools.
test('the first Tab in the app reaches the skip link', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.thumb-item')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});
