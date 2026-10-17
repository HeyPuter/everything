import { showAllTools, onTab } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { reopenDocx } from './helpers/reopen-docx.js';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const reset = page => button(page, 'Clear direct paragraph formatting');
const size = page => page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true });
const style = page => page.getByRole('combobox', { name: 'Paragraph style', exact: true });
const spacing = page => page.getByRole('combobox', { name: 'Line spacing', exact: true });
// Space before lives on the Layout tab; its value is read while the Home tab stays in front.
const before = page => page.getByRole('spinbutton', { name: 'Space before paragraph (pt)', exact: true, includeHidden: true });
async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/clear-paragraph-formatting.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Clear direct paragraph formatting/); return input;
}
async function select(input, text, backward = false) {
  await input.evaluate((el, { text, backward }) => { const at = el.value.indexOf(text); if (at < 0) throw Error('Missing selection text'); el.setSelectionRange(at, at + text.length, backward ? 'backward' : 'forward'); el.dispatchEvent(new Event('select', { bubbles: true })); }, { text, backward });
}
async function download(page, info, name) { const event = page.waitForEvent('download'); await button(page, 'Download .docx').click(); const path = info.outputPath(name); await (await event).saveAs(path); return path; }
async function screenshot(page, info, index, name) { const png = await page.locator('canvas.canvas-page').nth(index).evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath(name), Buffer.from(png, 'base64')); }

test('restores paragraph inheritance, pagination and numbering while retaining text, then saves and reopens', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); const input = await fixture(page), text = await input.inputValue(), pages = await page.locator('canvas.canvas-page').count();
  await expect(reset(page).locator('svg')).toHaveAttribute('aria-hidden', 'true'); await select(input, 'Direct paragraph Á😀', true);
  const selected = await input.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]); await reset(page).focus(); await reset(page).press('Enter'); await expect(input).toBeFocused();
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual(selected);
  await expect(button(page, 'Align left')).toHaveAttribute('aria-pressed', 'true'); await expect(before(page)).toHaveValue('4'); await expect(spacing(page).locator('option:checked')).toHaveText('1.25×');
  await expect(page.getByRole('combobox', { name: 'Outline level', exact: true })).toHaveValue('2'); await expect(button(page, 'Start paragraph on new page')).toHaveAttribute('aria-pressed', 'false');
  await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true'); await expect(size(page)).toHaveValue('13');
  await button(page, 'Indents and tabs').click(); await expect(page.getByRole('spinbutton', { name: 'Left indent (in)', exact: true })).toHaveValue('0.15');
  await expect(page.getByRole('spinbutton', { name: 'Tab 1 position (in)', exact: true })).toHaveValue('1.5'); await expect(page.getByRole('combobox', { name: 'Tab 1 alignment', exact: true })).toHaveValue('center'); await expect(page.getByRole('combobox', { name: 'Tab 1 leader', exact: true })).toHaveValue('dot'); await button(page, 'Cancel').click();
  await button(page, 'Undo').click(); await expect(button(page, 'Align right')).toHaveAttribute('aria-pressed', 'true'); await button(page, 'Redo').click(); await button(page, 'Undo').click(); await expect(button(page, 'Undo')).toBeDisabled();
  await input.press('ControlOrMeta+a'); await reset(page).click(); await expect(input).toHaveValue(text); expect(await page.locator('canvas.canvas-page').count()).toBeLessThan(pages);
  await button(page, 'Undo').click(); expect(await page.locator('canvas.canvas-page').count()).toBe(pages); await expect(button(page, 'Undo')).toBeDisabled(); await button(page, 'Redo').click();
  for (const [text, numbered] of [['Style numbering returns', true], ['Direct numbering removed', false], ['Style numbering switches', true]]) { await select(input, text); await expect(button(page, 'Numbered list')).toHaveAttribute('aria-pressed', String(numbered)); }
  await select(input, 'Linked paragraph'); await onTab(page, 'insert'); await expect(button(page, 'Insert or edit link')).toHaveAttribute('aria-pressed', 'true'); await onTab(page, 'home');
  await select(input, 'Direct paragraph Á😀'); await page.locator('.canvas-host').evaluate(el => { el.scrollTop = 0; }); await page.screenshot({ path: info.outputPath('paragraph-reset-toolbar.png') }); await screenshot(page, info, 0, 'paragraph-reset-page.png'); await screenshot(page, info, 2, 'paragraph-reset-table.png');
  const saved = await download(page, info, 'clear-paragraph-formatting.docx'); await reopenDocx(page, input, saved, text); await select(input, 'Direct paragraph Á😀'); await expect(before(page)).toHaveValue('4'); await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true'); await expect(button(page, 'Undo')).toBeDisabled();
  await button(page, 'Edit paragraph style').click(); await page.getByRole('combobox', { name: 'Style alignment', exact: true }).selectOption('center'); await button(page, 'Apply').click(); await expect(button(page, 'Align center')).toHaveAttribute('aria-pressed', 'true'); expect(errors).toEqual([]);
});

