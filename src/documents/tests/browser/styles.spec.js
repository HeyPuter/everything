import { showAllTools, onTab } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

test('applies and edits inherited styles, keeps direct overrides, and reopens a validated style export', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html'); await showAllTools(page);
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/styles.docx');
  const input = page.getByRole('textbox', { name: 'Document text' });
  const style = page.getByRole('combobox', { name: 'Paragraph style', exact: true });
  const size = page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true });
  const edit = page.getByRole('button', { name: 'Edit paragraph style', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  const choose = text => input.evaluate((el, text) => { const start = el.value.indexOf(text); el.setSelectionRange(start, start); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
  await expect(input).toHaveValue(/^Style heading/); const text = await input.inputValue();
  await expect(style).toHaveValue('CanvasHeading'); await expect(size).toHaveValue('20');
  await expect(edit.locator('svg')).toHaveAttribute('aria-hidden', 'true'); await expect(edit).toHaveAttribute('title', 'Edit paragraph style');
  await style.selectOption('CanvasSubheading'); await expect(size).toHaveValue('16');
  await undo.click(); await expect(style).toHaveValue('CanvasHeading'); await redo.click();
  await choose('Body '); await edit.focus(); await edit.press('Space');
  await expect(page.getByRole('combobox', { name: 'Following paragraph style', exact: true })).toHaveValue('CanvasBody');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('style-dialog.png'), animations: 'disabled' });
  await page.getByRole('spinbutton', { name: 'Style font size (pt)', exact: true }).fill('14');
  await page.getByRole('combobox', { name: 'Style italic', exact: true }).selectOption('true');
  await page.getByRole('spinbutton', { name: 'Style space after (pt)', exact: true }).fill('8');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(input).toBeFocused(); await expect(size).toHaveValue('14');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const selection = await input.evaluate(el => [el.selectionStart, el.selectionEnd]);
  await undo.click(); await expect(size).toHaveValue('11'); await redo.click(); await expect(size).toHaveValue('14');
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selection);
  await edit.click(); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await undo.click(); await expect(size).toHaveValue('11'); await redo.click(); await expect(size).toHaveValue('14');
  await choose('Direct size'); await expect(size).toHaveValue('24');
  await expect((await onTab(page, 'layout')).getByRole('spinbutton', { name: 'Space after paragraph (pt)', exact: true })).toHaveValue('0');
  // CanvasList references a bullet level owned by the unrelated ListBullet
  // style. Native reference suppresses inherited numbering in this paragraph.
  await choose('Style list'); await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bulleted list', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await choose('emphasis'); await input.press('ArrowRight');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await choose('Style heading');
  await page.locator('canvas.canvas-page').first().screenshot({ path: testInfo.outputPath('styles-page.png'), animations: 'disabled' });
  await page.screenshot({ path: testInfo.outputPath('styles-toolbar.png'), animations: 'disabled' });
  await input.press('ControlOrMeta+a'); await expect(style).toHaveValue('__mixed');
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const saved = testInfo.outputPath('styles.docx'); await (await downloaded).saveAs(saved);
  const original = unzipSync(readFileSync('public/fixtures/styles.docx')), exported = unzipSync(readFileSync(saved));
  for (const [name, data] of Object.entries(original)) if (!['word/document.xml', 'word/styles.xml'].includes(name)) expect(Buffer.from(exported[name]).equals(Buffer.from(data)), name).toBe(true);
  await reopenDocx(page, input, saved, await input.inputValue());
  await expect(input).toHaveValue(text); await expect(undo).toBeDisabled(); await expect(style).toHaveValue('CanvasSubheading');
  await choose('Body '); await expect(size).toHaveValue('14'); expect(errors).toEqual([]);
});

