import { showAllTools, onTab } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';

test('edits imported cells with styles, cell navigation and pagination, then saves and reopens', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/tables.docx');
  const input = page.getByRole('textbox', { name: 'Document text' });
  const actions = page.getByRole('combobox', { name: 'Table actions', exact: true });
  const select = (text, delta = 0, length = text.length) => input.evaluate((el, { text, delta, length }) => { const start = el.value.indexOf(text) + delta; el.setSelectionRange(start, start + length); el.dispatchEvent(new Event('select', { bubbles: true })); }, { text, delta, length });
  await expect(input).toHaveValue(/^A table with editable cells/); await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
  await showAllTools(page);
  await page.getByRole('combobox', { name: 'Zoom' }).selectOption('0.5');
  // Target the leading caret from current font metrics. The old hard-coded
  // pixel falls inside the D on installed Windows fonts, even on unchanged main.
  const detailsPoint = await page.evaluate(async bytes => {
    const {DocxPackage}=await import('/src/engine/docx.js'),{layoutDocument}=await import('/src/engine/layout.js'),{pageGeometry}=await import('/src/engine/page-settings.js'),{loadCanvasFonts,measureCanvasText}=await import('/src/engine/canvas-text.js');
    const p=await DocxPackage.open(new Uint8Array(bytes));await loadCanvasFonts(p);
    const ctx=document.createElement('canvas').getContext('2d');
    const layout=layoutDocument(p.paragraphs,(t,s)=>measureCanvasText(ctx,t,s),pageGeometry(p.pageSettings),p.numbering,p.tables);
    const line=layout.lines.find(l=>l.fragments.some(f=>f.text==='Details'));
    return {x:(line.fragments.find(f=>f.text==='Details').x+.1)*.5,y:(line.baseline-2)*.5};
  },[...readFileSync('public/fixtures/tables.docx')]);
  await page.locator('canvas.canvas-page').first().click({ position: detailsPoint });
  expect(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionStart + 7))).toBe('Details');
  await page.getByRole('combobox', { name: 'Zoom' }).selectOption('1');
  await select('Product', 0, 0); await expect(actions).toBeEnabled();
  // Tab selects the next cell's contents, as in Word; Backspace at the start of a cell then leaves the cells as they are.
  await input.press('Tab'); expect(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('Details');
  await input.press('ArrowLeft');
  const before = await input.inputValue(); await input.press('Backspace'); await expect(input).toHaveValue(before);
  await input.press('Shift+Tab'); expect(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionStart + 7))).toBe('Product');
  await select('Alpha', 5, 0); await page.keyboard.insertText(' revised');
  await select('Second paragraph'); await (await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true }).click();
  await input.press('ArrowRight'); await input.press('Enter'); await page.keyboard.insertText('Added paragraph');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await select('Added paragraph'); await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await select('Short cell', 0, 0); await input.press('ArrowDown');
  expect(await input.evaluate(el => el.value.slice(el.selectionStart))).not.toMatch(/^Text inside/);
  await select('Text inside a tall row.');
  const keepRow = (await onTab(page, 'tableLayout')).getByRole('button', { name: 'Keep table row together', exact: true });
  await expect(keepRow).toHaveAttribute('aria-pressed', 'true'); await keepRow.click();
  await expect(keepRow).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(keepRow).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(keepRow).toHaveAttribute('aria-pressed', 'false');
  await select('Product'); await page.screenshot({ path: testInfo.outputPath('table-toolbar.png'), animations: 'disabled' });
  await page.locator('canvas.canvas-page').first().screenshot({ path: testInfo.outputPath('table-first-page.png'), animations: 'disabled' });
  await page.locator('canvas.canvas-page').nth(2).screenshot({ path: testInfo.outputPath('table-row-continuation.png'), animations: 'disabled' });
  const text = await input.inputValue(), download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const saved = testInfo.outputPath('tables.docx'); await (await download).saveAs(saved);
  const original = unzipSync(readFileSync('public/fixtures/tables.docx')), exported = unzipSync(readFileSync(saved));
  expectBodyEditParts(exported, original);
  await reopenDocx(page, input, saved, await input.inputValue()); await expect(input).toHaveValue(text);
  await select('Added paragraph'); await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('creates tables and changes rows and columns through accessible controls with undo and save/reopen', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  const insert = (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true });
  const actions = page.getByRole('combobox', { name: 'Table actions', exact: true });
  await expect(input).toHaveValue(''); await input.focus();
  await page.keyboard.insertText('BeforeAfter'); await input.evaluate(el => { el.setSelectionRange(6, 6); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect(insert.locator('svg')).toHaveAttribute('aria-hidden', 'true'); await expect(insert).toHaveAttribute('title', 'Insert table');
  await insert.focus(); await insert.press('Space'); await expect(page.getByRole('menu', { name: 'Insert table' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('insert-table-dialog.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(actions).toBeEnabled(); await expect(insert).toBeEnabled();
  await page.keyboard.insertText('One'); await input.press('Tab'); await page.keyboard.insertText('Two');
  await input.press('Tab'); await page.keyboard.insertText('Three'); await input.press('Tab'); await page.keyboard.insertText('Four');
  await input.press('Tab'); await page.keyboard.insertText('Five'); // Tab from last cell adds a row.
  await actions.selectOption('addColumn'); await page.keyboard.insertText('Added column');
  await actions.selectOption('column'); await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue(/Added column/); await actions.selectOption('addRow'); await page.keyboard.insertText('Last');
  const text = await input.inputValue();
  await actions.selectOption('row'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue(text);
  await actions.selectOption('table'); await expect(input).toHaveValue('Before\nAfter');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue(text);
  await page.screenshot({ path: testInfo.outputPath('new-table.png'), animations: 'disabled' });
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const saved = testInfo.outputPath('new-tables.docx'); await (await download).saveAs(saved);
  await reopenDocx(page, input, saved, await input.inputValue()); await expect(input).toHaveValue(text);
  expect(errors).toEqual([]);
});
