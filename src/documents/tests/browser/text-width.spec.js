import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

async function choose(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text: ' + text); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}
async function width(page, value) {
  const button = page.getByRole('button', { name: 'Text width', exact: true }); await button.focus(); await button.press('Enter'); await page.getByRole('spinbutton', { name: 'Text width (%)', exact: true }).fill(String(value));
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
}
async function download(page, info, name) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path;
}

test('paints scaled glyphs with absolute spacing, edits inherited widths and preserves imported DOCX declarations', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.widthPaint = {};
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { const t = this.getTransform(); window.widthPaint[text] = { font: this.font, width: this.measureText(text).width, a: t.a, d: t.d }; return fill.call(this, text, ...args); };
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/text-width.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }), button = page.getByRole('button', { name: 'Text width', exact: true }); await expect(input).toHaveValue(/^Text width Á😀/); const text = await input.inputValue(); expect(await page.locator('canvas.canvas-page').count()).toBeGreaterThan(1); await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  // Script runs in the bundled Noto Sans use the face-dependent script size (script-font-size.js): its
  // metrics select the 60% size rounded to half points, applied to both axes (scaleX equals scaleY).
  const samples = await page.evaluate(() => [['Wide', 200, false], ['Compressed', 50, false], ['Wide super', 150, true], ['Narrow sub', 75, true], ['Percent width', 75, false], ['1.', 160, false]].map(([text, percent, script]) => {
    const p = window.widthPaint[text], size = parseFloat(/([\d.]+)px/.exec(p.font)[1]) * .75, scriptScale = script ? Math.round(2 * size * .6) / 2 / size : 1, expectedX = percent / 100 * scriptScale, c = document.createElement('canvas').getContext('2d'); c.font = p.font; c.fontKerning = 'none'; c.letterSpacing = '0px';
    const span = document.createElement('span'); span.style.cssText = 'position:absolute;white-space:pre;font:' + p.font + ';font-kerning:none;letter-spacing:' + (script ? 4 / 3 / expectedX : 0) + 'px;transform:scaleX(' + expectedX + ')'; span.textContent = text; document.body.append(span); const cssWidth = span.getBoundingClientRect().width; span.remove();
    return { text, ...p, script, scriptScale, expectedX, plain: c.measureText(text).width, cssWidth, baseScale: Object.entries(window.widthPaint).find(([text]) => text.startsWith('Text width '))[1].a };
  }));
  for (const p of samples) {
    const scaleX = p.a / p.baseScale; expect(scaleX, p.text).toBeCloseTo(p.expectedX, 5); expect(p.d / p.baseScale).toBeCloseTo(p.scriptScale, 5);
    expect((p.width - p.plain) * scaleX, p.text + ' spacing').toBeCloseTo(p.script ? [...p.text].length * 4 / 3 : 0, 3); expect(p.width * scaleX, p.text + ' CSS width').toBeCloseTo(p.cssWidth, 1);
  }
  for (const [text, value] of [['Wide', 200], ['Compressed', 50], ['Paragraph wide', 125], ['Character compressed', 75], ['Explicit normal', 100], ['Missing value reset', 100], ['Wide header', 150]]) { await choose(input, text); await expect(button).toHaveAttribute('title', `Text width: ${value}%`); }
  await choose(input, 'Wide'); await width(page, 175); await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toHaveValue('12'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Text width: 200%'); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await choose(input, 'Paragraph wide'); await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Style text width (%)', exact: true }).fill('150'); await expect(page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true })).toBeInViewport(); await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('text-width-style.png'), animations: 'disabled' }); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await choose(input, 'Character compressed'); await page.getByRole('button', { name: 'Edit character style', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Style text width (%)', exact: true }).fill(''); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await choose(input, 'Character compressed'); await expect(button).toHaveAttribute('title', 'Text width: 150%');
  await input.evaluate(el => { const at = el.value.indexOf('\n\n') + 1; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }); await input.focus(); await page.keyboard.insertText('Temporary Á😀'); await expect(button).toHaveAttribute('title', 'Text width: 150%'); await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(text);
  const saved = await download(page, testInfo, 'text-width.docx'); await reopenDocx(page, input, saved, text);
  for (const [text, value] of [['Wide', 175], ['Paragraph wide', 150], ['Character compressed', 150], ['Explicit normal', 100], ['Missing value reset', 100], ['Wide header', 150]]) { await choose(input, text); await expect(button).toHaveAttribute('title', `Text width: ${value}%`); }
  await button.focus(); const png = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(testInfo.outputPath('text-width.png'), Buffer.from(png, 'base64')); expect(errors).toEqual([]);
});

