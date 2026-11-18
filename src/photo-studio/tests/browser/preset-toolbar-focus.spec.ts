// Preset Manager and Customize Toolbar rebuild their contents on every choice;
// the keyboard focus stays on the control used, or follows the item moved.
import { expect, test } from '@playwright/test';
import { boot, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('photo-studio-toolbar'));
  await boot(page);
});

test('Preset Manager tabs keep the keyboard focus', async ({ page }) => {
  await start(page, 'edit.preset-manager');
  const dialog = page.getByRole('dialog', { name: 'Preset Manager' });
  const gradients = dialog.locator('[data-kind="gradients"]');
  await gradients.focus();
  await page.keyboard.press('Enter');
  await expect(gradients).toHaveAttribute('aria-selected', 'true');
  await expect(gradients).toBeFocused();
});

test('moving tools and slots in Customize Toolbar keeps the focus on what moved', async ({
  page,
}) => {
  await start(page, 'edit.toolbar');
  const dialog = page.getByRole('dialog', { name: /Customize Toolbar/ });
  const order = () =>
    dialog.locator('.tbe-slot').evaluateAll((s) => s.map((x) => (x as HTMLElement).dataset.slot));
  await expect(dialog.locator('.tbe-slot').first()).toBeVisible();
  const before = await order();
  const down = dialog.locator(`[data-slot-down="${before[0]}"]`);
  await down.focus();
  await page.keyboard.press('Enter');
  expect((await order())[1]).toBe(before[0]);
  await expect(down).toBeFocused();
  const move = dialog.locator('[data-move-tool]').first();
  const tool = await move.getAttribute('data-move-tool');
  await move.focus();
  await page.keyboard.press('Enter');
  const moved = dialog.locator(`.tbe-extra [data-move-tool="${tool}"]`);
  await expect(moved).toHaveCount(1);
  await expect(moved).toBeFocused();
});
