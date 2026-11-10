import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The list of shortcuts is longer than a short window and has no controls of its own: the
// keyboard must still be able to scroll through it.
test('the keyboard scrolls through the shortcuts list in a short window', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 520 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(dialog).toBeVisible();
  const list = dialog.locator('.dialog-body');
  expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await expect(list).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const { violations } = await new AxeBuilder({ page })
    .include('dialog')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeFocused();
});
