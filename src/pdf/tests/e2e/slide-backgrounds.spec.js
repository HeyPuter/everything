import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

// The picture behind a slide leaves out the text the slide shows in its own text boxes.

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  const entries = view.getUint16(end + 8, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map();
  for (let i = 0; i < entries; i++) {
    const method = view.getUint16(at + 10, true),
      size = view.getUint32(at + 20, true),
      nameLength = view.getUint16(at + 28, true),
      offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const localName = view.getUint16(offset + 26, true);
    const start = offset + 30 + localName + view.getUint16(offset + 28, true);
    const raw = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw);
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return files;
}

test('slide pictures keep the drawings but not the text the slide shows as text', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const sheet = doc.addPage([400, 200]);
  // A heavy black word on the left, a red block on the right.
  sheet.drawText('IIII', { x: 20, y: 60, size: 90, font, color: rgb(0, 0, 0) });
  sheet.drawRectangle({ x: 260, y: 60, width: 100, height: 80, color: rgb(1, 0, 0) });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'slide.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Export a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Presentation (.pptx)…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Export to/ });
  await dialog.getByLabel(/Put a picture of each page/).check();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const files = zipEntries(new Uint8Array(await readFile(await (await pending).path())));
  // The word is an editable text box on the slide.
  expect(new TextDecoder().decode(files.get('ppt/slides/slide1.xml'))).toContain('IIII');
  const [picture] = [...files.keys()].filter((name) => /^ppt\/media\/.*\.png$/.test(name));
  const colors = await page.evaluate(
    async (data) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);
      // Count dark pixels across the word's box, and read the block's middle.
      const word = context.getImageData(0, bitmap.height * 0.5, bitmap.width * 0.6, 1).data;
      let dark = 0;
      for (let i = 0; i < word.length; i += 4) if (word[i] < 128) dark++;
      return {
        dark,
        block: [...context.getImageData(bitmap.width * 0.77, bitmap.height / 2, 1, 1).data],
      };
    },
    Array.from(files.get(picture)),
  );
  expect(colors.dark).toBe(0);
  expect(colors.block[0]).toBeGreaterThan(200);
  expect(colors.block[1]).toBeLessThan(60);
});
