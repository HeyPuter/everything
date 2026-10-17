import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

async function choose(input, text) {
  await input.evaluate((el, text) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text: ' + text); el.setSelectionRange(at, at + text.length); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
}
async function kerning(page, value) {
  const button = page.getByRole('button', { name: 'Kerning', exact: true }); await button.focus(); await button.press('Enter'); await page.getByRole('spinbutton', { name: 'Kerning from (pt)', exact: true }).fill(String(value));
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
}
async function download(page, info, name) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path;
}

test('uses explicit font kerning, compares stored sizes before script transforms, edits inheritance and saves/reopens DOCX', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.kernPaint = {};
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { const t = this.getTransform(); window.kernPaint[text] = { font: this.font, width: this.measureText(text).width, kerning: this.fontKerning, a: t.a, d: t.d }; return fill.call(this, text, ...args); };
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/kerning.docx');
  const input = page.getByRole('textbox', { name: 'Document text' }), button = page.getByRole('button', { name: 'Kerning', exact: true }); await expect(input).toHaveValue(/^Kerning Á😀/); const text = await input.inputValue(); await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  // Script runs in the bundled Noto Sans use the face-dependent script size (script-font-size.js): its
  // metrics select the 60% size rounded to half points, applied to both axes (scaleX equals scaleY).
  const samples = await page.evaluate(() => [['Enabled AVATAR', true], ['Disabled AVATAR', false], ['Below AVATAR', false], ['At AVATAR', true], ['Above AVATAR', true], ['Paragraph AVATAR', true], ['Character AVATAR', false], ['Child AVATAR', false], ['Direct zero AVATAR', false], ['Universal AVATAR', true], ['Super AVATAR', true], ['Sub AVATAR', true], ['Header AVATAR', true], ['Plain header', false]].map(([text, enabled]) => {
    const p = window.kernPaint[text], script = /^(Super|Sub) /.test(text), size = parseFloat(/([\d.]+)px/.exec(p.font)[1]) * .75, pitch = script ? 4 / 3 / (Math.round(2 * size * .6) / 2 / size * 1.5) : 0, c = document.createElement('canvas').getContext('2d'); c.font = p.font; c.letterSpacing = pitch + 'px'; c.fontKerning = 'none'; const off = c.measureText(text).width; c.fontKerning = 'normal'; const on = c.measureText(text).width;
    const span = document.createElement('span'); span.style.cssText = 'position:absolute;white-space:pre;font:' + p.font + ';font-kerning:' + (enabled ? 'normal' : 'none') + ';letter-spacing:' + pitch + 'px'; span.textContent = text; document.body.append(span); const css = span.getBoundingClientRect().width; span.remove();
    return { text, enabled, ...p, off, on, css };
  }));
  for (const p of samples) { expect(p.kerning, p.text).toBe(p.enabled ? 'normal' : 'none'); expect(p.width, p.text).toBeCloseTo(p.enabled ? p.on : p.off, 4); expect(p.width, p.text + ' CSS reference').toBeCloseTo(p.css, 1); if (p.text.includes('AVATAR')) expect(p.off - p.on, p.text + ' actual pair adjustment').toBeGreaterThan(.1); }
  for (const [text, value] of [['Enabled AVATAR', 12], ['Disabled AVATAR', 0], ['Below AVATAR', 14], ['Paragraph AVATAR', 12], ['Character AVATAR', 14], ['Child AVATAR', 0], ['Direct zero AVATAR', 0], ['Header AVATAR', 12]]) { await choose(input, text); await expect(button).toHaveAttribute('title', value ? `Kerning: from ${value} pt` : 'Kerning: Off'); }
  await choose(input, 'Below AVATAR'); const font = page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true }); await font.fill('14'); await font.press('Enter'); expect(await page.evaluate(() => window.kernPaint['Below AVATAR'].kerning)).toBe('normal'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await page.evaluate(() => window.kernPaint['Below AVATAR'].kerning)).toBe('none');
  await choose(input, 'Enabled AVATAR'); const selection = await input.evaluate(el => [el.selectionStart, el.selectionEnd]); await kerning(page, 14); expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selection); await expect(font).toHaveValue('12'); expect(await page.evaluate(() => window.kernPaint['Enabled AVATAR'].kerning)).toBe('none'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(button).toHaveAttribute('title', 'Kerning: from 12 pt'); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await choose(input, 'Paragraph AVATAR'); await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Style kerning from (pt)', exact: true }).fill('10'); await expect(page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true })).toBeInViewport(); await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('kerning-style.png'), animations: 'disabled' }); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await choose(input, 'Character AVATAR'); await page.getByRole('button', { name: 'Edit character style', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Style kerning from (pt)', exact: true }).fill(''); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(button).toHaveAttribute('title', 'Kerning: from 10 pt');
  const saved = await download(page, testInfo, 'kerning.docx'); await reopenDocx(page, input, saved, text); await choose(input, 'Enabled AVATAR'); await expect(button).toHaveAttribute('title', 'Kerning: from 14 pt'); await choose(input, 'Character AVATAR'); await expect(button).toHaveAttribute('title', 'Kerning: from 10 pt'); await choose(input, 'Direct zero AVATAR'); await expect(button).toHaveAttribute('title', 'Kerning: Off');
  await button.focus(); const png = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(testInfo.outputPath('kerning.png'), Buffer.from(png, 'base64')); expect(errors).toEqual([]);
});

