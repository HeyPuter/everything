import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

test('renders MACROBUTTON field labels as inert text and downloads the untouched source', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    window.labelPaint = [];
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      if (text === 'Split ' || text === 'label') window.labelPaint.push({ text, font: this.font, color: this.fillStyle });
      return fillText.call(this, text, x, y, ...rest);
    };
  });
  await page.goto('/playground.html');
  const source = 'public/fixtures/macro-button-labels.docx';
  await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/Unquoted: \[Last, First Name of Author\]/);
  // The cached DATE row kept this fixture read-only until DATE became a retained field (2026-10-09);
  // it now opens for editing, as tests/canvas-macro-buttons.test.js expects.
  await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(1);
  const original = await input.inputValue();
  expect(original).toContain('Quoted: "Quoted display label"  | end');
  expect(original).toContain('Locked: Locked instruction | end');
  expect(original).toContain('Simple: Simple display | end');
  expect(original).toContain('Not a button: Cached date | end');
  expect(original).not.toMatch(/MACROBUTTON|DoFieldClick|NoMacro|Command With Spaces|Stale cached/);
  const painted = await page.evaluate(() => window.labelPaint);
  expect(painted.some(p => p.text === 'Split ' && /bold|700/.test(p.font) && p.color === '#2050c0')).toBe(true);
  expect(painted.some(p => p.text === 'label' && /italic/.test(p.font) && p.color === '#c02050')).toBe(true);
  // Typing edits the document; undo restores it and the download is still the untouched source.
  await input.focus(); await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('No changes');
  await expect(input).toHaveValue('No changes' + original);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue(original);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const saved = testInfo.outputPath('macro-button-labels.docx'); await (await pending).saveAs(saved);
  expect(unzipSync(readFileSync(saved))).toEqual(unzipSync(readFileSync(source)));
  const image = await page.locator('canvas.canvas-page').evaluate(c => c.toDataURL());
  writeFileSync(testInfo.outputPath('page1.png'), Buffer.from(image.split(',')[1], 'base64'));
  expect(errors).toEqual([]);
});
