import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

async function newDocument(page, text) {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  return input;
}
async function select(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); if (at < 0) throw Error(`Missing ${text}`); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}
/** The caret's place on the pages after putting it at an offset into the first occurrence of a text. */
async function caretAt(input, text, offset = 0) {
  await input.evaluate((el, [text, offset]) => { const at = el.value.indexOf(text) + offset; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, [text, offset]);
  return input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height) }));
}
const button = (page, name) => page.locator('.ribbon-card').getByRole('button', { name, exact: true });

test('Change Case menu and Shift+F3 change the selection in one undo step', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await newDocument(page, 'quiet words here');
  await onTab(page, 'home');
  await select(input, 'quiet words');
  await button(page, 'Change Case').click();
  await page.getByRole('menuitem', { name: 'UPPERCASE' }).click();
  await expect(input).toHaveValue('QUIET WORDS here');
  await expect(input).toBeFocused();
  await input.press('Shift+F3');
  await expect(input).toHaveValue('quiet words here');
  await input.press('Shift+F3');
  await expect(input).toHaveValue('Quiet Words here');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('quiet words here');
  expect(errors).toEqual([]);
});

test('Format Painter copies formatting with one click, keeps painting after a double click, and saves', async ({ page }, info) => {
  const input = await newDocument(page, 'Source text\nFirst target\nSecond target');
  await onTab(page, 'home');
  await select(input, 'Source');
  await button(page, 'Bold').click();
  await button(page, 'Italic').click();
  const painter = button(page, 'Format Painter');
  await painter.click();
  await expect(painter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.canvas-host')).toHaveClass(/is-format-painting/);
  // Drag across "First" on the page: the painter applies when the mouse is released.
  const surface = await page.locator('.canvas-pages').boundingBox();
  const from = await caretAt(input, 'First'), to = await caretAt(input, 'First', 5);
  await page.mouse.move(surface.x + from.left + 1, surface.y + from.top + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(surface.x + to.left - 1, surface.y + to.top + to.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(painter).toHaveAttribute('aria-pressed', 'false');
  await select(input, 'Firs');
  await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true');
  // A double click keeps the painter armed until Escape.
  await select(input, 'Source');
  await painter.dblclick();
  await expect(painter).toHaveAttribute('aria-pressed', 'true');
  const second = await caretAt(input, 'Second', 2);
  await page.mouse.click(surface.x + second.left, surface.y + second.top + second.height / 2);
  await expect(painter).toHaveAttribute('aria-pressed', 'true');
  await input.press('Escape');
  await expect(painter).toHaveAttribute('aria-pressed', 'false');
  await select(input, 'Second');
  await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  await select(input, 'target');
  await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'false');
  const path = info.outputPath('format-painter.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  await reopenDocx(page, input, path, 'Source text\nFirst target\nSecond target');
  await select(input, 'First');
  await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true');
});

test('Sort orders the selected paragraphs from its dialog', async ({ page }) => {
  const input = await newDocument(page, 'pear\nApple\nfig');
  await onTab(page, 'home');
  await input.press('ControlOrMeta+a');
  await button(page, 'Sort').click();
  const dialog = page.getByRole('dialog', { name: 'Sort Text' });
  await dialog.getByLabel('Descending').check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(input).toHaveValue('pear\nfig\nApple');
  await expect(dialog).toHaveCount(0);
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue('pear\nApple\nfig');
  await button(page, 'Sort').click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(input).toHaveValue('Apple\nfig\npear');
});

test('Show/Hide formatting marks toggles from the ribbon and the keyboard without changing the text', async ({ page }) => {
  const input = await newDocument(page, 'a b\tc');
  await onTab(page, 'home');
  const marks = button(page, 'Show Formatting Marks');
  const pixels = () => page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL());
  const plain = await pixels();
  await marks.click();
  await expect(marks).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(pixels).not.toBe(plain);
  await input.press('ControlOrMeta+8');
  await expect(marks).toHaveAttribute('aria-pressed', 'false');
  await expect(input).toHaveValue('a b\tc');
});

test('edits the independent control with every Home editing command and reopens its download', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/home-editing.docx');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^editing commands control/);
  await onTab(page, 'home');
  await button(page, 'Show Formatting Marks').click();
  await page.locator('canvas.canvas-page').first().screenshot({ path: info.outputPath('formatting-marks.png') });
  await select(input, 'cherry\nApple\nbanana\ndate');
  await button(page, 'Sort').click();
  await page.getByRole('dialog', { name: 'Sort Text' }).getByRole('button', { name: 'OK' }).click();
  await select(input, 'mixed case SENTENCE. second sentence here');
  await button(page, 'Change Case').click();
  await page.getByRole('menuitem', { name: 'Sentence case.' }).click();
  await select(input, 'accent');
  await button(page, 'Format Painter').click();
  const surface = await page.locator('.canvas-pages').boundingBox();
  const from = await caretAt(input, 'plain'), to = await caretAt(input, 'plain', 5);
  await page.mouse.move(surface.x + from.left + 1, surface.y + from.top + from.height / 2);
  await page.mouse.down(); await page.mouse.move(surface.x + to.left - 1, surface.y + to.top + to.height / 2, { steps: 4 }); await page.mouse.up();
  const expected = (await input.inputValue());
  expect(expected).toContain('Apple\nbanana\ncherry\ndate');
  expect(expected).toContain('Mixed case sentence. Second sentence here');
  await select(input, 'plain');
  await expect(page.getByRole('combobox', { name: 'Character style', includeHidden: true })).toHaveValue('Accent');
  const path = info.outputPath('home-editing.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  await reopenDocx(page, input, path, expected);
  await select(input, 'plain');
  await expect(page.getByRole('combobox', { name: 'Character style', includeHidden: true })).toHaveValue('Accent');
  await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('the Sort Text dialog fits a 320-pixel window', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const input = await newDocument(page, 'pear\nApple\nfig');
  await input.press('ControlOrMeta+a');
  await onTab(page, 'home');
  await button(page, 'Sort').click();
  const dialog = page.getByRole('dialog', { name: 'Sort Text' });
  await expect(dialog).toBeVisible();
  // Nothing in the sheet runs past its edge, so every choice and the OK button can be seen and reached.
  const outside = await dialog.evaluate(panel => {
    const box = panel.getBoundingClientRect();
    return [...panel.querySelectorAll('select, input, label, button')].filter(n => n.getClientRects().length)
      .filter(n => { const r = n.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).map(n => n.textContent.trim() || n.getAttribute('aria-label'));
  });
  expect(outside).toEqual([]);
  expect(await dialog.evaluate(panel => panel.scrollWidth <= panel.clientWidth)).toBe(true);
  await dialog.getByLabel('Descending').check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(input).toHaveValue('pear\nfig\nApple');
});