test('authors thresholds, zero resets and future typing with mixed selection and input validation', async ({ page }, testInfo) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }), button = page.getByRole('button', { name: 'Kerning', exact: true }); await expect(input).toHaveValue(''); await input.fill('Enabled AVATAR\nDisabled AVATAR\n');
  await choose(input, 'Enabled AVATAR'); await kerning(page, 12); await choose(input, 'Disabled AVATAR'); await kerning(page, 12); await kerning(page, 0); await choose(input, 'Enabled AVATAR\nDisabled AVATAR'); await expect(button).toHaveAttribute('title', 'Kerning: Mixed'); await button.click(); await expect(page.getByText(/selection has mixed kerning thresholds/)).toBeVisible(); const amount = page.getByRole('spinbutton', { name: 'Kerning from (pt)', exact: true });
  for (const [value, validity] of [['-0.5', 'rangeUnderflow'], ['1639', 'rangeOverflow'], ['12.25', 'stepMismatch']]) { await amount.fill(value); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(1); expect(await amount.evaluate((el, key) => el.validity[key], validity)).toBe(true); }
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await input.focus(); await input.press('ControlOrMeta+End'); await kerning(page, 14); await page.keyboard.insertText('Future AVATAR'); const text = await input.inputValue(), saved = await download(page, testInfo, 'new-kerning.docx'); await reopenDocx(page, input, saved, text);
  for (const [text, value] of [['Enabled AVATAR', 12], ['Disabled AVATAR', 0], ['Future AVATAR', 14]]) { await choose(input, text); await expect(button).toHaveAttribute('title', value ? `Kerning: from ${value} pt` : 'Kerning: Off'); }
});

test('default unkerned text and color-only edits retain matching canvas widths and caret hits', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(''); await input.fill('AVATAR');
  const result = await page.evaluate(async () => {
    const { layoutDocument, caretRect, hitTest, selectionRects } = await import('/src/engine/layout.js'), { paragraph } = await import('/src/engine/model.js'), { fontMetrics } = await import('/src/engine/font-metrics.js'), { setCanvasTextStyle } = await import('/src/engine/canvas-text.js'); const c = document.createElement('canvas').getContext('2d');
    const measure = (text, style) => { setCanvasTextStyle(c, style); return { width: c.measureText(text).width, ...fontMetrics(style) }; };
    const off = layoutDocument([paragraph('AVATAR')], measure), on = layoutDocument([paragraph('', { runs: [{ text: 'AVATAR', kerning: 12 }] })], measure), split = layoutDocument([paragraph('', { runs: [{ text: 'A', kerning: 10, color: 'FF0000' }, { text: 'VATAR', kerning: 12, color: '0000FF' }] })], measure); const caret = caretRect(split, 3);
    return { off: off.lines[0].width, on: on.lines[0].width, split: split.lines[0].width, fragments: split.lines[0].fragments.length, caret: hitTest(split, caret.page, caret.x, caret.y + caret.height / 2), selection: selectionRects(split, 0, 6)[0].width };
  });
  expect(result.off).toBeGreaterThan(result.on); expect(result.split).toBeCloseTo(result.on); expect(result.fragments).toBe(1); expect(result.caret).toBe(3); expect(result.selection).toBeCloseTo(result.on);
});

test('previews malformed thresholds and unsupported kerning modes as read-only with the original available', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/); const before = await input.inputValue();
  for (const [name, part, from, to, message] of [['invalid-kern', 'word/document.xml', '<w:kern w:val="24"/>', '<w:kern/>', /invalid kerning threshold/], ['punctuation-kern', 'word/settings.xml', '</w:settings>', '<w:noPunctuationKerning w:val="yes"/></w:settings>', /noPunctuationKerning/]]) {
    const parts = unzipSync(readFileSync('public/fixtures/kerning.docx')); parts[part] = strToU8(strFromU8(parts[part]).replace(from, to)); await openReadOnlyPreview(page, { name: name + '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
  }
});

test('detects unavailable Canvas kerning control before attaching the editor', async ({ page }) => {
  await page.addInitScript(() => { delete CanvasRenderingContext2D.prototype.fontKerning; }); await page.goto('/playground.html'); await showAllTools(page); await expect(page.getByText(/Canvas font-kerning support/)).toBeVisible(); await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Download .docx', exact: true })).toHaveCount(0);
});
