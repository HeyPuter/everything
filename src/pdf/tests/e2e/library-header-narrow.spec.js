import { test, expect } from '@playwright/test';

// On a 320px phone a long account name pushed Settings past the right edge of the screen (and
// a phone then zoomed the whole library out to fit it). The name now gives way instead.
test('a long account name leaves Settings on screen on the smallest phones', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env:'web', auth:{isSignedIn:async()=>true,getUser:async()=>({username:'a-rather-long-username-here'})}, fs:{readdir:async()=>[]}, ui:{} };`,
    }),
  );
  await page.goto('/#library');
  const label = page.locator('.account-label');
  await expect(label).toHaveText('a-rather-long-username-here');
  const settings = await page.getByRole('button', { name: 'Settings', exact: true }).boundingBox();
  expect(settings.x + settings.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  // The name is shortened, not hidden.
  expect((await label.boundingBox()).width).toBeGreaterThan(40);
});
