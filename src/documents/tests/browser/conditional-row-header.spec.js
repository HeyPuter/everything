import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
import {paintAllPages} from './helpers/paint-pages.js';
const source = 'public/fixtures/conditional-row-header.docx';
const ref = JSON.parse(readFileSync('tests/fixtures/conditional-row-header/reference.json'));

test('matches native conditional row headers, formatting and page repetitions through edit/reopen/undo', async ({ page }, info) => {
  test.setTimeout(120000);
  expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(ref.sourceSha256);
  expect(createHash('sha256').update(readFileSync('tests/fixtures/conditional-row-header/native.pdf')).digest('hex')).toBe(ref.pdfSha256);
  await page.addInitScript(() => {
    window.rowHeaderText = new Map();
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      if (/^C\dR\dC\d$/.test(text)) {
        if (!window.rowHeaderText.has(this.canvas)) window.rowHeaderText.set(this.canvas, new Map());
        window.rowHeaderText.get(this.canvas).set(text, { text, x: x * .75, y: y * .75, color: this.fillStyle.slice(1).toUpperCase() });
      }
      return original.call(this, text, x, y, ...rest);
    };
  });
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^Conditional row controls/); await expect(input).toHaveJSProperty('readOnly', false);
  const check = async () => {
    await expect(page.locator('#playground-error')).toBeEmpty();
    await expect(page.locator('canvas.canvas-page')).toHaveCount(ref.pages.length);
    await paintAllPages(page);
    const pages = await page.locator('canvas.canvas-page').evaluateAll(cs => cs.map(c => [...(window.rowHeaderText.get(c)?.values() || [])]));
    for (const [i, expected] of ref.pages.entries()) {
      expect(pages[i].map(x => x.text).sort(), `page ${i + 1}`).toEqual(expected.map(x => x.text).sort());
      for (const label of expected) {
        const actual = pages[i].find(x => x.text === label.text);
        expect(actual.color, label.text).toBe(label.color);
        for (const axis of ['x', 'y']) expect(Math.abs(actual[axis] - label[axis]), `${label.text} ${axis}`).toBeLessThan(.8);
      }
    }
  };
  const original = await input.inputValue(); await check();
  await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited '); await check();
  const save = async label => {
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = info.outputPath(`conditional-row-header-${label}.docx`); await (await pending).saveAs(path); return path;
  };
  const edited = await save('edited'), parts = unzipSync(readFileSync(edited)), before = unzipSync(readFileSync(source));
  for (const name of Object.keys(before)) if (name !== 'word/document.xml') expect(parts[name]).toEqual(before[name]);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(original); await check();
  expect(unzipSync(readFileSync(await save('undo')))).toEqual(before);
  await reopenDocx(page, input, edited, 'Edited ' + original); await check();
});
