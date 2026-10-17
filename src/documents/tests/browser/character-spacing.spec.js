import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

async function choose(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text: ' + text); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}
async function spacing(page, value) {
  const button = page.getByRole('button', { name: 'Character spacing', exact: true }); await button.focus(); await button.press('Enter'); await page.getByRole('spinbutton', { name: 'Character spacing (pt)', exact: true }).fill(String(value));
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
}
async function download(page, info, name) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path;
}

test('measures and paints expanded/condensed text, edits styles and preserves imported DOCX spacing', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.spacedPaint = {};
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { const t = this.getTransform(); window.spacedPaint[text] = { font: this.font, width: this.measureText(text).width, a: t.a, d: t.d }; return fill.call(this, text, ...args); };
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/character-spacing.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }), button = page.getByRole('button', { name: 'Character spacing', exact: true }); await expect(input).toHaveValue(/^Character spacing Á😀/); const text = await input.inputValue(); expect(await page.locator('canvas.canvas-page').count()).toBeGreaterThan(1);
  // Script runs in the bundled Noto Sans use the face-dependent script size (script-font-size.js): its
  // metrics select the 60% size rounded to half points, applied to both axes (scaleX equals scaleY).
  const samples = await page.evaluate(() => ['Expanded', 'Condensed', 'Spaced super', 'Spaced sub', '1.'].map(text => {
    const p = window.spacedPaint[text], c = document.createElement('canvas').getContext('2d'); c.font = p.font; c.fontKerning = 'none'; c.letterSpacing = '0px';
    // Use independent fixture values: Chromium's getter can return '' after save(),
    // although the saved spacing still affects measureText/fillText correctly.
    const points = text === 'Expanded' ? 2 : text === 'Condensed' ? -.5 : 1, size = parseFloat(/([\d.]+)px/.exec(p.font)[1]) * .75, scriptScale = text.startsWith('Spaced ') ? Math.round(2 * size * .6) / 2 / size : 1;
    const span = document.createElement('span'); span.style.cssText = 'position:absolute;white-space:pre;font:' + p.font + ';font-kerning:none;letter-spacing:' + points * 4 / 3 / scriptScale + 'px'; span.textContent = text; document.body.append(span); const cssWidth = span.getBoundingClientRect().width; span.remove();
    return { text, ...p, scriptScale, plain: c.measureText(text).width, cssWidth, baseScale: Object.entries(window.spacedPaint).find(([text]) => text.startsWith('Character spacing '))[1].a };
  }));
  for (const p of samples) {
    const points = p.text === 'Expanded' ? 2 : p.text === 'Condensed' ? -.5 : 1, scaleX = p.a / p.baseScale;
    expect((p.width - p.plain) * scaleX, p.text).toBeCloseTo([...p.text].length * points * 4 / 3, 3); expect(p.width, p.text + ' CSS reference').toBeCloseTo(p.cssWidth, 1); expect(p.d / p.baseScale).toBeCloseTo(p.scriptScale, 5); expect(p.a / p.baseScale).toBeCloseTo(p.scriptScale, 5);
  }
  for (const [text, value] of [['Expanded', 2], ['Condensed', -.5], ['Paragraph expanded', 1.25], ['Character condensed', -.25], ['Explicit zero', 0], ['Spaced header', 2]]) { await choose(input, text); await expect(button).toHaveAttribute('title', `Character spacing: ${value} pt`); }
  await choose(input, 'Expanded'); await spacing(page, 1.75); await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toHaveValue('12'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Character spacing: 2 pt'); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await choose(input, 'Paragraph expanded'); await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Style character spacing (pt)', exact: true }).fill('3'); await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('character-spacing-style.png'), animations: 'disabled' }); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await choose(input, 'Character condensed'); await page.getByRole('button', { name: 'Edit character style', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Style character spacing (pt)', exact: true }).fill(''); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await choose(input, 'Character condensed'); await expect(button).toHaveAttribute('title', 'Character spacing: 3 pt');
  await input.evaluate(el => { const at = el.value.indexOf('\n\n') + 1; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }); await input.focus(); await page.keyboard.insertText('Temporary Á😀'); await expect(button).toHaveAttribute('title', 'Character spacing: 1.25 pt'); await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(text);
  const saved = await download(page, testInfo, 'character-spacing.docx'); await reopenDocx(page, input, saved, text);
  for (const [text, value] of [['Expanded', 1.75], ['Paragraph expanded', 3], ['Character condensed', 3], ['Explicit zero', 0], ['Spaced header', 2]]) { await choose(input, text); await expect(button).toHaveAttribute('title', `Character spacing: ${value} pt`); }
  await button.focus(); const png = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(testInfo.outputPath('character-spacing.png'), Buffer.from(png, 'base64')); expect(errors).toEqual([]);
});

