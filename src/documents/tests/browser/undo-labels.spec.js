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
  // Edit › Redo names what it puts back.
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Edit', exact: true }).getByRole('menuitem', { name: /^Redo/ })).toHaveText(/^Redo Paste/);
  await page.keyboard.press('Escape');
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

test('a paste switched to text only from its options is still named Paste', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('One ');
  await input(page).evaluate(el => {
    el.focus(); const data = new DataTransfer();
    data.setData('text/plain', 'Big words'); data.setData('text/html', '<b style="font-size:20pt">Big words</b>');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(input(page)).toHaveValue('One Big words');
  expect(await undoItem(page)).toMatch(/^Undo Paste/);
  await page.getByRole('button', { name: 'Pasted text options' }).click();
  await page.getByRole('menuitemradio', { name: 'Keep Text Only' }).click();
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.some(r => r.bold))).toBe(false);
  expect(await undoItem(page)).toMatch(/^Undo Paste/);
});

test('Redo, not Repeat, after a design change is undone: Edit › Redo, the Redo button and Ctrl+Y', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('Report');
  // A command Repeat could run again.
  await input(page).press('ControlOrMeta+a');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Bold', exact: true }).click();
  await page.locator('#ribbon-tab-design').click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Themes' }).click();
  await page.getByRole('menu', { name: 'Themes' }).getByRole('menuitemradio', { name: 'Harbor theme' }).click();
  const label = () => page.evaluate(() => window.__docs.current.view.commands.undoLabel());
  const undone = async () => {
    await expect.poll(label).toBe('Theme');
    await input(page).press('ControlOrMeta+z');
    await expect.poll(() => page.evaluate(() => window.__docs.current.view.commands.packageHistory().redo)).toBe(true);
  };
  await undone();
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menu', { name: 'Edit', exact: true }).getByRole('menuitem', { name: /^Redo/ }).click();
  await undone();
  await expect(page.locator('.ed-quick').getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.locator('.ed-quick').getByRole('button', { name: 'Redo', exact: true }).click();
  await undone();
  await input(page).press('ControlOrMeta+y');
  await expect.poll(label).toBe('Theme');
  // Bold was never repeated.
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.every(r => r.bold))).toBe(true);
});

test('a keyboard command just after a ribbon command that changed nothing is named for what it did', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('Some words');
  await input(page).press('ControlOrMeta+a');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Show Formatting Marks' }).click();
  await input(page).focus();
  await input(page).press('ControlOrMeta+i');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.every(r => r.italic))).toBe(true);
  expect(await undoItem(page)).toMatch(/^Undo Formatting/);
  expect(await page.evaluate(() => window.__docs.current.view.commands.repeatLabel?.())).not.toBe('Show Formatting Marks');
});

test('a change made in a dialog is named after the command that opened it, however long the dialog was open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('Some words');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Paragraph Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Paragraph' });
  await dialog.getByLabel('Left indent (in)').fill('0.5');
  // Longer than a command is remembered without a dialog.
  await page.waitForTimeout(3300);
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  expect(await undoItem(page)).toMatch(/^Undo Paragraph Settings/);
});
