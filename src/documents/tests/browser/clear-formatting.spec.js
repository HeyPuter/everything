import { showAllTools, onTab } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { reopenDocx } from './helpers/reopen-docx.js';

const reset = page => page.getByRole('button', { name: 'Clear All Formatting', exact: true });
const size = page => page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true });
const style = page => page.getByRole('combobox', { name: 'Character style', exact: true });
const undo = page => page.getByRole('button', { name: 'Undo', exact: true });
const redo = page => page.getByRole('button', { name: 'Redo', exact: true });
async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/clear-text-formatting.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Clear direct text formatting/); return input;
}
async function select(input, text, backward = false) {
  await input.evaluate((el, { text, backward }) => { const at = el.value.indexOf(text); if (at < 0) throw Error('Missing selection text'); el.setSelectionRange(at, at + text.length, backward ? 'backward' : 'forward'); el.dispatchEvent(new Event('select', { bubbles: true })); }, { text, backward });
}
async function download(page, info, name) { const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path; }
async function screenshot(page, info, index, name) { const png = await page.locator('canvas.canvas-page').nth(index).evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath(name), Buffer.from(png, 'base64')); }

test('clears direct formatting with inherited styles, selection and pagination intact, then saves and reopens the full fixture', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); const input = await fixture(page), text = await input.inputValue(), pages = await page.locator('canvas.canvas-page').count();
  await expect(reset(page).locator('svg')).toHaveAttribute('aria-hidden', 'true'); await select(input, 'reset Á😀', true); await expect(size(page)).toHaveValue('24');
  const selection = await input.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]); await reset(page).click(); await expect(input).toBeFocused(); await expect(size(page)).toHaveValue('14');
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual(selection); await expect(style(page)).toHaveValue('ResetCharacterChild');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await undo(page).click(); await expect(size(page)).toHaveValue('24'); await redo(page).click(); await undo(page).click(); await expect(undo(page)).toBeDisabled();
  await input.press('ControlOrMeta+a'); await reset(page).click(); await expect(input).toHaveValue(text); expect(await page.locator('canvas.canvas-page').count()).toBeLessThan(pages);
  await undo(page).click(); expect(await page.locator('canvas.canvas-page').count()).toBe(pages); await expect(undo(page)).toBeDisabled(); await redo(page).click();
  await select(input, 'Linked reset'); await expect(style(page)).toHaveValue('ResetCharacterChild'); await expect((await onTab(page, 'insert')).getByRole('button', { name: 'Insert or edit link', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await select(input, 'reset Á😀'); await page.locator('.canvas-host').evaluate(el => { el.scrollTop = 0; }); await page.screenshot({ path: info.outputPath('clear-formatting-toolbar.png') }); await screenshot(page, info, 0, 'clear-formatting-page.png'); await screenshot(page, info, 2, 'clear-formatting-table.png');
  const saved = await download(page, info, 'clear-text-formatting.docx'); await reopenDocx(page, input, saved, text); await select(input, 'reset Á😀'); await expect(size(page)).toHaveValue('14'); await expect(style(page)).toHaveValue('ResetCharacterChild'); await expect(undo(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Style font size (pt)', exact: true }).fill('18'); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(size(page)).toHaveValue('18'); expect(errors).toEqual([]);
});

test('uses the keyboard reset in a new document without removing heading and character styles', async ({ page }, info) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('First Á😀\nSecond'); await input.press('ControlOrMeta+a'); await page.getByRole('combobox', { name: 'Paragraph style', exact: true }).selectOption('Heading1'); await style(page).selectOption('Emphasis');
  await size(page).fill('28'); await size(page).press('Tab'); await page.getByRole('button', { name: 'Bold', exact: true }).click(); await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await input.press('Control+Space'); await expect(size(page)).toHaveValue('20'); await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(style(page)).toHaveValue('Emphasis');
  const saved = await download(page, info, 'new-clear-text-formatting.docx'); await reopenDocx(page, input, saved, 'First Á😀\nSecond'); await select(input, 'Second'); await expect(size(page)).toHaveValue('20'); await expect(style(page)).toHaveValue('Emphasis'); await screenshot(page, info, 0, 'new-clear-formatting.png');
});

test('preserves pending reset formatting across native composition and restores it on undo', async ({ page }) => {
  const input = await fixture(page), original = await input.inputValue(), at = original.indexOf('reset') + 2;
  await input.evaluate((el, at) => { el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, at);
  await expect(size(page)).toHaveValue('24'); await reset(page).click(); await expect(size(page)).toHaveValue('14'); await expect(undo(page)).toBeDisabled();
  await input.evaluate((el, { original, at }) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const value of ['A', 'Á😀']) { el.value = original.slice(0, at) + value + original.slice(at); el.setSelectionRange(at + value.length, at + value.length); el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true, data: value })); }
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'Á😀' }));
  }, { original, at });
  await expect(input).toHaveValue(original.slice(0, at) + 'Á😀' + original.slice(at)); await expect(size(page)).toHaveValue('14'); await undo(page).click(); await expect(input).toHaveValue(original); await expect(size(page)).toHaveValue('14'); await redo(page).click();
  await input.evaluate((el, at) => { el.setSelectionRange(at, at + 4); el.dispatchEvent(new Event('select', { bubbles: true })); }, at); await expect(size(page)).toHaveValue('14');
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5'); await input.press('ArrowLeft');
  const caret = await input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height), at: el.selectionStart })), surface = await page.locator('.canvas-pages').boundingBox();
  await page.mouse.click(surface.x + caret.left + 1, surface.y + caret.top + caret.height / 2); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at); await input.press('ArrowRight'); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at + 2);
});

