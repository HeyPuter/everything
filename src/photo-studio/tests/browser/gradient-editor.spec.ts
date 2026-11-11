import { expect, test } from '@playwright/test';
import { boot, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150, '#ffffff');
});

test('gradient stops can be selected, moved and deleted from the keyboard', async ({ page }) => {
  await page.evaluate(async () => {
    const { gradientEditor } = await import('/src/features/effects/gradient-editor.ts');
    void gradientEditor(window.photoStudio, {
      kind: 'solid', name: 'Three', smoothness: 100,
      colorStops: [{ location: 0, color: [0, 0, 0] }, { location: 0.5, color: [255, 0, 0] }, { location: 1, color: [255, 255, 255] }],
      opacityStops: [{ location: 0, opacity: 1 }, { location: 1, opacity: 1 }],
    });
  });
  const editor = page.getByRole('dialog', { name: 'Gradient Editor' });
  const location = editor.locator('[data-stop-location]');
  await editor.locator('[data-stop="color:1"]').focus();
  await page.keyboard.press('Enter');
  await expect(editor.locator('[data-stop="color:1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(location).toHaveValue('50');
  // Arrows move the focused stop (Shift: 10 steps); focus stays on it.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(location).toHaveValue('61');
  await expect(editor.locator('[data-stop="color:1"]')).toBeFocused();
  // Delete removes it; the last two stops of a kind stay.
  await page.keyboard.press('Delete');
  await expect(editor.locator('[data-stop^="color:"]')).toHaveCount(2);
  await expect(editor.locator('[data-stop="color:0"]')).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(editor.locator('[data-stop^="color:"]')).toHaveCount(2);
  await editor.getByRole('button', { name: 'Cancel' }).click();
});
