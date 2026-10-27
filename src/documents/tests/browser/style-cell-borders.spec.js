import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
import {paintAllPages} from './helpers/paint-pages.js';

const reference = JSON.parse(readFileSync('tests/fixtures/style-cell-borders/positions.json', 'utf8'));
test('matches native style-border divergence and long-row page cuts, preserving edits and source styles', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.borderPaint = new Map(); const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      if (/^(Lead|Header|Neighbor|Body\d\d|Last|After)$/.test(text)) {
        if (!window.borderPaint.has(this.canvas)) window.borderPaint.set(this.canvas, new Map());
        window.borderPaint.get(this.canvas).set(`${text}:${x}:${y}`, { text, x: x * .75, y: y * .75 });
      }
      return original.call(this, text, x, y, ...rest);
    };
  });
  await page.goto('/playground.html');
  const available = await page.evaluate(async () => {
    const { checkFontAvailability, fontAvailable } = await import('/src/engine/font-availability.js');
    await checkFontAvailability('Arial'); return fontAvailable('Arial');
  });
  test.skip(!available, 'Independent native reference requires Arial.');
  const fixture = 'public/fixtures/style-cell-borders.docx';
  await page.getByLabel('Open DOCX file').setInputFiles(fixture);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^Lead/); await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(10);
  await paintAllPages(page);
  const actual = await page.evaluate(() => [...document.querySelectorAll('canvas.canvas-page')].flatMap((canvas, page) =>
    [...(window.borderPaint.get(canvas)?.values() || [])].map(line => ({ page, ...line }))));
  expect(actual).toHaveLength(reference.length);
  for (const word of reference) {
    expect(actual.some(line => line.page === word.page && line.text === word.text && Math.abs(line.x - word.x) < .2 && Math.abs(line.y - word.y) < .2), JSON.stringify(word)).toBe(true);
  }
  const imageData = () => page.locator('canvas.canvas-page').evaluateAll(canvases => canvases.map(c => c.toDataURL()));
  const before = await imageData(), text = await input.inputValue();
  await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited ');
  const download = async suffix => {
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = info.outputPath(`style-cell-borders${suffix}.docx`); await (await event).saveAs(path); return path;
  };
  const saved = await download(''), source = unzipSync(readFileSync(fixture)), edited = unzipSync(readFileSync(saved));
  expect(Object.keys(edited).sort()).toEqual(Object.keys(source).sort());
  for (const name of Object.keys(source)) if (name !== 'word/document.xml') expect(Buffer.from(edited[name]).equals(Buffer.from(source[name])), name).toBe(true);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(text); expect(await imageData()).toEqual(before);
  const undone = unzipSync(readFileSync(await download('-undo')));
  for (const name of Object.keys(source)) expect(Buffer.from(undone[name]).equals(Buffer.from(source[name])), name).toBe(true);
  await reopenDocx(page, input, saved, 'Edited ' + text); await expect(page.locator('canvas.canvas-page')).toHaveCount(10);
  expect(errors).toEqual([]);
});
