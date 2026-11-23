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

test('Back to all tools finds a tool opened from the find box among the rest', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the tools pane starts closed on a phone');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // PDF standards is not among the few tools the pane lists until View more is chosen.
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('combobox', { name: 'Find in PDF', exact: true }).fill('standards');
  await page.getByRole('option', { name: 'Open tool: PDF standards', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await expect(pane.getByRole('heading', { name: 'PDF standards' })).toBeVisible();
  const back = pane.getByRole('button', { name: 'Back to all tools', exact: true });
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(pane.getByRole('heading', { name: 'All tools' })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'PDF standards', exact: true })).toBeFocused();
});