test('authors spacing, explicit zero and future typing with mixed selections and keyboard controls', async ({ page }, testInfo) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }), button = page.getByRole('button', { name: 'Character spacing', exact: true }); await expect(input).toHaveValue('');
  await input.fill('Expanded text\nCondensed text\nPlain text\n'); await choose(input, 'Expanded text'); await spacing(page, 1.5); await choose(input, 'Condensed text'); await spacing(page, -.5); await choose(input, 'Plain text'); await spacing(page, 1); await spacing(page, 0);
  await choose(input, 'Expanded text\nCondensed text'); await expect(button).toHaveAttribute('title', 'Character spacing: Mixed'); await button.click(); await expect(page.getByText(/selection has mixed spacing/)).toBeVisible(); const amount = page.getByRole('spinbutton', { name: 'Character spacing (pt)', exact: true }); await amount.fill('0.025'); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(1); expect(await amount.evaluate(el => el.validity.stepMismatch)).toBe(true); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await input.focus(); await input.press('ControlOrMeta+End'); await spacing(page, .75); await page.keyboard.insertText('Spaced typing'); const text = await input.inputValue(), saved = await download(page, testInfo, 'new-character-spacing.docx'); await reopenDocx(page, input, saved, text);
  for (const [text, value] of [['Expanded text', 1.5], ['Condensed text', -.5], ['Plain text', 0], ['Spaced typing', .75]]) { await choose(input, text); await expect(button).toHaveAttribute('title', `Character spacing: ${value} pt`); }
});

test('accepts oversized spacing with undo while rejecting reversed advances', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/character-spacing.docx'); const input = page.getByRole('textbox', { name: 'Document text' }), button = page.getByRole('button', { name: 'Character spacing', exact: true }); await expect(input).toHaveValue(/^Character spacing/); const before = await input.inputValue();
  await choose(input, 'Expanded'); await spacing(page, -20); await expect(page.getByText(/advance backwards/)).toBeVisible(); await expect(button).toHaveAttribute('title', 'Character spacing: 2 pt'); await spacing(page, 1584); await expect(button).toHaveAttribute('title', 'Character spacing: 1584 pt'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Character spacing: 2 pt'); await expect(input).toHaveValue(before);
});

test('previews active fitText as read-only with the original available', async ({ page }) => {
  const parts = unzipSync(readFileSync('public/fixtures/character-spacing.docx')); parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:spacing w:val="40"/>', '<w:spacing w:val="40"/><w:fitText w:val="100"/>'));
  await page.goto('/playground.html'); await showAllTools(page); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/); const before = await input.inputValue(); await openReadOnlyPreview(page, { name: 'fitted-run.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
});

test('previews documents when Canvas character spacing is unavailable', async ({ page }) => {
  await page.addInitScript(() => { delete CanvasRenderingContext2D.prototype.letterSpacing; });
  await page.goto('/playground.html'); await showAllTools(page); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/); const before = await input.inputValue(); await openReadOnlyPreview(page, 'public/fixtures/character-spacing.docx');
});
