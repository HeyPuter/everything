import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools, expectTableCommandUnavailable, onTab } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { writeFileSync, readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

async function select(input, text, end) {
  await input.evaluate((el, { text, end }) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text'); el.setSelectionRange(at, end ? el.value.indexOf(end) + end.length : at); el.dispatchEvent(new Event('select', { bubbles: true })); }, { text, end });
}
async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/row-heights.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Row heights/); return input;
}
async function open(page) { await (await onTab(page, 'tableLayout')).getByRole('button', { name: 'Row height', exact: true }).click(); return page.getByRole('dialog', { name: 'Row height', exact: true }); }
async function height(page, rule, value) {
  const d = await open(page); await d.getByRole('combobox', { name: 'Row height setting' }).selectOption(rule);
  if (value !== undefined) await d.getByRole('spinbutton', { name: 'Minimum row height (pt)' }).fill(String(value));
  await d.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(d).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
}
async function download(page, info, name) { const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path; }
async function screenshot(page, info, index, name) { const png = await page.locator('canvas.canvas-page').nth(index).evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath(name), Buffer.from(png, 'base64')); }

test('edits inherited row heights with accessible controls and preserves merged and repeated rows through reopen', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page), text = await input.inputValue(), button = (await onTab(page, 'tableLayout')).getByRole('button', { name: 'Row height', exact: true }), undo = page.getByRole('button', { name: 'Undo', exact: true });
  // Entering a table shows the Table Layout tab without switching to it; bring it forward as a user would.
  await expectTableCommandUnavailable(page, 'Row height'); await select(input, 'Inherited minimum'); await onTab(page, 'tableLayout');
  await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await select(input, 'Inherited minimum'); await expect(button).toHaveAttribute('title', 'Row height: At least 48 pt'); const before = await input.evaluate(el => parseFloat(el.style.top));
  await button.focus(); await button.press('Enter'); let d = page.getByRole('dialog', { name: 'Row height', exact: true });
  await expect(d.getByRole('spinbutton', { name: 'Minimum row height (pt)' })).toHaveValue('48'); await d.getByRole('spinbutton', { name: 'Minimum row height (pt)' }).fill('72'); await d.getByRole('button', { name: 'Apply', exact: true }).press('Enter'); await expect(input).toBeFocused();
  expect(await input.evaluate(el => parseFloat(el.style.top))).toBeCloseTo(before + 16, 1);
  await undo.click(); await expect(button).toHaveAttribute('title', 'Row height: At least 48 pt'); expect(await input.evaluate(el => parseFloat(el.style.top))).toBeCloseTo(before, 1); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await select(input, 'Direct automatic'); await expect(button).toHaveAttribute('title', 'Row height: Automatic'); await height(page, 'inherit'); await expect(button).toHaveAttribute('title', 'Row height: At least 48 pt');
  await select(input, 'Omitted rule'); await expect(button).toHaveAttribute('title', 'Row height: At least 72 pt'); await height(page, 'auto');
  await select(input, 'Merged owner'); await expect(button).toHaveAttribute('title', 'Row height: Mixed'); await height(page, 'atLeast', 48);
  await select(input, 'Header height'); await height(page, 'atLeast', 42);
  await expect(input).toHaveValue(text); await screenshot(page, info, 0, 'row-heights-page.png'); await screenshot(page, info, 2, 'row-heights-continued.png');
  const saved = await download(page, info, 'row-heights.docx'); await reopenDocx(page, input, saved, text); await expect(undo).toBeDisabled();
  for (const [label, title] of [['Inherited minimum', 'At least 72 pt'], ['Direct automatic', 'At least 48 pt'], ['Omitted rule', 'Automatic'], ['Merged owner', 'At least 48 pt'], ['Header height', 'At least 42 pt']]) { await select(input, label); await onTab(page, 'tableLayout'); await expect(button).toHaveAttribute('title', 'Row height: ' + title); }
  expect(errors).toEqual([]);
});

test('authors minimum and automatic heights in a new table and retains Unicode text through undo and download', async ({ page }, info) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue('');
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click(); await page.getByRole('button', { name: 'Insert', exact: true }).click();
  for (const [i, text] of ['First Á😀', 'Second', 'Third', 'Fourth'].entries()) { if (i) await input.press('Tab'); await page.keyboard.insertText(text); }
  await select(input, 'First Á😀'); await height(page, 'atLeast', 60); await select(input, 'Third'); await height(page, 'atLeast', 30); await height(page, 'auto');
  const original = await input.inputValue(); await select(input, 'First Á😀'); await input.press('End'); await input.press('Enter'); await page.keyboard.insertText('Split row content'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue(original);
  const saved = await download(page, info, 'new-row-heights.docx'); await reopenDocx(page, input, saved, original); await select(input, 'First'); await expect((await onTab(page, 'tableLayout')).getByRole('button', { name: 'Row height', exact: true })).toHaveAttribute('title', 'Row height: At least 60 pt');
  await screenshot(page, info, 0, 'new-row-heights.png');
});

