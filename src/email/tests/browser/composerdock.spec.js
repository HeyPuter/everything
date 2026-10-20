import { test, expect } from '@playwright/test';

test('on a phone, a minimized draft does not cover the open folder drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tests/browser/conversation.html');
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.locator('.side-compose').click();
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Weekend plans');
  await page.getByRole('button', { name: 'Minimize composer' }).click();
  await expect(page.getByRole('region', { name: 'Minimized drafts' })).toBeVisible();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.waitForTimeout(400);
  const covered = await page.evaluate(() => {
    const dock = document.querySelector('.compose-dock').getBoundingClientRect();
    const side = document.querySelector('.sidebar').getBoundingClientRect();
    // What is hit at a point inside both the drawer and the dock.
    const x = Math.max(dock.left, side.left) + 10;
    const y = dock.top + dock.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { hitInDock: Boolean(hit?.closest('.compose-dock')), overlap: x < side.right };
  });
  expect(covered.overlap).toBe(true);
  expect(covered.hitInDock).toBe(false);
});
