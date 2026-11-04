import { test, expect } from '@playwright/test';

// Back to all tools returns the keyboard to the tool it left, not to the top of the list.
test('Back to all tools focuses the tool that was open', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the tools pane starts closed on a phone');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const pane = page.getByRole('complementary', { name: 'Tools' });
  const row = pane.getByRole('button', { name: 'Add comments', exact: true });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(pane.getByRole('heading', { name: 'Add comments' })).toBeVisible();
  const back = pane.getByRole('button', { name: 'Back to all tools', exact: true });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(pane.getByRole('heading', { name: 'All tools' })).toBeVisible();
  await expect(row).toBeFocused();
});
