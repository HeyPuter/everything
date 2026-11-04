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

test('Edit › Undo names a correction made as you type AutoCorrect, and a typed list or link AutoFormat', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('She said (c)');
  await expect(input(page)).toHaveValue('She said ©');
  expect(await undoItem(page)).toMatch(/^Undo AutoCorrect/);
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('She said (c)');
  await page.keyboard.type(' i ');
  await expect(input(page)).toHaveValue('She said (c) I ');
  expect(await undoItem(page)).toMatch(/^Undo AutoCorrect/);
  await page.keyboard.type('see example.com ');
  expect(await undoItem(page)).toMatch(/^Undo AutoFormat/);
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. ');
  expect(await undoItem(page)).toMatch(/^Undo AutoFormat/);
  await page.keyboard.type('Item');
  expect(await undoItem(page)).toMatch(/^Undo Typing/);
});

test('a step keeps its name through Undo and Redo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('One ');
  await input(page).focus();
  await paste(page, 'two');
  await expect(input(page)).toHaveValue('One two');
  expect(await undoItem(page)).toMatch(/^Undo Paste/);
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('One ');
  expect(await undoItem(page)).toMatch(/^Undo Typing/);
  await input(page).press('ControlOrMeta+Shift+z');
  await expect(input(page)).toHaveValue('One two');
  expect(await undoItem(page)).toMatch(/^Undo Paste/);
  // Twice round, and in the Undo history too.
  await input(page).press('ControlOrMeta+z');
  await input(page).press('ControlOrMeta+Shift+z');
  expect(await undoItem(page)).toMatch(/^Undo Paste/);
  expect(await page.evaluate(() => window.__docs.current.view.commands.undoHistory())).toEqual(['Paste', 'Typing']);
});

test('typing just after a command that changed nothing is Typing, and is what Repeat repeats', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('Start ');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Show Formatting Marks' }).click();
  await input(page).focus();
  await page.keyboard.type('abc');
  expect(await undoItem(page)).toMatch(/^Undo Typing/);
  expect(await page.evaluate(() => window.__docs.current.view.commands.repeatLabel?.())).not.toBe('Show Formatting Marks');
});
