import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// A text-wrapped picture aligned to the margins (§20.4.2.1 align in positionH/positionV), as Word writes its
// Position presets, keeps its place when the Layout dialog is confirmed: the dialog measures wrapped objects
// from the column and paragraph, so it must show (and write) the offsets from those, not from the margins.
const PNG = readFileSync('icon-128.png');
const OBJECT = '￼';

async function save(page, path) {
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  return unzipSync(new Uint8Array(readFileSync(path)));
}
async function frameOnPage(page) {
  const canvas = await page.locator('canvas.canvas-page').first().boundingBox();
  const frame = await page.locator('.canvas-image-frame').boundingBox();
  const zoom = canvas.width / 816;
  return { top: (frame.y - canvas.y) / zoom, right: (frame.x + frame.width - canvas.x) / zoom };
}

test('OK in the Layout dialog leaves a margin-aligned, square-wrapped picture where it is', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} has enough words in it to wrap around a picture placed beside it on the page.`).join('\n'));
  await input.evaluate(el => { const at = el.value.indexOf('Paragraph 8 '); el.focus(); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); });
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await input.inputValue()).split(OBJECT).length - 1).toBe(1);
  const ribbon = page.locator('#ribbon-panel-picture');
  await ribbon.getByRole('button', { name: 'Wrap Text', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Square' }).click();
  // Rewrite the picture's position as Word's "Position in Top Right with Square Text Wrapping" does.
  const parts = await save(page, info.outputPath('square.docx'));
  const body = strFromU8(parts['word/document.xml'])
    .replace(/<wp:positionH\b.*?<\/wp:positionH>/, '<wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH>')
    .replace(/<wp:positionV\b.*?<\/wp:positionV>/, '<wp:positionV relativeFrom="margin"><wp:align>top</wp:align></wp:positionV>');
  expect(body).toContain('<wp:align>top</wp:align>');
  const aligned = info.outputPath('aligned.docx');
  writeFileSync(aligned, zipSync({ ...parts, 'word/document.xml': strToU8(body) }));
  const previous = await input.elementHandle();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(aligned);
  await expect.poll(() => previous.evaluate(el => el.isConnected), { timeout: 30000 }).toBe(false);
  await expect(input).toHaveValue(/Paragraph 12/);
  await input.evaluate((el, object) => { const at = el.value.indexOf(object); el.focus(); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select')); }, OBJECT);
  await expect(page.locator('.canvas-image-frame')).toBeVisible();
  // Letter paper with one-inch margins: the top and right margins are 96 px in from the page's edges.
  expect(Math.round((await frameOnPage(page)).top)).toBe(96);
  expect(Math.round((await frameOnPage(page)).right)).toBe(816 - 96);

  await onTab(page, 'picture');
  await ribbon.getByRole('button', { name: 'Size and Position…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Layout' });
  await dialog.getByRole('tab', { name: 'Position' }).click();
  // The picture is far above its paragraph, so its offset below the paragraph is negative.
  await expect(dialog.getByRole('spinbutton', { name: 'Vertical absolute position (in)' })).not.toHaveValue('0');
  expect(Number(await dialog.getByRole('spinbutton', { name: 'Vertical absolute position (in)' }).inputValue())).toBeLessThan(-1);
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => Math.round((await frameOnPage(page)).top)).toBe(96);
  expect(Math.round((await frameOnPage(page)).right)).toBe(816 - 96);
  expect(errors).toEqual([]);
});
