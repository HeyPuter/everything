import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// An SVG whose outer width and height are zero drew nothing: it was inserted as a blank 300 × 150 picture.
// It now takes its size from its viewBox (or 300 × 150 without one) and shows its drawing.
const cases = [
  ['viewBox', '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" viewBox="0 0 50 100"><rect width="50" height="100" fill="#ff0000"/></svg>', [75, 150]],
  ['no viewBox', '<svg xmlns="http://www.w3.org/2000/svg" width="0px" height="0"><rect width="300" height="150" fill="#ff0000"/></svg>', [300, 150]],
];
for (const [label, svg, [width, height]] of cases) test(`an SVG with zero width and height and ${label} is inserted at a size that shows it`, async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Drawing: ');
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await expect(page.locator('#ribbon-tab-picture')).toHaveAttribute('aria-selected', 'true');
  const path = info.outputPath('drawing.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const files = unzipSync(readFileSync(path));
  const [, cx, cy] = strFromU8(files['word/document.xml']).match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
  expect([Math.round(cx / 9525), Math.round(cy / 9525)]).toEqual([width, height]);
  // The picture's rendering is red, not blank, and the SVG kept beside it has no zero size.
  const png = Object.entries(files).find(([name]) => /^word\/media\/.*\.png$/.test(name))[1];
  const red = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const c = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 3] > 200) n++;
    return n / (c.width * c.height);
  }, [...png]);
  expect(red).toBeGreaterThan(0.9);
  const kept = Object.entries(files).find(([name]) => /^word\/media\/.*\.svg$/.test(name));
  if (kept) expect(strFromU8(kept[1])).not.toMatch(/<svg[^>]*\b(width|height)="0/);
  expect(errors).toEqual([]);
});
