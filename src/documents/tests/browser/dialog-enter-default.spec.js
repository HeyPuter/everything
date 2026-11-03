import { test, expect } from '@playwright/test';

// Enter in a dialog presses its default button, as in the app's other dialogs (and Word's). Word Count and
// Customize Keyboard were not forms, so Enter on their check box, list or search did nothing.
async function openEditor(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}
const tools = async (page, item) => {
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu', { name: 'Tools', exact: true }).getByRole('menuitem', { name: item }).click();
};

test('Enter on the Word Count check box closes it, as its Close button does', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('textbox', { name: 'Document text' }).fill('Three short words');
  await tools(page, /^Word Count/);
  const dialog = page.getByRole('dialog', { name: 'Word Count' });
  const box = dialog.getByRole('checkbox', { name: 'Include text boxes, footnotes and endnotes' });
  await expect(box).toBeFocused();
  const checked = await box.isChecked();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  // Enter pressed the button; it did not change the box.
  await tools(page, /^Word Count/);
  await expect(dialog.getByRole('checkbox', { name: 'Include text boxes, footnotes and endnotes' })).toBeChecked({ checked });
  // Space still changes the box and leaves the dialog open.
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('checkbox')).toBeChecked({ checked: !checked });
  await expect(dialog).toBeVisible();
});

test('Enter in Customize Keyboard presses Done, except in the shortcut field, which records it', async ({ page }) => {
  await openEditor(page);
  await tools(page, 'Customize Keyboard…');
  const dialog = page.getByRole('dialog', { name: 'Customize Keyboard' });
  // Enter in the search box it opens on. (Enter on the Category list follows the platform: Chrome on macOS
  // submits a form from a list box, Linux and Windows do not, as in every other dialog.)
  await expect(dialog.getByRole('searchbox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await tools(page, 'Customize Keyboard…');
  await dialog.getByRole('searchbox', { name: 'Search commands' }).fill('Bold');
  await dialog.getByRole('option', { name: /^Bold/ }).first().click();
  await dialog.getByRole('textbox', { name: 'New shortcut' }).click();
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'New shortcut' })).not.toHaveValue('');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('searchbox', { name: 'Search commands' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
});
