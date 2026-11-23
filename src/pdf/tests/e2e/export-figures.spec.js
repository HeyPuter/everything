import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// A chart drawn among the text of a page reaches Word as a picture of the chart, labels and all.

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

async function chartPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Sales grew in every region during the year, led by the new line.', {
    x: 72,
    y: 720,
    size: 11,
    font,
  });
  page.drawLine({ start: { x: 100, y: 450 }, end: { x: 400, y: 450 }, thickness: 1 });
  page.drawLine({ start: { x: 100, y: 450 }, end: { x: 100, y: 650 }, thickness: 1 });
  page.drawSvgPath('M 0 0 L 60 -40 L 120 -20 L 180 -120 L 240 -90 L 300 -170', {
    x: 100,
    y: 450,
    borderColor: rgb(0, 0, 1),
    borderWidth: 3,
  });
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'].forEach((m, i) =>
    page.drawText(m, { x: 142 + i * 50, y: 436, size: 8, font }),
  );
  page.drawText('The report continues with ordinary body text after the chart.', {
    x: 72,
    y: 300,
    size: 11,
    font,
  });
  return doc.save();
}

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const entries = view.getUint16(end + 8, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map();
  for (let i = 0; i < entries; i++) {
    const method = view.getUint16(at + 10, true),
      size = view.getUint32(at + 20, true),
      nameLength = view.getUint16(at + 28, true),
      offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const raw = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw);
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return files;
}

test('Word export keeps a chart on a text page as a picture of the chart', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'chart.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await chartPdf()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Export a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Microsoft Word (.docx)…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Export to/ });
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const files = zipEntries(await readFile(await (await pending).path()));
  const media = [...files.keys()].filter((name) => name.startsWith('word/media/'));
  expect(media).toHaveLength(1);
  const png = files.get(media[0]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // The chart's area with its month labels, drawn at twice its size in points.
  expect(view.getUint32(16)).toBeGreaterThan(590);
  expect(view.getUint32(16)).toBeLessThan(640);
  expect(view.getUint32(20)).toBeGreaterThan(420);
  expect(view.getUint32(20)).toBeLessThan(450);
  // It shows the chart's blue line, not blank paper.
  const blue = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 2] > 200 && data[i] < 80 && data[i + 3] > 200) count++;
    return count;
  }, Array.from(png));
  expect(blue).toBeGreaterThan(1000);
  const body = new TextDecoder().decode(files.get('word/document.xml'));
  expect(body).toContain('Sales grew');
  expect(body).toContain('The report continues');
  expect(body).not.toContain('>Jun<');
});
