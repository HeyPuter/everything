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

// Select all (in the Edit menu) and the text styles had keys but no line in the list.
test('the shortcuts list names select all and the text styles', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(dialog).toContainText(/Select all the text on the page(⌘A|Ctrl\+A)/);
  await expect(dialog).toContainText(
    /Bold, italic, underline while editing text(⌘B|Ctrl\+B), I, U/,
  );
});

// The keys that edit, remove, save and cancel text (said by the selected text's description and
// the editing panel) had no line in the list.
test('the shortcuts list names the keys that edit, save and cancel text', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  const row = (label) => dialog.locator('.shortcut-list > div').filter({ hasText: label });
  await expect(row('Edit the selected text').locator('kbd')).toHaveText('Enter / F2');
  await expect(row('Delete the selected text, comment or object').locator('kbd')).toHaveText(
    'Delete',
  );
  await expect(row('Save the text, note or reply being written').locator('kbd')).toHaveText(
    /^(⌘Enter|Ctrl\+Enter)$/,
  );
  await expect(row('Cancel the text being edited').locator('kbd')).toHaveText('Esc');
});

// On the smallest phones the longest keys ("Ctrl / ⌘ G, with Shift; F3", as the list then wrote it) ran past the edge of
// the list and squeezed their names into a word a line.
test('every shortcut fits the list on the smallest phones', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(dialog).toBeVisible();
  const overflowing = await dialog.locator('.shortcut-list > div').evaluateAll((rows) =>
    rows
      .filter((row) => {
        const box = row.getBoundingClientRect();
        return [...row.children].some((part) => {
          const own = part.getBoundingClientRect();
          return own.right > box.right + 0.5 || own.height > 60;
        });
      })
      .map((row) => row.textContent),
  );
  expect(overflowing).toEqual([]);
});

// The list wrote every key as "Ctrl / ⌘ S" for everyone, where the menus write each platform's
// own: ⌘S on a Mac, Ctrl+S elsewhere. The two now agree.
test('the shortcuts list writes the keys as the menus do', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  test.skip(!(await bar.isVisible()), 'the menu bar is folded on phones');
  await bar.getByRole('menuitem', { name: 'File', exact: true }).click();
  const menuKey = async (name) =>
    page
      .getByRole('menu')
      .getByRole('menuitem', { name, exact: true })
      .locator('.menu-shortcut')
      .textContent();
  const print = await menuKey('Print…');
  const download = await menuKey('Download');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  const row = (label) => dialog.locator('.shortcut-list > div').filter({ hasText: label });
  await expect(row('Print').locator('kbd')).toHaveText(print);
  await expect(row('Download').locator('kbd')).toHaveText(download);
  await expect(dialog.locator('kbd').filter({ hasText: 'Ctrl / ⌘' })).toHaveCount(0);
});
