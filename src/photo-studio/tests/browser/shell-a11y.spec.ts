// Accessibility of the workspace chrome: dialog names, menu keyboard use,
// focus handling and small-screen layout.
import { test, expect } from '@playwright/test';
import { boot, openImage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'a11y.png');
});

test('every dialog is announced by its title', async ({ page }) => {
  // The shared question dialog, reused for one question after another.
  for (const [id, title] of [['layer.new', 'New Layer'], ['image.duplicate', 'Duplicate Image']]) {
    await start(page, id);
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  }
  // Dialogs built by features, which only have a heading.
  for (const [id, title] of [['edit.keyboard-shortcuts', 'Keyboard Shortcuts'], ['edit.menus', 'Menus']]) {
    await start(page, id);
    await expect(page.getByRole('dialog', { name: new RegExp(title) })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  }
});

test('menu bar menus follow the arrow keys, Home, End and Tab, also when opened with the pointer', async ({ page }) => {
  const openMenu = () => page.evaluate(() => [...document.querySelectorAll('.menubar-entry.open > .menubar-button')].map((b) => b.textContent).join());
  const focused = () => page.evaluate(() => document.activeElement?.closest('.menu-item')?.getAttribute('data-command') ?? document.activeElement?.className);
  const items = (menu: string) => page.locator(`.menubar-entry:has(> .menubar-button:text-is("${menu}")) > .menu-pop > .menu-item`);
  await page.locator('.menubar-button').first().focus();
  await page.keyboard.press('Enter');
  expect(await openMenu()).toBe('File');
  await page.keyboard.press('End');
  await expect(items('File').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items('File').first()).toBeFocused();
  // Right and Left on a plain item move to the neighbouring menus.
  await page.keyboard.press('ArrowRight');
  expect(await openMenu()).toBe('Edit');
  await expect(items('Edit').first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  expect(await openMenu()).toBe('File');
  await page.keyboard.press('ArrowLeft');
  expect(await openMenu()).toBe('Help');
  // Tab leaves the menu bar and closes the menu.
  await page.keyboard.press('Tab');
  expect(await openMenu()).toBe('');
  expect(await focused()).not.toContain('menu-item');
  // A menu opened with the pointer takes the arrows too, without moving layers.
  await page.locator('#viewport').focus();
  const before = await page.evaluate(() => JSON.stringify(window.photoStudio.doc.layers));
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('ArrowDown');
  await expect(items('Edit').first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items('Edit').last()).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await openMenu()).toBe('');
  expect(await page.evaluate(() => JSON.stringify(window.photoStudio.doc.layers))).toBe(before);
});
