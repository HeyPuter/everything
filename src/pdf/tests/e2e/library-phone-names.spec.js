import { test, expect } from '@playwright/test';

// On a phone a long file name was cut to one line, and a finger has no tooltip to read the
// rest, so names that differ only at the end looked the same. They now show in full, over several lines if need be.
const files = [
  'Quarterly financial report 2025 Q1 final.pdf',
  'Quarterly financial report 2025 Q2 final.pdf',
].map((name, i) => ({
  name,
  path: `PDF Editor/${name}`,
  size: 1000,
  modified: Date.UTC(2025, 0, 2 - i),
}));

test('long file names show in full on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone layout');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env:'web', auth:{isSignedIn:()=>true,getUser:async()=>({username:'test-user'})}, fs:{readdir:async()=>${JSON.stringify(files)}}, ui:{} };`,
    }),
  );
  await page.goto('/#library');
  const names = page.locator('.file-open span');
  await expect(names).toHaveCount(2);
  // Nothing is cut off: not to the side, and not below the lines shown.
  for (const name of await names.all())
    expect(
      await name.evaluate((span) => {
        const shown = span.getBoundingClientRect().height;
        span.style.webkitLineClamp = 'none';
        const full = span.getBoundingClientRect().height;
        span.style.webkitLineClamp = '';
        return span.scrollWidth <= span.clientWidth && full - shown < 1;
      }),
    ).toBe(true);
  // The rows stay within the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
