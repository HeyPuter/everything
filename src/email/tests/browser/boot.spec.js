import { test, expect } from '@playwright/test';

test('a network failure at the access check offers a retry, not a permission prompt', async ({ page }) => {
  await page.goto('/tests/browser/boot.html?mode=statnet');
  await expect(page.locator('.gate-title')).toHaveText('Something went wrong');
  await page.evaluate(() => window.__netUp());
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.row').first()).toBeVisible();
  expect(await page.evaluate(() => window.__log)).toEqual([]);
});

test('a refused access check still asks for permission', async ({ page }) => {
  await page.goto('/tests/browser/boot.html?mode=noperm');
  await expect(page.locator('.gate-title')).not.toHaveText('Something went wrong');
  await expect(page.locator('.gate .btn-primary')).toBeVisible();
  await page.locator('.gate .btn-primary').click();
  await expect.poll(() => page.evaluate(() => window.__log)).toEqual(['perm:fs:/sample/.mail:read']);
});
