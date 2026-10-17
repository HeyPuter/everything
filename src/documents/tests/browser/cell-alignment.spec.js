import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools, expectTableCommandUnavailable, onTab } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

async function select(input, first, last = first, caret = false) {
  await input.evaluate((el, { first, last, caret }) => {
    const at = el.value.indexOf(first), end = el.value.indexOf(last) + last.length;
    if (at < 0 || end < last.length) throw new Error('Missing cell text');
    el.setSelectionRange(at, caret ? at : end); el.dispatchEvent(new Event('select', { bubbles: true }));
  }, { first, last, caret });
}
async function open(page) {
  const button = (await onTab(page, 'tableLayout')).getByRole('button', { name: 'Cell alignment', exact: true }); await button.focus(); await button.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Cell alignment', exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
async function align(page, value) {
  const dialog = await open(page); await dialog.getByRole('combobox', { name: 'Cell vertical alignment', exact: true }).selectOption(value);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
}
async function download(page, testInfo, name) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = testInfo.outputPath(name); await (await event).saveAs(path); return path;
}
async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/cell-alignment.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Cell alignment/); return input;
}

test('edits inherited and merged cell alignment, repeats headers and preserves its independent DOCX', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const input = await fixture(page), text = await input.inputValue(), count = await page.locator('canvas.canvas-page').count();
  await expectTableCommandUnavailable(page, 'Cell alignment'); await select(input, 'Inherited center');
  const button = (await onTab(page, 'tableLayout')).getByRole('button', { name: 'Cell alignment', exact: true }); await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await select(input, 'Inherited center'); await expect(button).toHaveAttribute('title', 'Cell alignment: Center');
  const before = await input.evaluate(el => parseFloat(el.style.top)); await align(page, 'bottom');
  expect(await input.evaluate(el => parseFloat(el.style.top))).toBeGreaterThan(before + 10);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Cell alignment: Center');
  expect(await input.evaluate(el => parseFloat(el.style.top))).toBeCloseTo(before, 2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Cell alignment: Bottom');
  await select(input, 'Direct bottom'); await align(page, 'inherit'); await expect(button).toHaveAttribute('title', 'Cell alignment: Center');
  await select(input, 'Vertical center'); await align(page, 'bottom');
  await select(input, 'Header center'); await align(page, 'bottom');
  await expect(input).toHaveValue(text); expect(await page.locator('canvas.canvas-page').count()).toBe(count);
  const saved = await download(page, testInfo, 'cell-alignment.docx'); await reopenDocx(page, input, saved, text);
  for (const [label, alignment] of [['Inherited center', 'Bottom'], ['Direct bottom', 'Center'], ['Vertical center', 'Bottom'], ['Header center', 'Bottom']]) {
    // Reopening leaves the contextual Table Layout tab unselected, as entering a table does.
    await select(input, label); await onTab(page, 'tableLayout'); await expect(button).toHaveAttribute('title', 'Cell alignment: ' + alignment);
  }
  const dialog = await open(page); await page.screenshot({ path: testInfo.outputPath('cell-alignment-dialog.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0); await select(input, 'Tail');
  for (const index of [0, 1, 3]) {
    const png = await page.locator('canvas.canvas-page').nth(index).evaluate(c => c.toDataURL().split(',')[1]);
    writeFileSync(testInfo.outputPath(`cell-alignment-page-${index + 1}.png`), Buffer.from(png, 'base64'));
  }
  expect(errors).toEqual([]);
});

test('authors top, center and bottom cells and keeps new-document exports editable', async ({ page }, testInfo) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue('');
  await expectTableCommandUnavailable(page, 'Cell alignment');
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByLabel('Table rows', { exact: true }).fill('1'); await page.getByLabel('Table columns', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  for (const [index, label] of ['New top', 'New center', 'New bottom'].entries()) { if (index) await input.press('Tab'); await page.keyboard.insertText(label); }
  await select(input, 'New top'); await align(page, 'bottom'); await align(page, 'top');
  await select(input, 'New center'); await align(page, 'center'); await select(input, 'New bottom'); await align(page, 'bottom');
  const text = await input.inputValue(), saved = await download(page, testInfo, 'new-cell-alignment.docx'); await reopenDocx(page, input, saved, text);
  await select(input, 'New center'); await expect((await onTab(page, 'tableLayout')).getByRole('button', { name: 'Cell alignment', exact: true })).toHaveAttribute('title', 'Cell alignment: Center');
});

test('handles mixed selections, keyboard no-op dismissal, zoomed carets and text editing in aligned cells', async ({ page }) => {
  const input = await fixture(page), original = await input.inputValue();
  await select(input, 'Inherited center', 'Direct bottom'); const dialog = await open(page);
  await expect(dialog.getByRole('combobox', { name: 'Cell vertical alignment', exact: true })).toHaveValue('mixed');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(input).toBeFocused();
  await align(page, 'bottom'); await expect((await onTab(page, 'tableLayout')).getByRole('button', { name: 'Cell alignment', exact: true })).toHaveAttribute('title', 'Cell alignment: Bottom');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect((await onTab(page, 'tableLayout')).getByRole('button', { name: 'Cell alignment', exact: true })).toHaveAttribute('title', 'Cell alignment: Mixed');
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5');
  await select(input, 'Direct bottom', 'Direct bottom', true); await input.focus();
  const position = await input.evaluate(el => { const c = document.querySelector('canvas.canvas-page').getBoundingClientRect(), r = el.getBoundingClientRect(); return { x: r.left - c.left, y: r.top - c.top }; });
  await page.locator('canvas.canvas-page').first().click({ position: { x: position.x + 1, y: position.y + 2 } });
  expect(await input.evaluate(el => el.selectionStart)).toBe(original.indexOf('Direct bottom'));
  await page.keyboard.insertText('Edited '); await expect(input).toHaveValue(/Edited Direct bottom/);
  await expect((await onTab(page, 'tableLayout')).getByRole('button', { name: 'Cell alignment', exact: true })).toHaveAttribute('title', 'Cell alignment: Bottom');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue(original);
});

test('previews unsupported alignment as read-only with the original available', async ({ page }) => {
  const input = await fixture(page), before = await input.inputValue();
  const parts = unzipSync(readFileSync('public/fixtures/cell-alignment.docx'));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:vAlign w:val="top"/>', '<w:vAlign w:val="invalid"/>'));
  await openReadOnlyPreview(page, { name: 'unsupported-alignment.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });

  await expect(page.getByRole('button', { name: 'Download .docx', exact: true })).toBeEnabled();
});
