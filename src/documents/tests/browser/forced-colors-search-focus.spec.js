import { test, expect } from '@playwright/test';

// The title bar's search field shows it has the keyboard with a ring drawn as a shadow, which a Windows contrast
// theme drops; there it takes an outline in the highlight color.
test('in a contrast theme the focused search field is outlined', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/mock.html#/new');
  const search = page.getByRole('combobox', { name: 'Search for commands' }).or(page.getByRole('textbox', { name: 'Search for commands' })).first();
  await expect(search).toBeVisible();
  const ring = () => search.evaluate(input => { const box = input.closest('.ed-search'), s = getComputedStyle(box); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1; });
  expect(await ring()).toBe(false);
  await search.focus();
  expect(await ring()).toBe(true);
});
