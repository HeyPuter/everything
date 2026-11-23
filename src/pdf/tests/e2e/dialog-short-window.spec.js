import { test, expect } from '@playwright/test';

// On a phone turned sideways a dialog's title bar and padding took about 120 of its 335px,
// leaving its body (which scrolls) little more than half the dialog.
test('a dialog in a short window gives most of its height to its body', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  await page.locator('.home-footer').getByRole('button', { name: 'Keyboard shortcuts' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox()) ?? { y: 0, height: 0 };
  const body = await dialog.locator('.dialog-body').evaluate((node) => node.clientHeight);
  // The dialog stays within the window, and its body has nearly all of it.
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(375);
  expect(box.height).toBeGreaterThan(350);
  expect(body).toBeGreaterThan(box.height - 60);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
