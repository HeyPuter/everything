import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

// While the body is edited, header and footer content is faded 52% toward the white page.
const dimmed = value => Math.round(value * .48 + 255 * .52);

for (const [mode, top] of [['text', 980.892], ['blank', 964.464]]) {
  test(`retains ${mode} footer clearance measured by the native reference`, async ({ page }) => {
    await page.goto('/playground.html');
    const referenceFont = await page.evaluate(async () => {
      try { await new FontFace('native reference', 'local("Arial")').load(); return true; }
      catch { return false; }
    });
    await page.getByLabel('Open DOCX file').setInputFiles(`public/fixtures/header-drawings-footer-${mode}.docx`);
    await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue('Body page 1\ufffc\nBody page 2\nBody page 3');
    const blue = await page.locator('canvas.canvas-page').first().evaluate((canvas, limit) => {
      const scale = canvas.width / 816, ctx = canvas.getContext('2d');
      const data = ctx.getImageData(Math.floor(110 * scale), 0, 1, canvas.height).data;
      const rows = [];
      for (let y = 0; y < canvas.height; y++) if (data[y * 4] < limit && data[y * 4 + 1] < limit && data[y * 4 + 2] > 230) rows.push(y / scale);
      return { top: rows[0], bottom: rows.at(-1) + 1 / scale };
    }, dimmed(20));
    expect(blue.top).toBeGreaterThan(940); expect(blue.top).toBeLessThan(984);
    expect(Math.abs(blue.bottom - blue.top - 48)).toBeLessThan(1.1);
    if (referenceFont) {
      expect(Math.abs(blue.top - top)).toBeLessThan(1.1);
      expect(Math.abs(blue.bottom - top - 48)).toBeLessThan(1.1);
    }
  });
}

for (const name of ['header-drawings', 'header-drawings-relative-effects', 'header-drawings-fixed-effects']) {
  test(`renders the native repeated ${name} and preserves the source`, async ({ page }, testInfo) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/playground.html');
    await page.evaluate(async () => {
      const { CanvasEditor } = await import('/tools/reviewed-family-modules.js'), relayout = CanvasEditor.prototype.relayout;
      CanvasEditor.prototype.relayout = function (...args) { const result = relayout.apply(this, args); window.headerDrawingsEditor = this; return result; };
    });
    const source = `public/fixtures/${name}.docx`;
    await page.getByLabel('Open DOCX file').setInputFiles(source);
    const input = page.getByRole('textbox', { name: 'Document text' });
    await expect(input).toHaveValue('Body page 1\ufffc\nBody page 2\nBody page 3');
    await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
    const comparison = await page.evaluate(async name => {
      const reference = await createImageBitmap(await (await fetch(`/tests/fixtures/header-drawings/${name}-header.png`)).blob());
      const c = document.createElement('canvas'); c.width = 816; c.height = 420;
      const ctx = c.getContext('2d'); ctx.drawImage(reference, 0, 0); reference.close();
      const expected = ctx.getImageData(0, 0, 816, 420).data;
      const purple = (data, x, y) => { const i = (y * 816 + x) * 4; return data[i] < 220 && data[i] > data[i + 1] + 30 && data[i + 2] > data[i + 1] + 30; };
      const near = (data, x, y) => {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (purple(data, x + dx, y + dy)) return true;
        return false;
      };
      // Compare the printed pages: the screen fades inactive headers, the native reference does not.
      return window.headerDrawingsEditor.printSheets().map(canvas => {
        ctx.clearRect(0, 0, 816, 420); ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 816, 1056);
        const actual = ctx.getImageData(0, 0, 816, 420).data;
        let missing = 0, extra = 0, expectedInk = 0, actualInk = 0;
        for (let y = 1; y < 419; y++) for (let x = 1; x < 815; x++) {
          if (purple(expected, x, y)) { expectedInk++; if (!near(actual, x, y)) missing++; }
          if (purple(actual, x, y)) { actualInk++; if (!near(expected, x, y)) extra++; }
        }
        return { missing: missing / expectedInk, extra: extra / actualInk, expectedInk, actualInk };
      });
    }, name);
    for (const result of comparison) {
      expect(result.expectedInk).toBeGreaterThan(3000);
      expect(result.actualInk).toBeGreaterThan(3000);
      expect(result.missing).toBeLessThan(.015); expect(result.extra).toBeLessThan(.015);
    }
    const colors = await page.locator('canvas.canvas-page').first().evaluate(canvas => {
      const ctx = canvas.getContext('2d'), scale = canvas.width / 816;
      const pixel = (x, y) => [...ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data].slice(0, 3);
      return { header: pixel(110, 40), footer: pixel(110, 990), beforeFooter: pixel(110, 980), afterFooter: pixel(110, 1035), body: pixel(205, 500) };
    });
    expect(colors).toEqual({ header: [0, 180, 0].map(dimmed), footer: [0, 0, 255].map(dimmed), beforeFooter: [255, 255, 255], afterFooter: [255, 255, 255], body: [255, 0, 0] });
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const saved = testInfo.outputPath(`${name}.docx`); await (await pending).saveAs(saved);
    const originalParts = unzipSync(readFileSync(source));
    expect(unzipSync(readFileSync(saved))).toEqual(originalParts);
    await expect(input).toHaveJSProperty('readOnly', false);
    const original = await input.inputValue();
    await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited ');
    const download = async suffix => {
      const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
      const path = testInfo.outputPath(`${name}-${suffix}.docx`); await (await pending).saveAs(path); return path;
    };
    const edited = await download('edited'), parts = unzipSync(readFileSync(edited));
    for (const [path, bytes] of Object.entries(originalParts)) if (path !== 'word/document.xml') expect(parts[path], path).toEqual(bytes);
    await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(original);
    expect(unzipSync(readFileSync(await download('undo')))).toEqual(originalParts);
    await reopenDocx(page, input, edited, 'Edited ' + original);
    await expect(input).toHaveJSProperty('readOnly', false);
    await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
    await expect(page.locator('#playground-error')).toBeEmpty();
    const data = await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL());
    writeFileSync(testInfo.outputPath('page1.png'), Buffer.from(data.split(',')[1], 'base64'));
    expect(errors).toEqual([]);
  });
}

test('preserves preset dashes and percentage anchors through body editing, exact undo and reopen', async ({ page }, testInfo) => {
  await page.goto('/playground.html');
  const source = 'public/fixtures/header-drawings-body.docx';
  await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue('\ufffc\ufffc\nEditable drawing host');
  const original = await input.inputValue();
  await expect(input).not.toHaveAttribute('readonly');
  await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited ');
  const download = async suffix => {
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = testInfo.outputPath(`header-drawings-${suffix}.docx`); await (await pending).saveAs(path); return path;
  };
  const edited = await download('edited'), originalParts = unzipSync(readFileSync(source)), editedParts = unzipSync(readFileSync(edited));
  for (const name of Object.keys(originalParts)) if (name !== 'word/document.xml') expect(Buffer.from(editedParts[name]).equals(Buffer.from(originalParts[name])), name).toBe(true);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(original);
  const undo = unzipSync(readFileSync(await download('undo')));
  for (const name of Object.keys(originalParts)) expect(Buffer.from(undo[name]).equals(Buffer.from(originalParts[name])), name).toBe(true);
  await reopenDocx(page, input, edited, 'Edited ' + original);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(1);
  await expect(page.locator('#playground-error')).toBeEmpty();
});
