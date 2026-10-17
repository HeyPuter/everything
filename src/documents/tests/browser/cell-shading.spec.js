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
  const button = (await onTab(page, 'tableDesign')).getByRole('button', { name: 'Cell shading', exact: true }); await button.focus(); await button.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Cell shading', exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
async function shade(page, value) {
  const dialog = await open(page), special = ['auto', 'foreground', 'inherit'].includes(value);
  await dialog.getByRole('combobox', { name: 'Cell fill', exact: true }).selectOption(special ? value : 'color');
  if (!special) await dialog.getByLabel('RGB cell fill', { exact: true }).fill('#' + value);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
}
async function download(page, testInfo, name) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = testInfo.outputPath(name); await (await event).saveAs(path); return path;
}
async function fixture(page) {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/cell-shading.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Cell shading/); return input;
}
async function pixels(page, hex, index = 0) {
  return page.locator('canvas.canvas-page').nth(index).evaluate((canvas, hex) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, rgb = hex.match(/../g).map(v => parseInt(v, 16)); let count = 0;
    for (let i = 0; i < data.length; i += 4) if (rgb.every((v, j) => Math.abs(data[i + j] - v) <= 2)) count++;
    return count;
  }, hex);
}

test('edits themed fills, no-fill overrides, merged segments and repeated headers and reopens its independent DOCX', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const input = await fixture(page), text = await input.inputValue(), count = await page.locator('canvas.canvas-page').count();
  await expectTableCommandUnavailable(page, 'Cell shading'); await select(input, 'Inherited theme');
  const button = (await onTab(page, 'tableDesign')).getByRole('button', { name: 'Cell shading', exact: true }); await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  for (const hex of ['C2D69B', 'DDEEFF', '224466', 'CCAAEE', 'FFFF00', '55AA77']) expect(await pixels(page, hex), hex).toBeGreaterThan(100);
  for (const label of ['Atomic clear', 'Style no fill']) { await select(input, label); await expect(button).toHaveAttribute('title', 'Cell shading: No fill'); }
  await select(input, 'Nil inherited'); await expect(button).toHaveAttribute('title', 'Cell shading: #C2D69B');
  await select(input, 'Inherited theme'); await expect(button).toHaveAttribute('title', 'Cell shading: #C2D69B');
  const before = await input.evaluate(el => [el.style.top, el.style.left]); await shade(page, '224466'); expect(await input.evaluate(el => [el.style.top, el.style.left])).toEqual(before);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Cell shading: #C2D69B');
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Cell shading: #224466');
  await select(input, 'Direct blue'); await shade(page, 'inherit'); await expect(button).toHaveAttribute('title', 'Cell shading: #C2D69B');
  await select(input, 'No fill'); await shade(page, '55AA77');
  await select(input, 'Vertical theme'); await shade(page, 'CCAAEE');
  await select(input, 'Header theme'); await shade(page, '55AA77');
  await select(input, 'Tail', 'Tail', true); let repeats = 0;
  for (let index = 1; index < count; index++) if (await pixels(page, '55AA77', index) > 100) repeats++;
  expect(repeats).toBeGreaterThan(1); expect(await pixels(page, 'FFFF00')).toBeGreaterThan(100);
  await expect(input).toHaveValue(text); expect(await page.locator('canvas.canvas-page').count()).toBe(count);
  const saved = await download(page, testInfo, 'cell-shading.docx'); await reopenDocx(page, input, saved, text);
  for (const [label, value] of [['Inherited theme', '224466'], ['Direct blue', 'C2D69B'], ['No fill', '55AA77'], ['Vertical theme', 'CCAAEE'], ['Header theme', '55AA77']]) {
    await select(input, label); await onTab(page, 'tableDesign'); await expect(button).toHaveAttribute('title', 'Cell shading: #' + value);
  }
  const dialog = await open(page); await page.screenshot({ path: testInfo.outputPath('cell-shading-dialog.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0); await select(input, 'Tail', 'Tail', true);
  for (const index of [0, 1, count - 1]) {
    const png = await page.locator('canvas.canvas-page').nth(index).evaluate(c => c.toDataURL().split(',')[1]);
    writeFileSync(testInfo.outputPath(`cell-shading-page-${index + 1}.png`), Buffer.from(png, 'base64'));
  }
  expect(errors).toEqual([]);
});

test('authors RGB, explicit no-fill and automatic foreground shading in a new document', async ({ page }, testInfo) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue('');
  await expectTableCommandUnavailable(page, 'Cell shading');
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByLabel('Table rows', { exact: true }).fill('1'); await page.getByLabel('Table columns', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  for (const [index, label] of ['New blue', 'New clear', 'New automatic'].entries()) { if (index) await input.press('Tab'); await page.keyboard.insertText(label); }
  await select(input, 'New blue'); await shade(page, '224466');
  await select(input, 'New clear'); await shade(page, 'foreground'); await shade(page, 'auto');
  await select(input, 'New automatic'); await shade(page, 'foreground');
  const text = await input.inputValue(), saved = await download(page, testInfo, 'new-cell-shading.docx'); await reopenDocx(page, input, saved, text);
  for (const [label, value] of [['New blue', '#224466'], ['New clear', 'No fill'], ['New automatic', 'Automatic foreground']]) {
    await select(input, label); await expect((await onTab(page, 'tableDesign')).getByRole('button', { name: 'Cell shading', exact: true })).toHaveAttribute('title', 'Cell shading: ' + value);
  }
});

test('keeps mixed fills on dismissal, applies one fill across cells and preserves zoomed text editing', async ({ page }) => {
  const input = await fixture(page), text = await input.inputValue(); await select(input, 'Inherited theme', 'No fill');
  const dialog = await open(page); await expect(dialog.getByRole('combobox', { name: 'Cell fill', exact: true })).toHaveValue('mixed');
  await expect(dialog.getByLabel('RGB cell fill', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(input).toBeFocused();
  const button = (await onTab(page, 'tableDesign')).getByRole('button', { name: 'Cell shading', exact: true }); await expect(button).toHaveAttribute('title', 'Cell shading: Mixed');
  await shade(page, 'auto'); await expect(button).toHaveAttribute('title', 'Cell shading: No fill');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Cell shading: Mixed');
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5');
  await select(input, 'Inherited theme', 'Inherited theme', true); await shade(page, '224466');
  const position = await input.evaluate(el => { const c = document.querySelector('canvas.canvas-page').getBoundingClientRect(), r = el.getBoundingClientRect(); return { x: r.left - c.left, y: r.top - c.top }; });
  await page.locator('canvas.canvas-page').first().click({ position: { x: position.x + 1, y: position.y + 2 } });
  expect(await input.evaluate(el => el.selectionStart)).toBe(text.indexOf('Inherited theme'));
  await page.keyboard.insertText('Edited '); await expect(input).toHaveValue(/Edited Inherited theme/); await expect(button).toHaveAttribute('title', 'Cell shading: #224466');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue(text);
});

test('previews unsupported shading as read-only with the original available', async ({ page }) => {
  const input = await fixture(page), text = await input.inputValue(), parts = unzipSync(readFileSync('public/fixtures/cell-shading.docx'));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"/>', '<w:shd w:val="pct10" w:fill="DDEEFF"/>'));
  await openReadOnlyPreview(page, { name: 'unsupported-shading.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });

  await expect(page.getByRole('button', { name: 'Download .docx', exact: true })).toBeEnabled();
});
