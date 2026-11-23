import { test, expect } from '@playwright/test';

// With forced colors (Windows High Contrast), the menus' dividers and the app bar's were
// painted over with the canvas color, and the groups they separate ran together.
test('menu and app bar dividers stay visible with forced colors', async ({ page, isMobile }) => {
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const differs = (selector) =>
    page
      .locator(selector)
      .first()
      .evaluate((divider) => {
        const own = getComputedStyle(divider).backgroundColor;
        let node = divider.parentElement;
        while (
          node &&
          /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(node).backgroundColor)
        )
          node = node.parentElement;
        return own !== getComputedStyle(node || document.body).backgroundColor;
      });
  if (!isMobile) expect(await differs('.appbar-sep')).toBe(true);
  if (isMobile) await page.getByRole('button', { name: 'Menu', exact: true }).click();
  else await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await differs('.menu .menu-sep')).toBe(true);
});
