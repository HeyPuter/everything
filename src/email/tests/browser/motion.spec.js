import { test, expect } from '@playwright/test';

test('the phone drawer opens without sliding when reduced motion is asked for', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto('/tests/browser/boot.html');
  await expect(page.locator('.row').first()).toBeVisible();
  await page.getByRole('button', { name: /menu|folders/i }).first().click();
  const sidebar = page.locator('.sidebar');
  expect(await sidebar.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');
  expect(await sidebar.evaluate((node) => node.getAnimations().length)).toBe(0);
  await context.close();
});
