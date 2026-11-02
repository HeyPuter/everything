import { test, expect } from '@playwright/test';

// A window narrower than a paragraph's indent cannot show Web Layout. The switch failed with a
// message, but the window and the editor stayed in Web Layout over the printed pages, and every
// keystroke after it failed the same way. Both now stay in Print Layout, and typing goes on.
test.use({ viewport: { width: 560, height: 800 } });

test('a view the document cannot be laid out in leaves Print Layout as it was, still editable', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Plain text\nIndented quote');
  // Six inches of left indent: within the Letter page's six and a half, wider than this window.
  for (let i = 0; i < 12; i++) await input.press('Control+m');
  await page.locator('#ribbon-tab-view').click();
  const tab = page.locator('.ribbon-card');
  await tab.getByRole('button', { name: 'Web Layout', exact: true }).click();
  await expect(page.getByText(/leave no writing space/).first()).toBeVisible();
  const host = page.locator('.canvas-host');
  await expect(host).not.toHaveClass(/view-web/);
  await expect(tab.getByRole('button', { name: 'Print Layout', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(tab.getByRole('button', { name: 'Web Layout', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await input.focus();
  await input.press('ControlOrMeta+End');
  await input.pressSequentially(' still typing');
  await expect(input).toHaveValue('Plain text\nIndented quote still typing');
  expect(errors).toEqual([]);
});
