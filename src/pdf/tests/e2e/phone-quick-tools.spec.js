import { test, expect } from '@playwright/test';

// On a 360px phone (the commonest Android width) the quick tools wrapped onto a second line by
// a few pixels, and on narrower phones the second group's divider stood alone at the start of
// its line.
const toolRows = (page) =>
  page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('.quick-tools .tool-btn')]
        .filter((button) => button.getClientRects().length)
        .map((button) => Math.round(button.getBoundingClientRect().top)),
    ),
  ]);

test.skip(({ isMobile }) => !isMobile, 'phone layout');

test('the quick tools fit one line on a 360px phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect(await toolRows(page)).toHaveLength(1);
});

test('wrapped quick tools leave no divider at the start of a line', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect(await toolRows(page)).toHaveLength(2);
  const second = page.locator('.quick-tools > .tool-group').nth(1);
  expect(await second.evaluate((group) => getComputedStyle(group).borderLeftWidth)).toBe('0px');
});
