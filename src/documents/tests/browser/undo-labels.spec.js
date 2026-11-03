import { test, expect } from '@playwright/test';

// Edit › Undo names the step it takes back, as the Undo history does.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const paste = (page, text) => input(page).evaluate((el, text) => {
  el.focus(); const data = new DataTransfer(); data.setData('text/plain', text);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, text);
async function undoItem(page) {
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('menu', { name: 'Edit', exact: true });
  const label = await edit.getByRole('menuitem', { name: /^(Undo|Can’t Undo)/ }).first().textContent();
  await page.keyboard.press('Escape');
  return label;
}

test('Edit › Undo names a keyboard paste and a Replace All, not Typing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('One fish ');
  expect(await undoItem(page)).toMatch(/^Undo Typing/);
  await input(page).focus();
  await paste(page, 'two fish');
  await expect(input(page)).toHaveValue('One fish two fish');
  expect(await undoItem(page)).toMatch(/^Undo Paste/);
  await input(page).press(process.platform === 'darwin' ? 'Meta+Shift+h' : 'Control+h');
  const panel = page.getByRole('search', { name: 'Find and replace' });
  await panel.getByRole('textbox', { name: 'Find text', exact: true }).fill('fish');
  await panel.getByRole('textbox', { name: 'Replace with', exact: true }).fill('cat');
  await panel.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(input(page)).toHaveValue('One cat two cat');
  expect(await undoItem(page)).toMatch(/^Undo Replace All/);
});
