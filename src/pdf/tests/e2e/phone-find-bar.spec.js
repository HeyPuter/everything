import { test, expect } from '@playwright/test';

// On a phone the match count kept 60px for itself, though "1 of 8" needs half that: the find
// box was left short, and on a 320px phone the Close button was pushed past the bar's edge.
test.skip(({ isMobile }) => !isMobile, 'phone layout');

for (const width of [320, 375])
  test(`the find bar fits its controls with a count showing at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.route('https://js.puter.com/**', (route) => route.abort());
    await page.goto('/#library');
    await page.getByRole('button', { name: 'Try a sample PDF', exact: true }).click();
    await expect(page.locator('.page-caption')).toBeVisible();
    await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
    const input = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
    await input.fill('your');
    await expect(page.locator('.search-count')).toHaveText(/^1 of \d+$/);
    const bar = await page.locator('.find-bar').boundingBox();
    const close = await page
      .getByRole('button', { name: 'Close search', exact: true })
      .boundingBox();
    expect(close.x + close.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
    const count = await page.locator('.search-count').boundingBox();
    expect(count.width).toBeLessThan(45);
    expect((await input.boundingBox()).width).toBeGreaterThanOrEqual(width === 320 ? 85 : 130);
  });
