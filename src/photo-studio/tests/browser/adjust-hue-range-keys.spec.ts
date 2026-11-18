import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 120, 80, '#c04040');
});

test('Hue/Saturation range handles move with the arrow keys and keep focus', async ({ page }) => {
  await start(page, 'adjust.hue-saturation');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Range' }).selectOption('reds');
  const end = dialog.getByRole('slider', { name: 'Range end' });
  await expect(end).toHaveAttribute('aria-valuenow', '15');
  await end.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(end).toHaveAttribute('aria-valuenow', '26');
  await expect(end).toBeFocused();
  // A handle stops at its neighbor.
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(end).toHaveAttribute('aria-valuenow', '45');
  await page.keyboard.press('ArrowLeft');
  await expect(end).toHaveAttribute('aria-valuenow', '44');
  await expect(dialog.locator('.adj-range-values')).toHaveText(/315° \/ 345°\s+44° \\ 45°/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('Hue/Saturation layer range handles keep focus in Properties', async ({ page }) => {
  await run(page, 'layer.adj-hue-saturation');
  const props = page.locator('.adj-props');
  await props.getByRole('combobox', { name: 'Range' }).selectOption('blues');
  const start = props.getByRole('slider', { name: 'Falloff start' });
  await expect(start).toHaveAttribute('aria-valuenow', '195');
  await start.focus();
  await page.keyboard.press('ArrowLeft');
  await idle(page);
  await page.keyboard.press('ArrowLeft');
  await idle(page);
  await expect(props.getByRole('slider', { name: 'Falloff start' })).toHaveAttribute(
    'aria-valuenow',
    '193',
  );
  await expect(props.getByRole('slider', { name: 'Falloff start' })).toBeFocused();
  const stored = await page.evaluate(() => {
    const l = window.photoStudio.doc.layers.at(-1)!;
    return (l.adjustment!.params as { ranges: { blues: { range: number[] } } }).ranges.blues.range;
  });
  expect(stored).toEqual([193, 225, 255, 285]);
});
