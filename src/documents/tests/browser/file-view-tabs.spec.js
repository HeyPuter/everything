import { test, expect } from '@playwright/test';

async function openFileView(page, width) {
  await page.setViewportSize({ width, height: 760 });
  await page.goto('/mock.html#/new');
  await expect(page.locator('.canvas-workspace')).toBeVisible();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Harbour report');
  await page.locator('.ribbon-file').click();
  const view = page.getByRole('dialog', { name: 'File' });
  await expect(view.getByRole('tab', { name: 'Info' })).toBeFocused();
  return view;
}

test('in a narrow window the File view’s pages run along the top and Left and Right move between them', async ({ page }) => {
  const view = await openFileView(page, 600);
  const list = view.getByRole('tablist', { name: 'File' });
  await expect(list).toHaveAttribute('aria-orientation', 'horizontal');
  await page.keyboard.press('ArrowRight');
  await expect(view.getByRole('tab', { name: 'Save' })).toBeFocused();
  await expect(view.getByRole('tab', { name: 'Save' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(view.getByRole('tab', { name: 'Open' })).toBeFocused();
  // Up and Down belong to the vertical list only.
  await page.keyboard.press('ArrowDown');
  await expect(view.getByRole('tab', { name: 'Open' })).toBeFocused();
});

test('in a wide window the File view’s pages run down the side and Up and Down move between them', async ({ page }) => {
  const view = await openFileView(page, 1280);
  await expect(view.getByRole('tablist', { name: 'File' })).toHaveAttribute('aria-orientation', 'vertical');
  await page.keyboard.press('ArrowDown');
  await expect(view.getByRole('tab', { name: 'Save' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(view.getByRole('tab', { name: 'Save' })).toBeFocused();
  // The window narrowing while the view is open turns the list.
  await page.setViewportSize({ width: 600, height: 760 });
  await expect(view.getByRole('tablist', { name: 'File' })).toHaveAttribute('aria-orientation', 'horizontal');
  await page.keyboard.press('ArrowRight');
  await expect(view.getByRole('tab', { name: 'Print' })).toBeFocused();
});
