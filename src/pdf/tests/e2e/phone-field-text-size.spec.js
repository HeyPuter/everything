import { test, expect } from '@playwright/test';

// iOS Safari zooms into a focused field whose text is under 16px and leaves the page zoomed in.
// On touch phones every field has 16px text; a desktop window keeps its compact fields.
const fieldSizes = (page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"]), select, textarea',
      ),
    ]
      // Fields on the page itself, a PDF's form, take the size the page gives them.
      .filter((field) => !field.closest('.workspace'))
      .map((field) => [
        field.getAttribute('aria-label') || field.className,
        parseFloat(getComputedStyle(field).fontSize),
      ]),
  );

test('fields on a touch phone have text of at least 16px', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone layout');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  await expect(page.getByRole('searchbox', { name: 'Search PDFs', exact: true })).toBeVisible();
  for (const [name, size] of await fieldSizes(page)) expect(size, name).toBeGreaterThanOrEqual(16);
  await page.getByRole('button', { name: 'Try a sample PDF', exact: true }).click();
  await expect(page.locator('.page-caption')).toBeVisible();
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Find in PDF', exact: true })).toBeVisible();
  const sizes = await fieldSizes(page);
  expect(sizes.map(([name]) => name)).toEqual(
    expect.arrayContaining(['Page number', 'Zoom', 'Find in PDF', 'Stroke width']),
  );
  for (const [name, size] of sizes) expect(size, name).toBeGreaterThanOrEqual(16);
  // The sample's form field on the page keeps the size its field box sets.
  const formField = page.locator('.workspace .form-control').first();
  expect(
    await formField.evaluate(
      (field) =>
        getComputedStyle(field).fontSize ===
        getComputedStyle(field).getPropertyValue('--field-font-size').trim(),
    ),
  ).toBe(true);
});

test('the library search shows its whole placeholder beside the sort order on a 320px phone', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'phone layout');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const search = page.getByRole('searchbox', { name: 'Search PDFs', exact: true });
  // Typed in, the placeholder's words fit the field without scrolling it.
  await search.fill('Search PDFs');
  expect(await search.evaluate((input) => input.scrollWidth <= input.clientWidth)).toBe(true);
});

test('the page number and the zoom share one line on a 320px phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone layout');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const pageNumber = await page.getByRole('spinbutton', { name: 'Page number' }).boundingBox();
  const zoom = await page.getByRole('combobox', { name: 'Zoom', exact: true }).boundingBox();
  expect(Math.abs(pageNumber.y + pageNumber.height / 2 - (zoom.y + zoom.height / 2))).toBeLessThan(
    4,
  );
  // A four-digit page number still fits its box.
  expect(
    await page.locator('.page-controls .page-input').evaluate((input) => {
      input.type = 'text';
      input.value = '1234';
      return input.scrollWidth <= input.clientWidth;
    }),
  ).toBe(true);
});

test('a desktop window keeps its compact fields', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const search = page.getByRole('searchbox', { name: 'Search PDFs', exact: true });
  expect(await search.evaluate((input) => getComputedStyle(input).fontSize)).toBe('12px');
});
