import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
for (const name of ['paragraph-line-units', 'paragraph-line-units-default-24']) test(`${name} matches native gaps through edit/reopen/undo`, async ({ page }, info) => {
  const ref = JSON.parse(readFileSync(`tests/fixtures/${name}/reference.json`));
  const source = `public/fixtures/${name}.docx`, bytes = readFileSync(source);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sourceSha256);
  expect(createHash('sha256').update(readFileSync(`tests/fixtures/${name}/native.pdf`)).digest('hex')).toBe(ref.pdfSha256);
  await page.addInitScript(() => {
    window.gapLabels = {}; const paint = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      if (this.canvas.classList.contains('canvas-page') && /^K\d{2}[ABCD]$/.test(text.trim())) { const m = this.getTransform(); window.gapLabels[text.trim()] = (m.b * x + m.d * y + m.f) * .75; }
      return paint.call(this, text, x, y, ...args);
    };
  });
  await page.goto('/playground.html'); await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^K00A/); await expect(input).toBeEditable();
  const original = await input.inputValue();
  const check = async () => {
    await expect(page.locator('#playground-error')).toBeEmpty();
    await expect(page.locator('canvas.canvas-page')).toHaveCount(ref.cases.length);
    const labels = await page.evaluate(() => window.gapLabels);
    expect(Object.keys(labels)).toHaveLength(ref.cases.length * 4);
    for (const c of ref.cases) expect(Math.abs(labels[c.id + 'C'] - 2 * labels[c.id + 'B'] + labels[c.id + 'A'] - c.gap), c.id).toBeLessThan(.25);
  };
  const save = async suffix => {
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = info.outputPath(name + '-' + suffix + '.docx'); await (await pending).saveAs(path); return path;
  };
  await check(); await input.press('ControlOrMeta+End'); await page.keyboard.insertText(' '); await check();
  const editedText = await input.inputValue(), edited = await save('edited'), before = unzipSync(bytes), parts = unzipSync(readFileSync(edited));
  for (const [n, b] of Object.entries(before)) if (n !== 'word/document.xml') expect(parts[n]).toEqual(b);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(original); await check();
  expect(unzipSync(readFileSync(await save('undo')))).toEqual(before);
  await reopenDocx(page, input, edited, editedText); await check();
});
