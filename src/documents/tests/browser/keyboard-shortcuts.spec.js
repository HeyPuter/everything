import { test, expect } from '@playwright/test';
import { onTab, showAllTools } from './helpers/editor-tools.js';

async function newDocument(page, text) {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  return input;
}
async function caretIn(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}

test('paragraph chords set spacing, indents and styles, and move paragraphs', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await newDocument(page, 'Alpha\nBravo\nCharlie');
  await showAllTools(page);
  await caretIn(input, 'Bravo');
  await input.press('Control+2');
  await expect(page.getByRole('combobox', { name: 'Line spacing' })).toHaveValue('2');
  await input.press('Control+5');
  await expect(page.getByRole('combobox', { name: 'Line spacing' })).toHaveValue('1.5');
  await input.press('Control+0');
  await expect((await onTab(page, 'layout')).getByRole('spinbutton', { name: 'Space before paragraph (pt)' })).toHaveValue('12');
  await input.press('Control+0');
  await expect(page.getByRole('spinbutton', { name: 'Space before paragraph (pt)' })).toHaveValue('0');
  await input.press('Control+m'); await input.press('Control+m');
  await expect(page.getByRole('spinbutton', { name: 'Indent left (in)' })).toHaveValue('1');
  await input.press('Control+Shift+m');
  await expect(page.getByRole('spinbutton', { name: 'Indent left (in)' })).toHaveValue('0.5');
  await input.press('Control+t');
  await expect(page.getByRole('spinbutton', { name: 'Indent left (in)' })).toHaveValue('1');
  await input.press('Control+q');
  await expect(page.getByRole('spinbutton', { name: 'Indent left (in)' })).toHaveValue('0');
  await expect(page.getByRole('combobox', { name: 'Line spacing' })).toHaveValue('1');
  await input.press('Control+Alt+1');
  await expect(page.getByRole('combobox', { name: 'Paragraph style' })).toHaveValue('Heading1');
  await input.press('Control+Shift+n');
  await expect(page.getByRole('combobox', { name: 'Paragraph style' })).toHaveValue('Normal');
  // Control+Shift on a Mac, where Option+Shift+Up/Down extends the selection by paragraph.
  const move = process.platform === 'darwin' ? 'Control+Shift' : 'Alt+Shift';
  await input.press(`${move}+ArrowUp`);
  await expect(input).toHaveValue('Bravo\nAlpha\nCharlie');
  await input.press(`${move}+ArrowDown`); await input.press(`${move}+ArrowDown`);
  await expect(input).toHaveValue('Alpha\nCharlie\nBravo');
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue('Alpha\nBravo\nCharlie');
  await caretIn(input, 'Alpha');
  await input.press('Control+Shift+d');
  await page.keyboard.type('X');
  await input.press('Shift+ArrowLeft');
  await input.press('ControlOrMeta+d');
  await expect(page.getByRole('dialog', { name: 'Font' }).getByLabel('Underline style')).toHaveValue('double');
  expect(errors).toEqual([]);
});

test('Go To +n counts from the caret when it is before the first target', async ({ page }) => {
  const input = await newDocument(page, 'Intro text\nHeading A\nbody one\nHeading B\nbody two');
  for (const heading of ['Heading A', 'Heading B']) { await caretIn(input, heading); await input.press('Control+Alt+1'); }
  const dialog = page.getByRole('dialog', { name: 'Go To' });
  for (const [move, heading] of [['+1', 'Heading A'], ['+2', 'Heading B']]) {
    await caretIn(input, 'Intro');
    await input.press('F5');
    await dialog.getByLabel('Go to what').selectOption('heading');
    await dialog.getByLabel('Enter heading number').fill(move);
    await dialog.getByRole('button', { name: 'Go To' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionStart + 9))).toBe(heading);
  }
  // Nothing comes before the first heading.
  await caretIn(input, 'Intro');
  await input.press('F5');
  await dialog.getByLabel('Go to what').selectOption('heading');
  await dialog.getByLabel('Enter heading number').fill('-1');
  await dialog.getByRole('button', { name: 'Go To' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('This document has 2 headings.');
});

test('Go To jumps to pages, headings and bookmarks, and the Breaks menu inserts a column break', async ({ page }) => {
  const input = await newDocument(page, 'Start');
  for (let i = 0; i < 2; i++) { await input.press('End'); await input.press('ControlOrMeta+Enter'); await page.keyboard.type(`Page ${i + 2} text`); }
  await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
  await input.press('ControlOrMeta+Home');
  await input.press('F5');
  const dialog = page.getByRole('dialog', { name: 'Go To' });
  await dialog.getByLabel('Enter page number').fill('3');
  await dialog.getByRole('button', { name: 'Go To' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionStart + 4))).toBe('Page');
  await expect(page.locator('.ed-statusbar')).toContainText('Page 3 of 3');
  await input.press('F5');
  await dialog.getByLabel('Enter page number').fill('-1');
  await dialog.getByRole('button', { name: 'Go To' }).click();
  await expect(page.locator('.ed-statusbar')).toContainText('Page 2 of 3');
  await expect(dialog).toHaveCount(0);
  await input.press('F5');
  await dialog.getByLabel('Enter page number').fill('9');
  await dialog.getByRole('button', { name: 'Go To' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('This document has 3 pages.');
  await dialog.getByLabel('Go to what').selectOption('line');
  await dialog.getByRole('button', { name: 'Previous' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ed-statusbar')).toContainText('Page 1 of 3');
  await onTab(page, 'layout');
  await caretIn(input, 'text');
  await page.locator('.ribbon-card').getByRole('button', { name: 'Breaks' }).click();
  await page.getByRole('menuitem', { name: 'Column' }).click();
  expect(await input.inputValue()).toContain('Page 2 \ntext');
});
