import { test, expect } from '@playwright/test';

// On the smallest phones the library's sort and search controls share one line, within the
// width of the list beneath them, rather than the search field reaching past it.
for (const width of [320, 390])
  test(`the library search stays within the list at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.route('https://js.puter.com/**', (route) => route.abort());
    await page.goto('/#library');
    const list = await page.locator('.file-list').boundingBox();
    const search = await page.getByRole('searchbox', { name: 'Search PDFs' }).boundingBox();
    const sort = await page.getByLabel('Sort PDFs', { exact: true }).boundingBox();
    expect(search.x + search.width).toBeLessThanOrEqual(list.x + list.width + 0.5);
    expect(sort.x).toBeGreaterThanOrEqual(list.x - 0.5);
    expect(search.x).toBeGreaterThanOrEqual(sort.x + sort.width);
    // The field still has room for its placeholder.
    expect(search.width).toBeGreaterThanOrEqual(140);
  });
