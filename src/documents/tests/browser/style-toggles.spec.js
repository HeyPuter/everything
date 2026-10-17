import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

async function choose(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text: ' + text); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}
async function flags(page, bold, italic) {
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', String(bold));
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', String(italic));
}
async function painted(page, text, bold, italic) {
  const font = await page.evaluate(text => window.canvasFonts[text], text); expect(font, text).toBeTruthy();
  expect(/\b(700|bold)\b/.test(font), text + ' bold').toBe(bold); expect(/\bitalic\b/.test(font), text + ' italic').toBe(italic);
}

for (const on of [false, true]) test(`edits and reopens style inheritance with document defaults ${on ? 'on' : 'off'}`, async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.canvasFonts = {};
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { window.canvasFonts[text] = this.font; return fill.call(this, text, ...args); };
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles(`public/fixtures/style-toggles-${on ? 'on' : 'off'}.docx`);
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Default text/); const original = await input.inputValue();
  const pages = await page.locator('canvas.canvas-page').count(); expect(pages).toBeGreaterThan(1);
  for (const [text, bold, italic] of [['Default text', on, on], ['Paragraph on', true, true], ['Paragraph off', false, false], ['On with character off', !on, !on], ['Repeated toggle header', true, true], ['Off in table', false, false], ['Table off only', false, false]]) {
    await choose(input, text); await flags(page, bold, italic); await painted(page, text, bold, italic);
  }
  await choose(input, 'Default text'); await page.getByRole('button', { name: 'Bold', exact: true }).focus();
  const before = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL());
  await choose(input, 'Paragraph on'); await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click();
  await page.getByRole('combobox', { name: 'Style bold', exact: true }).selectOption('false'); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const text of ['Paragraph on', 'Repeated toggle header']) { await choose(input, text); await flags(page, false, true); await painted(page, text, false, true); }
  await choose(input, 'On with character off'); await page.getByRole('button', { name: 'Edit character style', exact: true }).click();
  const italic = page.getByRole('combobox', { name: 'Style italic', exact: true }); await expect(italic.locator('option[value="true"]')).toHaveText(`On (${on ? 'keep' : 'reverse'})`);
  await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('style-toggle-dialog.png'), animations: 'disabled' });
  await italic.selectOption('true'); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await choose(input, 'On with character off'); await flags(page, on, on); await painted(page, 'On with character off', on, on);
  await choose(input, 'Direct off'); await flags(page, false, false); const bold = page.getByRole('button', { name: 'Bold', exact: true }); await bold.focus(); await bold.press('Enter'); await flags(page, true, false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await choose(input, 'Direct off'); await flags(page, false, false); await page.getByRole('button', { name: 'Redo', exact: true }).click(); await choose(input, 'Direct off'); await flags(page, true, false);
  await input.evaluate(el => { const at = el.value.indexOf('\n\n') + 1; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }); await input.focus();
  await flags(page, on, !on); await page.keyboard.insertText('Temporary Á😀'); await flags(page, on, !on); await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(original);
  await choose(input, 'Default text'); await bold.focus(); const after = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL()); expect(after).not.toBe(before); writeFileSync(testInfo.outputPath('style-toggles.png'), Buffer.from(after.split(',')[1], 'base64'));
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const saved = testInfo.outputPath(`style-toggles-${on ? 'on' : 'off'}.docx`); await (await event).saveAs(saved);
  await reopenDocx(page, input, saved, original);
  for (const [text, b, i] of [['Paragraph on', false, true], ['Repeated toggle header', false, true], ['On with character off', on, on], ['Direct off', true, false]]) { await choose(input, text); await flags(page, b, i); await painted(page, text, b, i); }
  expect(await page.locator('canvas.canvas-page').count()).toBeLessThanOrEqual(pages); expect(errors).toEqual([]);
});

// Active w:cs (and w:rtl) declarations stopped forcing read-only mode on 2026-09-27 (docs/conformance.md,
// "Imported run-level RTL/CS editing enabled"): style-inherited ones open for editing and are retained.
test('opens active complex-script styles for editing and keeps their declarations', async ({ page }, testInfo) => {
  const parts = unzipSync(readFileSync('public/fixtures/style-toggles-off.docx'));
  const xml = strFromU8(parts['word/styles.xml']), modified = xml.replaceAll('<w:i/>', '<w:i/><w:cs/>'); expect(modified).not.toBe(xml); parts['word/styles.xml'] = strToU8(modified);
  await page.goto('/playground.html'); await showAllTools(page); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/);
  const previous = await input.elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'complex-script-styles.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
  await expect.poll(() => previous.evaluate(el => el.isConnected)).toBe(false);
  await expect(input).toHaveValue(/^Default text/); await expect(input).toHaveJSProperty('readOnly', false);
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const saved = testInfo.outputPath('complex-script-styles.docx'); await (await event).saveAs(saved);
  expect(unzipSync(readFileSync(saved))).toEqual(parts);
  await input.focus(); await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited '); const text = await input.inputValue();
  const edit = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const edited = testInfo.outputPath('complex-script-styles-edited.docx'); await (await edit).saveAs(edited);
  expect(strFromU8(unzipSync(readFileSync(edited))['word/styles.xml'])).toBe(modified);
  await reopenDocx(page, input, edited, text);
  await expect(input).toHaveJSProperty('readOnly', false);
});
