import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { squareWrapDocx, offset, align } from '../helpers/square-wrap-docx.js';
import { reopenDocx } from './helpers/reopen-docx.js';

// The picture's right half is pure blue; find it on the first page canvas, in page pixels.
const blueBounds = canvas => canvas.evaluate(el => {
  const { width, height } = el, data = el.getContext('2d').getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 255 && data[i + 3] === 255) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  const scale = width / 816;
  return right < 0 ? null : [left / scale, top / scale, (right + 1) / scale, (bottom + 1) / scale];
});

test('edits a document whose square-wrapped picture is aligned to the margin and page', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const source = info.outputPath('margin-aligned.docx');
  writeFileSync(source, squareWrapDocx(['margin', align('right')], ['page', offset(1828800)]));
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^Intro paragraph/);
  await expect(page.locator('#playground-error')).toBeEmpty();
  await expect(input).toHaveJSProperty('readOnly', false);
  const first = page.locator('canvas.canvas-page').first();
  await expect.poll(() => blueBounds(first)).not.toBeNull();
  // Right half of a 144 by 96 px picture against the right margin (720 px), 2 in from the page top.
  const [left, top, right, bottom] = await blueBounds(first);
  for (const [actual, expected] of [[left, 648], [top, 192], [right, 720], [bottom, 288]]) expect(Math.abs(actual - expected)).toBeLessThan(1.5);
  const original = await input.inputValue();
  await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited ');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = info.outputPath('edited.docx'); await (await pending).saveAs(path);
  // The browser's serializer may order namespace declarations differently; the drawing is otherwise as authored.
  const anchor = bytes => strFromU8(unzipSync(bytes)['word/document.xml']).match(/<wp:anchor[\s\S]*?<\/wp:anchor>/)[0].replace(/ xmlns:\w+="[^"]*"/g, '');
  expect(anchor(readFileSync(path))).toBe(anchor(readFileSync(source)));
  await reopenDocx(page, input, path, 'Edited ' + original);
  await expect(input).toHaveJSProperty('readOnly', false);
  await expect.poll(() => blueBounds(page.locator('canvas.canvas-page').first())).toEqual([left, top, right, bottom]);
  expect(errors).toEqual([]);
});