test('reflows tall minimum rows, preserves mixed no-ops and keeps zoomed Unicode carets on their text', async ({ page }) => {
  const input = await fixture(page), original = await input.inputValue(), undo = page.getByRole('button', { name: 'Undo', exact: true });
  await select(input, 'Inherited minimum', 'Direct automatic'); let d = await open(page); await expect(d.getByRole('combobox', { name: 'Row height setting' })).toHaveValue('mixed'); await d.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(undo).toBeDisabled();
  await select(input, 'Tall minimum'); const count = await page.locator('canvas.canvas-page').count(); await height(page, 'auto'); expect(await page.locator('canvas.canvas-page').count()).toBeLessThan(count); await undo.click(); expect(await page.locator('canvas.canvas-page').count()).toBe(count); await expect(input).toHaveValue(original);
  await select(input, 'Merged owner'); await height(page, 'atLeast', 72); await select(input, 'Á😀', 'Á😀');
  // Select the Unicode text inside the merged cell, not the document title.
  await input.evaluate(el => { const at = el.value.indexOf('Á😀', el.value.indexOf('Merged owner')); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5');
  const caret = await input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height), at: el.selectionStart }));
  const surface = await page.locator('.canvas-pages').boundingBox(); await page.mouse.click(surface.x + caret.left + 1, surface.y + caret.top + caret.height / 2); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at);
  await input.press('ArrowRight'); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at + 2); await page.keyboard.insertText('X'); await undo.click(); await expect(input).toHaveValue(original);
});

test('applies a repeated header row height taller than the page without repeating it, with one undo', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page), text = await input.inputValue(), count = await page.locator('canvas.canvas-page').count(), undo = page.getByRole('button', { name: 'Undo', exact: true });
  const title = async () => (await onTab(page, 'tableLayout')).getByRole('button', { name: 'Row height', exact: true }).getAttribute('title');
  await select(input, 'Header height'); const range = await input.evaluate(el => [el.selectionStart, el.selectionEnd]); let d = await open(page);
  // A header row too tall to leave its page room for the body is no longer refused: it is laid out once,
  // limited to a page, and the rows after it are not preceded by a repeated copy.
  await d.getByRole('spinbutton', { name: 'Minimum row height (pt)' }).fill('1584'); await d.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(d).toHaveCount(0); await expect(input).toBeFocused(); await expect(page.locator('.toast')).toHaveCount(0);
  await expect(input).toHaveValue(text); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(range);
  expect(await title()).toBe('Row height: At least 1584 pt'); await expect.poll(() => page.locator('canvas.canvas-page').count()).toBeGreaterThan(count); await expect(undo).toBeEnabled();
  // One undo restores the height, the pagination and the selection.
  await undo.click(); expect(await title()).toBe('Row height: At least 36 pt'); await expect.poll(() => page.locator('canvas.canvas-page').count()).toBe(count);
  await expect(undo).toBeDisabled(); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(range);
  d = await open(page); await d.getByRole('spinbutton', { name: 'Minimum row height (pt)' }).fill('42'); await d.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(d).toHaveCount(0); await expect(input).toBeFocused();
  expect(await title()).toBe('Row height: At least 42 pt');
  await undo.click(); await expect(undo).toBeDisabled(); expect(errors).toEqual([]);
});

test('keeps row-height controls reachable on a narrow screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 500 }); const input = await fixture(page); await select(input, 'Inherited minimum'); const d = await open(page);
  const size = d.getByRole('spinbutton', { name: 'Minimum row height (pt)' }), apply = d.getByRole('button', { name: 'Apply', exact: true }); await size.focus(); await expect(size).toBeInViewport(); await expect(apply).toBeInViewport(); expect(await d.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await d.screenshot({ path: info.outputPath('row-heights-narrow.png') }); await size.fill('48.05'); await apply.click(); await expect(d).toHaveCount(0); await expect(input).toBeFocused();
});

test('previews zero exact heights and malformed heights as read-only with the original available', async ({ page }) => {
  const input = await fixture(page), text = await input.inputValue();
  for (const attrs of ['w:hRule="exact" w:val="0"', 'w:hRule="atLeast" w:val="-1"']) {
    const parts = unzipSync(readFileSync('public/fixtures/row-heights.docx')); parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:trHeight w:val="1440"/>', `<w:trHeight ${attrs}/>`));
    await openReadOnlyPreview(page, { name: 'unsupported-height.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
      await expect(page.getByRole('button', { name: 'Download .docx', exact: true })).toBeEnabled();
  }
});
