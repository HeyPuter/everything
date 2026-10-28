import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { downloadDocx } from './helpers/editor-tools.js';

// A document with Word watermarks (VML in its headers) opens for editing; the watermarks show behind
// the text of the pages whose header holds them and are saved as they were.
const FIXTURE = 'tests/fixtures/vml-watermarks/watermarks.docx';
/** Colours in a square around the centre of a page canvas: counts of greys and of tinted pixels. */
const centre = (page, index) => page.evaluate(index => {
  const canvas = document.querySelectorAll('canvas.canvas-page')[index], ctx = canvas.getContext('2d');
  const size = Math.round(canvas.width / 4), data = ctx.getImageData(Math.round(canvas.width / 2 - size / 2), Math.round(canvas.height / 2 - size / 2), size, size).data;
  let grey = 0, tinted = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 20) tinted++; else if (r < 245) grey++;
  }
  return { grey, tinted };
}, index);

test('Word watermarks open for editing, show behind the text and save unchanged', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(FIXTURE);
  await expect(input).toHaveValue('Body text.');
  await expect(page.getByText('Read only', { exact: true })).toHaveCount(0);
  // Page 1 has the first-page header: the washed-out picture (red and blue) behind the text.
  await expect.poll(() => centre(page, 0)).toMatchObject({ tinted: expect.any(Number) });
  expect((await centre(page, 0)).tinted).toBeGreaterThan(100);
  // A second page shows the default header's silver CONFIDENTIAL.
  await input.press('ControlOrMeta+End');
  for (let i = 0; i < 45; i++) await input.press('Enter');
  await page.keyboard.type('Second page text.');
  await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
  await page.locator('canvas.canvas-page').nth(1).scrollIntoViewIfNeeded();
  await expect.poll(async () => (await centre(page, 1)).grey).toBeGreaterThan(500);
  expect((await centre(page, 1)).tinted).toBe(0);
  if (process.env.WATERMARK_SHOTS) await page.screenshot({ path: `${process.env.WATERMARK_SHOTS}/watermarks.png` });

  // Saved: both headers as they were.
  const path = info.outputPath('watermarks.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  mkdirSync('test-results/vml-watermarks', { recursive: true }); writeFileSync('test-results/vml-watermarks/watermarks.docx', readFileSync(path));
  const saved = unzipSync(new Uint8Array(readFileSync(path))), original = unzipSync(new Uint8Array(readFileSync(FIXTURE)));
  for (const part of ['word/header1.xml', 'word/header2.xml', 'word/media/watermark.png']) expect(strFromU8(saved[part]), part).toBe(strFromU8(original[part]));
  expect(strFromU8(saved['word/document.xml'])).toContain('Second page text.');
  expect(errors).toEqual([]);
});
