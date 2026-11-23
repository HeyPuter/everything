import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

// Pictures of pages leave out the layers switched off in the Layers panel, as Print does.

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

/** A page with a red block on each of two layers, Draft on the left and Final on the right. */
async function layeredPdf() {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([200, 200]);
  const ctx = doc.context;
  const groups = ['Draft', 'Final'].map((name) =>
    ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) })),
  );
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: groups, D: { BaseState: 'ON' } }));
  sheet.node.set(
    PDFName.of('Resources'),
    ctx.obj({ Properties: { Draft: groups[0], Final: groups[1] } }),
  );
  sheet.node.set(
    PDFName.of('Contents'),
    ctx.register(
      ctx.flateStream(
        '/OC /Draft BDC 1 0 0 rg 20 60 40 80 re f EMC /OC /Final BDC 1 0 0 rg 120 60 40 80 re f EMC',
      ),
    ),
  );
  return Buffer.from(await doc.save());
}

async function openWithDraftHidden(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'layers.pdf', mimeType: 'application/pdf', buffer: await layeredPdf() });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('checkbox', { name: 'Draft', exact: true }).uncheck();
}

/** The green channel at the left (Draft) and right (Final) blocks of a page picture. */
function greens(page, bytes) {
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    return [0.2, 0.7].map(
      (x) => context.getImageData(bitmap.width * x, bitmap.height / 2, 1, 1).data[1],
    );
  }, Array.from(bytes));
}

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

test('Download pages as images leaves out a layer hidden in the Layers panel', async ({ page }) => {
  await openWithDraftHidden(page);
  await page
    .getByRole('menubar', { name: 'PDF menus' })
    .getByRole('menuitem', { name: 'File' })
    .click();
  await page.getByRole('menuitem', { name: 'Download pages as images…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Download pages as images' });
  await dialog.getByLabel('Resolution').selectOption('72');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const png = await readFile(await (await pending).path());
  // The hidden Draft block leaves white paper; the shown Final block is red.
  expect((await greens(page, png)).map((green) => green > 240)).toEqual([true, false]);
});

test('PowerPoint slide pictures leave out a layer hidden in the Layers panel', async ({ page }) => {
  await openWithDraftHidden(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Export a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Presentation (.pptx)…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Export to/ });
  await dialog.getByLabel(/Put a picture of each page/).check();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const files = zipEntries(new Uint8Array(await readFile(await (await pending).path())));
  const pictures = [...files.keys()].filter((name) => /^ppt\/media\/.*\.png$/.test(name));
  expect(pictures).toHaveLength(1);
  expect((await greens(page, files.get(pictures[0]))).map((green) => green > 240)).toEqual([
    true,
    false,
  ]);
});