test('authors text widths, normal resets and future typing with mixed selections and keyboard controls', async ({ page }, testInfo) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }), button = page.getByRole('button', { name: 'Text width', exact: true }); await expect(input).toHaveValue('');
  await input.fill('Wide text\nNarrow text\nNormal text\n'); await choose(input, 'Wide text'); await width(page, 150); await choose(input, 'Narrow text'); await width(page, 75); await choose(input, 'Normal text'); await width(page, 200); await width(page, 100);
  await choose(input, 'Wide text\nNarrow text'); await expect(button).toHaveAttribute('title', 'Text width: Mixed'); await button.click(); await expect(page.getByText(/selection has mixed text widths/)).toBeVisible(); const amount = page.getByRole('spinbutton', { name: 'Text width (%)', exact: true });
  for (const [value, validity] of [['0', 'rangeUnderflow'], ['601', 'rangeOverflow'], ['100.5', 'stepMismatch']]) { await amount.fill(value); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(1); expect(await amount.evaluate((el, key) => el.validity[key], validity)).toBe(true); }
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await input.focus(); await input.press('ControlOrMeta+End'); await width(page, 125); await page.keyboard.insertText('Width typing'); const text = await input.inputValue(), saved = await download(page, testInfo, 'new-text-width.docx'); await reopenDocx(page, input, saved, text);
  for (const [text, value] of [['Wide text', 150], ['Narrow text', 75], ['Normal text', 100], ['Width typing', 125]]) { await choose(input, text); await expect(button).toHaveAttribute('title', `Text width: ${value}%`); }
});

test('accepts oversized text width with undo while rejecting reversed advances', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/text-width.docx'); const input = page.getByRole('textbox', { name: 'Document text' }), button = page.getByRole('button', { name: 'Text width', exact: true }), font = page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true }); await expect(input).toHaveValue(/^Text width/); const before = await input.inputValue();
  await choose(input, 'Wide'); await font.fill('100'); await font.press('Enter'); await expect(font).toHaveValue('100'); await width(page, 600); await expect(button).toHaveAttribute('title', 'Text width: 600%'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Text width: 200%');
  await choose(input, 'Compressed'); await page.getByRole('button', { name: 'Character spacing', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Character spacing (pt)', exact: true }).fill('-0.5'); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await width(page, 1); await expect(page.getByText(/advance backwards/)).toBeVisible(); await expect(button).toHaveAttribute('title', 'Text width: 50%'); await expect(input).toHaveValue(before);
});

test('previews unsupported active zero width as read-only with the original available', async ({ page }) => {
  const parts = unzipSync(readFileSync('public/fixtures/text-width.docx')); parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:w w:val="200"/>', '<w:w w:val="0"/>'));
  await page.goto('/playground.html'); await showAllTools(page); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/); const before = await input.inputValue(); await openReadOnlyPreview(page, { name: 'zero-width.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
});

test('supports text width without requiring optional Canvas letter spacing for unspaced text', async ({ page }) => {
  await page.addInitScript(() => { delete CanvasRenderingContext2D.prototype.letterSpacing; window.widthScale = 1; const fill = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { if (text === 'Width only') window.widthScale = this.getTransform().a; return fill.call(this, text, ...args); }; });
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(''); await input.fill('Width only'); await choose(input, 'Width only'); await width(page, 200); expect(await page.evaluate(() => window.widthScale / devicePixelRatio)).toBeCloseTo(2); await expect(page.getByRole('button', { name: 'Text width', exact: true })).toHaveAttribute('title', 'Text width: 200%');
});
