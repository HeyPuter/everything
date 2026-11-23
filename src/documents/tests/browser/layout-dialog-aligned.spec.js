import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// The Layout dialog keeps a floating picture where it is when it is confirmed unchanged, whatever its position
// is measured from (§20.4.2.10 positionH, §20.4.2.11 positionV): margin alignment, as Word writes its Position
// presets, or an offset below the top margin. The dialog measures wrapped objects from the column and paragraph,
// so it must show (and write) the offsets from those frames, not from the ones the file used.
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

/** A picture in the eighth of twelve paragraphs, wrapped as `wrap`, then saved with its position rewritten and reopened. */
async function openPositioned(page, info, wrap, positionH, positionV) {
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
  await page.locator('#ribbon-panel-picture').getByRole('button', { name: 'Wrap Text', exact: true }).click();
  await page.getByRole('menuitemradio', { name: wrap }).click();
  const parts = await save(page, info.outputPath('wrapped.docx'));
  const body = strFromU8(parts['word/document.xml']).replace(/<wp:positionH\b.*?<\/wp:positionH>/, positionH).replace(/<wp:positionV\b.*?<\/wp:positionV>/, positionV);
  expect(body).toContain(positionV);
  const positioned = info.outputPath('positioned.docx');
  writeFileSync(positioned, zipSync({ ...parts, 'word/document.xml': strToU8(body) }));
  const previous = await input.elementHandle();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(positioned);
  await expect.poll(() => previous.evaluate(el => el.isConnected), { timeout: 30000 }).toBe(false);
  await expect(input).toHaveValue(/Paragraph 12/);
  await input.evaluate((el, object) => { const at = el.value.indexOf(object); el.focus(); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select')); }, OBJECT);
  await expect(page.locator('.canvas-image-frame')).toBeVisible();
  return errors;
}
async function confirmLayout(page, check) {
  await onTab(page, 'picture');
  await page.locator('#ribbon-panel-picture').getByRole('button', { name: 'Size and Position…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Layout' });
  await dialog.getByRole('tab', { name: 'Position' }).click();
  await check?.(dialog);
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
}

test('OK in the Layout dialog leaves a margin-aligned, square-wrapped picture where it is', async ({ page }, info) => {
  test.setTimeout(120000);
  // As Word's "Position in Top Right with Square Text Wrapping" writes it.
  const errors = await openPositioned(page, info, 'Square', '<wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH>', '<wp:positionV relativeFrom="margin"><wp:align>top</wp:align></wp:positionV>');
  // Letter paper with one-inch margins: the top and right margins are 96 px in from the page's edges.
  expect(Math.round((await frameOnPage(page)).top)).toBe(96);
  expect(Math.round((await frameOnPage(page)).right)).toBe(816 - 96);
  await confirmLayout(page, async dialog => {
    // The picture is far above its paragraph, so its offset below the paragraph is negative.
    await expect(dialog.getByRole('spinbutton', { name: 'Vertical absolute position (in)' })).not.toHaveValue('0');
    expect(Number(await dialog.getByRole('spinbutton', { name: 'Vertical absolute position (in)' }).inputValue())).toBeLessThan(-1);
  });
  await expect.poll(async () => Math.round((await frameOnPage(page)).top)).toBe(96);
  expect(Math.round((await frameOnPage(page)).right)).toBe(816 - 96);
  expect(errors).toEqual([]);
});

test('OK in the Layout dialog leaves a picture placed below the top margin where it is', async ({ page }, info) => {
  test.setTimeout(120000);
  // Half an inch below the top of the page (the top margin's band starts at the page's edge), 48 px.
  const errors = await openPositioned(page, info, 'In Front of Text', '<wp:positionH relativeFrom="column"><wp:posOffset>914400</wp:posOffset></wp:positionH>', '<wp:positionV relativeFrom="topMargin"><wp:posOffset>457200</wp:posOffset></wp:positionV>');
  expect(Math.round((await frameOnPage(page)).top)).toBe(48);
  await confirmLayout(page, async dialog => {
    await expect(dialog.getByRole('combobox', { name: 'Vertical position below' })).toHaveValue('topMargin');
    await expect(dialog.getByRole('spinbutton', { name: 'Vertical absolute position (in)' })).toHaveValue('0.5');
  });
  await expect.poll(async () => Math.round((await frameOnPage(page)).top)).toBe(48);
  expect(errors).toEqual([]);
});

test('a square-wrapped picture below the top margin keeps its place when the dialog measures it from its paragraph', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors = await openPositioned(page, info, 'Square', '<wp:positionH relativeFrom="column"><wp:posOffset>914400</wp:posOffset></wp:positionH>', '<wp:positionV relativeFrom="topMargin"><wp:posOffset>1371600</wp:posOffset></wp:positionV>');
  // An inch and a half below the top of the page: 144 px.
  expect(Math.round((await frameOnPage(page)).top)).toBe(144);
  await confirmLayout(page, async dialog => {
    await expect(dialog.getByRole('combobox', { name: 'Vertical position below' })).toHaveValue('paragraph');
    expect(Number(await dialog.getByRole('spinbutton', { name: 'Vertical absolute position (in)' }).inputValue())).toBeLessThan(-1);
  });
  await expect.poll(async () => Math.round((await frameOnPage(page)).top)).toBe(144);
  expect(errors).toEqual([]);
});