test('resets new headings without removing heading styles or italic text', async ({ page }, info) => {
  await page.goto('/playground.html'); await showAllTools(page); await button(page, 'New').click(); const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('First Á😀\nSecond'); await input.press('ControlOrMeta+a'); await style(page).selectOption('Heading1'); await button(page, 'Italic').click();
  await button(page, 'Align right').click(); await spacing(page).selectOption('2'); await onTab(page, 'layout'); await before(page).fill('20'); await before(page).press('Tab'); await onTab(page, 'home'); await button(page, 'Numbered list').click(); await reset(page).click();
  await expect(style(page)).toHaveValue('Heading1'); await expect(size(page)).toHaveValue('20'); await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true'); await expect(button(page, 'Align left')).toHaveAttribute('aria-pressed', 'true'); await expect(button(page, 'Numbered list')).toHaveAttribute('aria-pressed', 'false'); await expect(before(page)).toHaveValue('12');
  const saved = await download(page, info, 'new-clear-paragraph-formatting.docx'); await reopenDocx(page, input, saved, 'First Á😀\nSecond'); await select(input, 'Second'); await expect(size(page)).toHaveValue('20'); await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true'); await expect(style(page)).toHaveValue('Heading1'); await screenshot(page, info, 0, 'new-paragraph-reset.png');
});

test('preserves empty paragraph mark formatting in text mode and after splitting', async ({ page }) => {
  const input = await fixture(page); await input.evaluate(el => { const at = el.value.indexOf('\n\n') + 1; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect(size(page)).toHaveValue('22'); await reset(page).click(); await expect(size(page)).toHaveValue('22'); await button(page, 'Indents and tabs').click(); await expect(page.getByRole('spinbutton', { name: 'Left indent (in)', exact: true })).toHaveValue('0.15'); await button(page, 'Cancel').click();
  await page.getByRole('checkbox', { name: 'Text mode', exact: true }).check(); await input.focus(); await page.keyboard.insertText('Empty restored'); await input.press('Enter'); await page.keyboard.insertText('Second'); await expect(size(page)).toHaveValue('22');
  await button(page, 'Undo').click(); await button(page, 'Undo').click(); await button(page, 'Undo').click(); await expect(size(page)).toHaveValue('22'); await button(page, 'Undo').click(); await expect(button(page, 'Undo')).toBeDisabled();
});

test('retains redo for style-only paragraphs and clears opaque direct properties once', async ({ page }) => {
  const input = await fixture(page); await select(input, 'Direct paragraph'); await reset(page).click(); await button(page, 'Undo').click();
  for (const text of ['Style-only paragraph', 'Inherited numbering']) { await select(input, text); await reset(page).click(); await expect(button(page, 'Redo')).toBeEnabled(); await expect(button(page, 'Undo')).toBeDisabled(); }
  await select(input, 'Opaque paragraph property'); await reset(page).click(); await expect(button(page, 'Undo')).toBeEnabled(); await reset(page).click(); await button(page, 'Undo').click(); await expect(button(page, 'Undo')).toBeDisabled();
});

test('rolls back inherited spacing that makes a repeated header too tall', async ({ page }) => {
  const input = await fixture(page), text = await input.inputValue(); await select(input, 'Reset paragraph header'); await style(page).selectOption('ParagraphResetHuge'); await expect(spacing(page)).toHaveValue('2');
  const pages = await page.locator('canvas.canvas-page').count(), selected = await input.evaluate(el => [el.selectionStart, el.selectionEnd]);
  await reset(page).click(); await expect(page.locator('.toast').last()).toContainText(/header|fit|height/i); await expect(input).toHaveValue(text); await expect(spacing(page)).toHaveValue('2'); await expect(style(page)).toHaveValue('ParagraphResetHuge'); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selected); expect(await page.locator('canvas.canvas-page').count()).toBe(pages);
  await button(page, 'Undo').click(); await expect(style(page)).toHaveValue('ParagraphResetChild'); await expect(button(page, 'Undo')).toBeDisabled();
});

test('excludes the ending paragraph and preserves composition and zoomed Unicode caret geometry', async ({ page }) => {
  const input = await fixture(page), original = await input.inputValue();
  await input.evaluate(el => { el.setSelectionRange(el.value.indexOf('Direct paragraph') + 2, el.value.indexOf('\n\n') + 1, 'backward'); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await reset(page).click(); await expect(button(page, 'Align left')).toHaveAttribute('aria-pressed', 'true');
  await input.evaluate(el => { const at = el.value.indexOf('\n\n') + 1; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await button(page, 'Indents and tabs').click(); await expect(page.getByRole('spinbutton', { name: 'Left indent (in)', exact: true })).toHaveValue('0'); await button(page, 'Cancel').click(); await button(page, 'Undo').click();
  const at = original.indexOf('Direct paragraph') + 2;
  await input.focus(); await input.evaluate((el, { original, at }) => {
    el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = original.slice(0, at) + 'Á😀' + original.slice(at); el.setSelectionRange(at + 4, at + 4); el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true, data: 'Á😀' }));
  }, { original, at });
  await reset(page).click(); await expect(input).toHaveValue(original.slice(0, at) + 'Á😀' + original.slice(at)); await expect(button(page, 'Align left')).toHaveAttribute('aria-pressed', 'true'); await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true');
  await button(page, 'Undo').click(); await expect(input).toHaveValue(original.slice(0, at) + 'Á😀' + original.slice(at)); await expect(button(page, 'Align right')).toHaveAttribute('aria-pressed', 'true'); await button(page, 'Undo').click(); await expect(input).toHaveValue(original); await button(page, 'Redo').click(); await button(page, 'Redo').click();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5'); await input.evaluate((el, at) => { el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, at); await input.press('ArrowRight');
  const caret = await input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height), at: el.selectionStart })), surface = await page.locator('.canvas-pages').boundingBox();
  await page.mouse.click(surface.x + caret.left + 1, surface.y + caret.top + caret.height / 2); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at); await input.press('ArrowRight'); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at + 2);
});