test('resets empty paragraph marks and keeps the inherited formatting during text-mode editing and splitting', async ({ page }) => {
  const input = await fixture(page); await input.evaluate(el => { const at = el.value.indexOf('\n\n') + 1; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect(size(page)).toHaveValue('26'); await reset(page).click(); await expect(size(page)).toHaveValue('14'); await expect(style(page)).toHaveValue('ResetCharacterChild');
  await page.getByRole('checkbox', { name: 'Text mode', exact: true }).check(); await input.focus(); await page.keyboard.insertText('Empty restored'); await input.press('Enter'); await page.keyboard.insertText('Second'); await expect(size(page)).toHaveValue('14'); await expect(style(page)).toHaveValue('ResetCharacterChild');
  await undo(page).click(); await undo(page).click(); await undo(page).click(); await expect(size(page)).toHaveValue('14'); await undo(page).click(); await expect(size(page)).toHaveValue('26');
});

test('retains redo for style-only selections and permits clearing invisible direct declarations', async ({ page }) => {
  const input = await fixture(page); await select(input, 'reset Á😀'); await reset(page).click(); await undo(page).click(); await select(input, 'Style only'); await reset(page).click(); await expect(redo(page)).toBeEnabled(); await expect(undo(page)).toBeDisabled();
  await select(input, 'Language only'); await expect(size(page)).toHaveValue('12'); await reset(page).click(); await expect(size(page)).toHaveValue('12'); await expect(undo(page)).toBeEnabled(); await reset(page).click(); await undo(page).click(); await expect(undo(page)).toBeDisabled();
});

test('applies a reset that makes a repeated table header too tall to repeat, preserving selection and history', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page), text = await input.inputValue(); await select(input, 'Reset header label'); await style(page).selectOption('ResetHuge'); await expect(size(page)).toHaveValue('8');
  const pages = await page.locator('canvas.canvas-page').count(), selected = await input.evaluate(el => [el.selectionStart, el.selectionEnd]);
  // The header row no longer leaves its page room for the table body: it is laid out once, as an
  // ordinary row across pages, instead of the reset being refused.
  await reset(page).click(); await expect(size(page)).toHaveValue('200'); await expect(style(page)).toHaveValue('ResetHuge');
  await expect(page.locator('.toast')).toHaveCount(0); await expect(input).toHaveValue(text);
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selected);
  await expect.poll(() => page.locator('canvas.canvas-page').count()).toBeGreaterThan(pages);
  // One undo restores the direct size and the pagination, keeping the selection; the next removes the style.
  await undo(page).click(); await expect(size(page)).toHaveValue('8'); await expect(style(page)).toHaveValue('ResetHuge');
  await expect.poll(() => page.locator('canvas.canvas-page').count()).toBe(pages); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selected);
  await undo(page).click(); await expect(style(page)).toHaveValue(''); await expect(undo(page)).toBeDisabled();
  expect(errors).toEqual([]);
});
