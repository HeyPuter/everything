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

test('dragging a divider between panel groups resizes only those two groups, also by touch', async ({ page }) => {
  const heights = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('.dock-column .panel-group:not(.empty)')].map((g) => [g.dataset.location, Math.round(g.getBoundingClientRect().height)])));
  const drag = async (loc: string, dy: number) => {
    const b = (await page.locator(`[data-resize="${loc}"]`).boundingBox())!;
    await page.mouse.move(b.x + 40, b.y + 3);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 3 + dy, { steps: 4 });
    await page.mouse.up();
  };
  const before = await heights();
  expect(Object.keys(before)).toEqual(['dock-top', 'dock-middle', 'dock-bottom']);
  // Between the middle and bottom groups: the top group keeps its height.
  await drag('dock-middle', 40);
  let now = await heights();
  expect(Math.abs(now['dock-top'] - before['dock-top'])).toBeLessThanOrEqual(1);
  expect(Math.abs(now['dock-middle'] - (before['dock-middle'] + 40))).toBeLessThanOrEqual(2);
  expect(Math.abs(now['dock-bottom'] - (before['dock-bottom'] - 40))).toBeLessThanOrEqual(2);
  // Between the top and middle groups: the bottom group keeps its height.
  const mid = now;
  await drag('dock-top', -40);
  now = await heights();
  expect(Math.abs(now['dock-bottom'] - mid['dock-bottom'])).toBeLessThanOrEqual(1);
  expect(Math.abs(now['dock-top'] - (mid['dock-top'] - 40))).toBeLessThanOrEqual(2);
  // The arrangement is kept after a reload.
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  const reloaded = await heights();
  for (const loc of Object.keys(now)) expect(Math.abs(reloaded[loc] - now[loc]), loc).toBeLessThanOrEqual(2);
  // The browser does not take a touch drag on the divider for scrolling.
  expect(await page.locator('[data-resize="dock-top"]').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
});

test('a tool chosen from a toolbar flyout with the keyboard keeps the focus on its slot', async ({ page }) => {
  const slot = page.locator('[data-slot="marquee"]');
  await slot.focus();
  await page.keyboard.press('ArrowRight');
  const flyout = page.locator('.tool-flyout');
  await expect(flyout).toBeVisible();
  await page.keyboard.press('End');
  await expect(flyout.locator('button').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(flyout.locator('button').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const chosen = await flyout.locator('button:focus').getAttribute('data-flyout-tool');
  await page.keyboard.press('Enter');
  await expect(flyout).toHaveCount(0);
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe(chosen);
  await expect(page.locator('[data-slot="marquee"]')).toBeFocused();
  // Tab closes the flyout instead of leaving it open behind the focus.
  await page.keyboard.press('ArrowRight');
  await expect(flyout).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(flyout).toHaveCount(0);
  await expect(page.locator('[data-slot="marquee"]')).toBeFocused();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('the Preferences window keeps Cancel and Done on screen', async ({ page }) => {
    await start(page, 'edit.preferences');
    const dialog = page.getByRole('dialog', { name: 'Preferences' });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    for (const name of ['Import…', 'Export…', 'Restore Page Defaults', 'Cancel', 'Done']) {
      const b = (await dialog.locator('.prefs-foot').getByRole('button', { name, exact: true }).boundingBox())!;
      expect(b.x, name).toBeGreaterThanOrEqual(box.x);
      expect(b.x + b.width, name).toBeLessThanOrEqual(Math.min(375, box.x + box.width));
    }
    await dialog.locator('.prefs-foot').getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('icon panels open on screen beside the icon strip', async ({ page }) => {
    await page.evaluate(() => window.photoStudio.runCommand('window.toggle-panels'));
    const strip = (await page.locator('.dock-strip').boundingBox())!;
    for (const id of ['history', 'measurement-log']) {
      await page.evaluate((id) => window.photoStudio.runCommand(`window.panel.${id}`), id);
      const drawer = page.locator('.dock-drawer');
      await expect(drawer).toBeVisible();
      await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const r = (await drawer.boundingBox())!;
      expect(r.x, id).toBeGreaterThanOrEqual(strip.x + strip.width - 1);
      expect(r.x + r.width, id).toBeLessThanOrEqual(375);
      expect(r.width, id).toBeGreaterThan(250);
      await page.evaluate((id) => window.photoStudio.runCommand(`window.panel.${id}`), id);
      await expect(drawer).toBeHidden();
    }
  });
});
