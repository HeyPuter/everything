import { test, expect } from '@playwright/test';

const show = (page) => page.evaluate(async () => {
  const { toast } = await import('/src/ui/toast.js');
  toast('Archived 3 messages.', { iconName: 'archive', duration: 60000, action: { label: 'Undo', onSelect() {} } });
});

test('a short toast stays on one line on a phone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/tests/browser/boot.html');
  await expect(page.locator('.row').first()).toBeVisible();
  await show(page);
  const box = await page.locator('.toast').boundingBox();
  expect(box.height).toBeLessThan(45);
  // Centred, inside the window.
  expect(Math.abs(box.x + box.width / 2 - 195)).toBeLessThan(2);
  await context.close();
});

test('a toast is centred and no wider than it needs on a desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/tests/browser/boot.html');
  await expect(page.locator('.row').first()).toBeVisible();
  await show(page);
  const box = await page.locator('.toast').boundingBox();
  expect(box.width).toBeLessThan(400);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(2);
});
