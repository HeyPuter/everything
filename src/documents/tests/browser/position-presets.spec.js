import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

// Position presets (Picture Format > Position) place a picture in a corner or the middle of the page's
// margins, as Word does: aligned to the margins (§20.4.2.10 positionH, §20.4.2.11 positionV, §20.4.2.1 align),
// so text that wraps around it, or is added above its paragraph, does not move it out of place.
const PNG = readFileSync('icon-128.png');
const OBJECT = '￼';

async function start(page) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} has enough words in it to wrap around a picture placed beside it on the page.`).join('\n'));
  // The picture goes into the seventh paragraph, well below the top of the page.
  const text = await input.inputValue();
  const at = text.indexOf('Paragraph 7 ') + 'Paragraph 7 '.length;
  await input.evaluate((el, at) => { el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, at);
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await input.inputValue()).split(OBJECT).length - 1).toBe(1);
  await expect(page.locator('#ribbon-tab-picture')).toHaveAttribute('aria-selected', 'true');
  return { input, errors };
}

/** The selected picture's frame in page pixels (left, top, right edge from the page's left, bottom). */
async function frameOnPage(page) {
  const canvas = await page.locator('canvas.canvas-page').first().boundingBox();
  const frame = await page.locator('.canvas-image-frame').boundingBox();
  const zoom = canvas.width / 816;
  return { left: (frame.x - canvas.x) / zoom, top: (frame.y - canvas.y) / zoom, right: (frame.x + frame.width - canvas.x) / zoom, bottom: (frame.y + frame.height - canvas.y) / zoom };
}

test('Top Right puts the picture against the top and right margins and keeps it there', async ({ page }, info) => {
  const { input, errors } = await start(page);
  const ribbon = page.locator('#ribbon-panel-picture');
  await ribbon.getByRole('button', { name: 'Position', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Position in Top Right with Square Text Wrapping' }).click();
  // Letter paper with one-inch margins: the margins are 96 px in from each edge of the 816 px page.
  await expect.poll(async () => Math.round((await frameOnPage(page)).top)).toBe(96);
  expect(Math.round((await frameOnPage(page)).right)).toBe(816 - 96);
  // Lines added above the picture's paragraph leave it where it is.
  await input.evaluate(el => { el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await input.evaluate((el, object) => { const at = el.value.indexOf(object); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select')); }, OBJECT);
  await expect(page.locator('.canvas-image-frame')).toBeVisible();
  expect(Math.round((await frameOnPage(page)).top)).toBe(96);
  expect(Math.round((await frameOnPage(page)).right)).toBe(816 - 96);

  const path = info.outputPath('top-right.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const body = strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml']);
  expect(body).toMatch(/<wp:positionH relativeFrom="margin"><wp:align>right<\/wp:align><\/wp:positionH>/);
  expect(body).toMatch(/<wp:positionV relativeFrom="margin"><wp:align>top<\/wp:align><\/wp:positionV>/);
  expect(body).toMatch(/<wp:wrapSquare wrapText="bothSides"\/>/);
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 30000 });
  expect(errors).toEqual([]);
});

test('Bottom Left and Middle Center are placed inside the margins', async ({ page }) => {
  const { errors } = await start(page);
  const ribbon = page.locator('#ribbon-panel-picture');
  await ribbon.getByRole('button', { name: 'Position', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Position in Bottom Left with Square Text Wrapping' }).click();
  await expect.poll(async () => Math.round((await frameOnPage(page)).bottom)).toBe(1056 - 96);
  expect(Math.round((await frameOnPage(page)).left)).toBe(96);
  await ribbon.getByRole('button', { name: 'Position', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Position in Middle Center with Square Text Wrapping' }).click();
  await expect.poll(async () => { const f = await frameOnPage(page); return Math.round(f.top + f.bottom); }).toBe(1056);
  const f = await frameOnPage(page);
  expect(Math.round(f.left + f.right)).toBe(816);
  expect(errors).toEqual([]);
});

test('another side wrapping keeps a preset picture in its corner', async ({ page }) => {
  const { errors } = await start(page);
  const ribbon = page.locator('#ribbon-panel-picture');
  await ribbon.getByRole('button', { name: 'Position', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Position in Top Right with Square Text Wrapping' }).click();
  await expect.poll(async () => Math.round((await frameOnPage(page)).top)).toBe(96);
  for (const wrap of ['Tight', 'Through', 'Square']) {
    await ribbon.getByRole('button', { name: 'Wrap Text', exact: true }).click();
    await page.getByRole('menuitemradio', { name: wrap }).click();
    await expect(ribbon.getByRole('button', { name: 'Wrap Text', exact: true })).toBeEnabled();
    await expect.poll(async () => Math.round((await frameOnPage(page)).top)).toBe(96);
    expect(Math.round((await frameOnPage(page)).right)).toBe(816 - 96);
  }
  expect(errors).toEqual([]);
});
