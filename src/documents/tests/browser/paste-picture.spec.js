import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { downloadDocx } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const pictures = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image).length);
const png = [...readFileSync('public/icons/icon-64.png')];

test('a pasted screenshot or copied picture is inserted at the caret', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  try {
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await input(page).fill('Before ');
    await input(page).evaluate((el, bytes) => {
      el.focus(); const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    await expect.poll(() => pictures(page)).toBe(1);
    await expect(input(page)).toHaveValue('Before ￼');
    await input(page).press('ControlOrMeta+z');
    await expect.poll(() => pictures(page)).toBe(0);
    // Edit > Paste reads the same picture from the system clipboard.
    await page.evaluate(async bytes => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]), png);
    await input(page).press('ControlOrMeta+End');
    await page.locator('.ribbon-card').getByRole('button', { name: 'Paste', exact: true }).click();
    await expect.poll(() => pictures(page)).toBe(1);
    // Text on the clipboard beside a picture is pasted as text.
    await input(page).press('ControlOrMeta+End');
    await input(page).evaluate((el, bytes) => {
      el.focus(); const data = new DataTransfer(); data.setData('text/plain', ' caption'); data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    await expect(input(page)).toHaveValue(/ caption$/);
    expect(await pictures(page)).toBe(1);
  } finally { await context.close(); }
});

test('a picture dropped on the page is inserted where it lands', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha bravo\nCharlie');
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  const at = await page.evaluate(() => { const e = window.__docs.current.view.engine, line = e.selectionLayout.lines[0]; return { x: line.stops.find(s => s.offset === 6).x * e.zoom, y: (line.y + line.height / 2) * e.zoom }; });
  const accepted = await page.locator('canvas.canvas-page').first().evaluate((canvas, { x, y, bytes }) => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
    const point = { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true };
    const over = new DragEvent('dragover', point), drop = new DragEvent('drop', point);
    canvas.dispatchEvent(over); canvas.dispatchEvent(drop);
    return over.defaultPrevented && drop.defaultPrevented;
  }, { x: box.x + at.x, y: box.y + at.y, bytes: png });
  expect(accepted).toBe(true);
  await expect.poll(() => pictures(page)).toBe(1);
  await expect(input(page)).toHaveValue('Alpha ￼bravo\nCharlie');
  await expect(page.getByText('Drop pictures on the page to insert them')).toHaveCount(0);
});

test('a pasted picture larger than the session holds is scaled down, as Insert > Pictures does', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Photo: ');
  // An 18-megapixel photo or screenshot, over the 16-megapixel session limit.
  await input(page).evaluate(async el => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 5000, height: 3600 }), g = canvas.getContext('2d');
    g.fillStyle = '#3a7'; g.fillRect(0, 0, 5000, 3600);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    el.focus(); const data = new DataTransfer(); data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => pictures(page)).toBe(1);
  const stored = await page.evaluate(() => {
    const e = window.__docs.current.view.engine, image = e.model.paragraphs.flatMap(p => p.runs).find(r => r.image).image, bitmap = e.images.get(image.assetId);
    return { width: bitmap.width, height: bitmap.height, ratio: image.width / image.height };
  });
  expect(stored.width * stored.height).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(stored.width / stored.height).toBeCloseTo(5000 / 3600, 2);
  expect(stored.ratio).toBeCloseTo(5000 / 3600, 2);
  await expect(page.getByText('Images must be at most')).toHaveCount(0);
});

test('a picture copied or cut in the document pastes as the picture, at its size, not as text', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  try {
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await input(page).fill('Before ');
    await input(page).evaluate((el, bytes) => {
      el.focus(); const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    await expect.poll(() => pictures(page)).toBe(1);
    // Resized and described, as a picture in a document usually is.
    await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(7, 8); e.execute(() => e.model.setImageProperties({ width: 457200, height: 228600, alt: 'Logo' })); e.syncInput(); });
    const images = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image).map(({ image: { width, height, alt } }) => ({ width, height, alt })));
    const copied = { width: 457200, height: 228600, alt: 'Logo' };
    await input(page).press('ControlOrMeta+c');
    await input(page).press('ControlOrMeta+End');
    await input(page).press('ControlOrMeta+v');
    await expect.poll(images).toEqual([copied, copied]);
    await expect(input(page)).toHaveValue('Before ￼￼');
    // Cut removes it, and Edit > Paste (the system clipboard) brings it back.
    await input(page).evaluate(el => { el.focus(); el.setSelectionRange(8, 9); el.dispatchEvent(new Event('select')); });
    await input(page).press('ControlOrMeta+x');
    await expect.poll(images).toEqual([copied]);
    await input(page).evaluate(el => { el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
    await page.locator('.ribbon-card').getByRole('button', { name: 'Paste', exact: true }).click();
    await expect.poll(images).toEqual([copied, copied]);
    await expect(input(page)).toHaveValue('￼Before ￼');
    // The picture's menu copies it too.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0, 1); e.syncInput(); e.onSelection(); });
    const frame = await page.locator('.canvas-image-frame').boundingBox();
    await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2, { button: 'right' });
    await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.range)).toEqual([0, 1]);
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => { const [item] = await navigator.clipboard.read(); return item.types.includes('text/html') ? /<img[^>]+data-documents-picture/.test(await (await item.getType('text/html')).text()) : false; })).toBe(true);
  } finally { await context.close(); }
});

test('a cropped, flipped picture copied and pasted keeps its crop, flip and frame, and saves them', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('A ');
  await input(page).evaluate((el, bytes) => {
    el.focus(); const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  await expect.poll(() => pictures(page)).toBe(1);
  const images = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image)
    .map(({ image }) => ({ width: image.width, height: image.height, crop: image.crop || null, flipH: !!image.flipH, rotation: image.rotation || 0 })));
  // Crop the right half away and flip it, then copy it.
  const html = await page.evaluate(() => {
    const e = window.__docs.current.view.engine, image = e.model.selectedImage;
    e.setImageProperties({ crop: { left: 0, top: 0, right: 50000, bottom: 0 }, width: Math.round(image.width / 2), flipH: true });
    const data = new DataTransfer();
    e.input.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/html');
  });
  expect(html).toContain('data-documents-picture');
  const [source] = await images();
  await input(page).press('ControlOrMeta+End');
  await input(page).evaluate((el, html) => {
    const data = new DataTransfer(); data.setData('text/html', html); data.setData('text/plain', '￼');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, html);
  await expect.poll(() => pictures(page)).toBe(2);
  const [, pasted] = await images();
  expect(pasted).toEqual(source);
  expect(pasted.crop).toEqual({ left: 0, top: 0, right: 50000, bottom: 0 });
  // Undo takes the pasted picture away in one step.
  await input(page).press('ControlOrMeta+z');
  await expect.poll(() => pictures(page)).toBe(1);
  await input(page).press('ControlOrMeta+Shift+z');
  await expect.poll(() => pictures(page)).toBe(2);
  // Both pictures save their crop and flip.
  const download = page.waitForEvent('download');
  await downloadDocx(page);
  const path = info.outputPath('cropped-paste.docx');
  await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
  expect(xml.match(/<a:srcRect l="0" t="0" r="50000" b="0"\/>/g)).toHaveLength(2);
  expect(xml.match(/<a:xfrm flipH="1"/g)).toHaveLength(2);
  expect(errors).toEqual([]);
});
