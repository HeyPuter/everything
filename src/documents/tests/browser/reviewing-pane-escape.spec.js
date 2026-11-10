import { test, expect } from '@playwright/test';

test('Escape in the Reviewing Pane closes it and returns to the document, as in the other panes', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.goto('/mock.html#/new');
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.fill('A sentence to review.');
  await page.getByRole('button', { name: 'Comments', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Reviewing Pane' });
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Close Reviewing Pane' }).focus();
  await page.keyboard.press('Escape');
  await expect(pane).toBeHidden();
  await expect(text).toBeFocused();
  await expect(page.getByRole('button', { name: 'Comments', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
