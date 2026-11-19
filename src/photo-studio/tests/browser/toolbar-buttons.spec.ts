import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run, selectRect } from './helpers';

// The buttons at the foot of the toolbar: Quick Mask with its options, the
// screen mode list, and the Edit Toolbar slot.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('photo-studio-quick-mask'));
  await boot(page);
  await openImage(page, 200, 100, '#808080');
});

const quickMask = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Quick Mask mode' });

test('double-clicking Quick Mask enters it and opens its options', async ({ page }) => {
  await quickMask(page).dblclick();
  const dialog = page.getByRole('dialog', { name: 'Quick Mask Options' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => !!window.photoStudio.doc.quickMask)).toBe(true);
  await dialog.locator('input[name="opacity"]').fill('80');
  await dialog.getByRole('button', { name: 'OK' }).click();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-quick-mask')!).opacity),
  ).toBe(0.8);
  // Only one step was added: entering Quick Mask.
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe(
    'Edit in Quick Mask Mode',
  );
});

test('Selected Areas: the film marks the selection and leaving keeps it', async ({ page }) => {
  await selectRect(page, { x: 20, y: 20, width: 60, height: 40 });
  await run(page, 'select.quick-mask');
  const channel = () =>
    page.evaluate(async () => {
      const e = window.photoStudio;
      const { readMask } = await import('/src/model/tiles.ts');
      const m = readMask(e.assets.tiles, e.doc.quickMask!, { x: 0, y: 0, width: 200, height: 100 });
      return [m.data[30 * 200 + 40], m.data[5 * 200 + 5]];
    });
  expect(await channel()).toEqual([255, 0]);
  // Switching what the color means flips the channel and keeps the selection.
  void page.evaluate(() => window.photoStudio.runCommand('select.quick-mask-options'));
  const dialog = page.getByRole('dialog', { name: 'Quick Mask Options' });
  await dialog.locator('select[name="indicates"]').selectOption('selected');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await channel()).toEqual([0, 255]);
  await run(page, 'select.quick-mask');
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject({
    x: 20,
    y: 20,
    width: 60,
    height: 40,
  });
  // Entering again in this mode stores the inverse of the selection.
  await run(page, 'select.quick-mask');
  expect(await channel()).toEqual([0, 255]);
  await run(page, 'select.quick-mask');
  // With nothing selected the channel is all white: no film, nothing selected on leaving.
  await run(page, 'select.deselect');
  await run(page, 'select.quick-mask');
  expect(await channel()).toEqual([255, 255]);
  await run(page, 'select.quick-mask');
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toBeFalsy();
});

test('the screen mode button lists the modes on right-click', async ({ page }) => {
  await page.getByRole('button', { name: 'Change screen mode' }).click({ button: 'right' });
  await expect(
    page.getByRole('menuitemcheckbox', { name: 'Full Screen Mode With Menu Bar' }),
  ).toBeVisible();
  const standard = page.getByRole('menuitemcheckbox', { name: 'Standard Screen Mode' });
  await expect(standard).toHaveAttribute('aria-checked', 'true');
  await standard.click();
  await expect(standard).toHaveCount(0);
});

test('the toolbar always ends with Edit Toolbar', async ({ page }) => {
  const slot = page
    .getByRole('toolbar', { name: 'Editing tools' })
    .getByRole('button', { name: 'Edit toolbar' });
  await slot.click();
  await page.getByRole('menuitem', { name: 'Edit Toolbar…' }).click();
  await expect(page.locator('dialog.toolbar-editor')).toBeVisible();
});