test('creates a reusable style, edits it and follows the next style on Enter', async ({ page }, testInfo) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  const style = page.getByRole('combobox', { name: 'Paragraph style', exact: true });
  const size = page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true });
  await input.fill('Heading text'); await style.selectOption('Heading1'); await expect(size).toHaveValue('20');
  await input.press('ControlOrMeta+End'); await input.press('Enter'); await expect(style).toHaveValue('Normal');
  await page.keyboard.insertText('Body text');
  await page.getByRole('button', { name: 'New paragraph style', exact: true }).click();
  await page.getByRole('textbox', { name: 'Style name', exact: true }).fill('Review body');
  await page.getByRole('button', { name: 'Create style', exact: true }).click(); await expect(style).toHaveValue('CanvasStyle1');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(style).toHaveValue('Normal');
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(style).toHaveValue('CanvasStyle1');
  await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Style font size (pt)', exact: true }).fill('15');
  await page.getByRole('combobox', { name: 'Style underline', exact: true }).selectOption('single');
  await page.getByRole('combobox', { name: 'Style alignment', exact: true }).selectOption('center');
  await page.getByRole('combobox', { name: 'Following paragraph style', exact: true }).selectOption('Heading2');
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(size).toHaveValue('15');
  await input.press('ControlOrMeta+End'); await input.press('Enter'); await expect(style).toHaveValue('Heading2');
  await page.keyboard.insertText('Next heading'); await expect(size).toHaveValue('16');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Underline', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const saved = testInfo.outputPath('new-styles.docx'); await (await downloaded).saveAs(saved);
  await reopenDocx(page, input, saved, await input.inputValue());
  await expect(input).toHaveValue('Heading text\nBody text\nNext heading');
  await input.press('ArrowDown'); await expect(style).toHaveValue('CanvasStyle1'); await expect(size).toHaveValue('15');
  await page.locator('canvas.canvas-page').first().screenshot({ path: testInfo.outputPath('new-styles-page.png'), animations: 'disabled' });
});

test('keeps style actions visible while fields scroll in a short narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 600 }); await page.goto('/playground.html'); await showAllTools(page);
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/character-spacing.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Character spacing/);
  for (const kind of ['paragraph', 'character']) {
    await input.evaluate(el => { const start = el.value.indexOf('Character condensed'); el.setSelectionRange(start, start + 'Character condensed'.length); el.dispatchEvent(new Event('select', { bubbles: true })); });
    await page.getByRole('button', { name: `Edit ${kind} style`, exact: true }).click();
    const apply = page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }); await expect(apply).toBeInViewport();
    const last = page.getByRole('combobox', { name: kind === 'paragraph' ? 'Style page break before' : 'Style underline', exact: true }); await last.focus(); await expect(last).toBeInViewport(); await expect(apply).toBeInViewport();
    await page.getByRole('spinbutton', { name: 'Style character spacing (pt)', exact: true }).fill('1'); await expect(apply).toBeInViewport();
    await page.getByRole('dialog').screenshot({ path: testInfo.outputPath(`${kind}-style-narrow.png`), animations: 'disabled' }); await apply.click(); await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Character spacing', exact: true })).toHaveAttribute('title', 'Character spacing: ' + (kind === 'paragraph' ? '-0.25' : '1') + ' pt');
  }
});

// A style cannot be based on itself or on a style that inherits from it (§17.7.4.3 basedOn: the
// hierarchy has no cycles). The list offered them, and choosing one failed with a cyclic-inheritance error.
test('Based on offers neither the style being edited nor the styles based on it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html'); await showAllTools(page);
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/styles.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Style heading/);
  // Canvas Heading and Canvas List are based on Canvas Body; Canvas Subheading on Canvas Heading.
  await input.evaluate(el => { const start = el.value.indexOf('Body '); el.setSelectionRange(start, start); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect(page.getByRole('combobox', { name: 'Paragraph style', exact: true })).toHaveValue('CanvasBody');
  await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click();
  const basedOn = page.getByRole('combobox', { name: 'Based on style', exact: true });
  const offered = await basedOn.locator('option').evaluateAll(options => options.map(o => o.value));
  for (const id of ['CanvasBody', 'CanvasHeading', 'CanvasSubheading', 'CanvasList']) expect(offered).not.toContain(id);
  for (const id of ['', 'Normal', 'Heading1', 'Title']) expect(offered).toContain(id);
  await expect(basedOn).toHaveValue('Normal');
  await basedOn.selectOption('Heading1');
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  // The edited heading lists its new ancestors but still not its own descendant.
  await input.evaluate(el => { const start = el.value.indexOf('Style heading'); el.setSelectionRange(start, start); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click();
  const again = await basedOn.locator('option').evaluateAll(options => options.map(o => o.value));
  expect(again).toContain('CanvasBody'); expect(again).toContain('Heading1');
  expect(again).not.toContain('CanvasHeading'); expect(again).not.toContain('CanvasSubheading');
  expect(errors).toEqual([]);
});
