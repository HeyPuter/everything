import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { addCompressiblePage, addMetadata } from '../fixtures/metadata.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, bytes, pages) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'photos.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${pages}`);
}
/** Choose a menu item by name from the menu bar, or from the folded phone menu. */
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['File', 'Edit', 'View', 'Page', 'Insert']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    for (const section of ['Edit', 'View', 'Page', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
async function downloaded(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return new Uint8Array(await readFile(await (await pending).path()));
}
/** A two-page PDF with one large photo-like JPEG shown small on both pages. */
async function photoPdf({ separateImages = false } = {}) {
  const canvas = createCanvas(2400, 1800);
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 2400, 1800);
  gradient.addColorStop(0, '#ff8040');
  gradient.addColorStop(1, '#4080ff');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 2400, 1800);
  for (let i = 0; i < 300; i++) {
    context.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`;
    context.beginPath();
    context.arc((i * 7919) % 2400, (i * 104729) % 1800, 10 + (i % 60), 0, Math.PI * 2);
    context.fill();
  }
  const doc = await PDFDocument.create();
  const jpegBytes = await canvas.encode('jpeg', 95);
  const jpeg = await doc.embedJpg(jpegBytes);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([400, 500]);
    page.drawImage(separateImages ? await doc.embedJpg(jpegBytes) : jpeg, {
      x: 50,
      y: 200,
      width: 300,
      height: 225,
    });
    page.drawText(`Photo page ${i + 1}`, { x: 50, y: 150, size: 16 });
  }
  return doc.save();
}

test('Reduce file size shrinks the pictures, reports the sizes, and can be undone', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const original = await photoPdf();
  await openPdf(page, original, 2);
  await menu(page, 'Reduce file size…');
  const dialog = page.getByRole('dialog', { name: 'Reduce file size' });
  await expect(dialog).toContainText(/This PDF is [\d.]+ (KB|MB)/);
  await expect(dialog.getByRole('radio', { name: /Balanced/ })).toBeChecked();
  await dialog.getByRole('radio', { name: /Smallest file/ }).check();
  await dialog.getByRole('button', { name: 'Reduce size', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText(
    /File size reduced from [\d.]+ [KM]B to [\d.]+ [KM]B\./,
  );
  await settled(page);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.workspace .textLayer').getByText('Photo page 1')).toBeVisible();
  const smaller = await downloaded(page);
  expect(smaller.length).toBeLessThan(original.length / 3);
  const doc = await PDFDocument.load(smaller);
  expect(doc.getPageCount()).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  const restored = await downloaded(page);
  expect(restored.length).toBe(original.length);
});

test('a compact PDF is left alone without a history entry', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText('Just text', { x: 30, y: 200, size: 18 });
  await openPdf(page, await doc.save(), 1);
  await menu(page, 'Reduce file size…');
  await page
    .getByRole('dialog', { name: 'Reduce file size' })
    .getByRole('button', { name: 'Reduce size', exact: true })
    .click();
  await expect(page.locator('#toast')).toHaveText('This PDF is already as small as it gets here.');
  await settled(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).toHaveText('Local file');
});

test('reducing file size preserves newer XMP details through download, undo, and redo', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const source = await PDFDocument.create();
  addCompressiblePage(source);
  addMetadata(source);
  await openPdf(page, await source.save(), 1);
  const details = page.getByRole('dialog', { name: 'Document details' });
  const checkDetails = async () => {
    await menu(page, 'Document details…');
    await expect(details.getByLabel('Title')).toHaveValue('XMP title');
    await expect(details.getByLabel('Author')).toHaveValue('Ada');
    await details.getByRole('button', { name: 'Cancel', exact: true }).click();
  };
  await checkDetails();
  await menu(page, 'Reduce file size…');
  await page
    .getByRole('dialog', { name: 'Reduce file size' })
    .getByRole('button', { name: 'Reduce size', exact: true })
    .click();
  await expect(page.locator('#toast')).toContainText('File size reduced');
  await settled(page);
  await checkDetails();
  const saved = await PDFDocument.load(await downloaded(page), { updateMetadata: false });
  expect(saved.getTitle()).toBe('XMP title');
  expect(saved.getAuthor()).toBe('Ada');
  expect(saved.getProducer()).toBe('Original PDF writer');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settled(page);
  await checkDetails();
  expect((await PDFDocument.load(await downloaded(page))).getTitle()).toBe('Info title');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await settled(page);
  await checkDetails();
});

test('closing a document stops compression before encoding its remaining images', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await photoPdf({ separateImages: true }), 2);
  await page.evaluate(() => {
    window.compressionEncodes = 0;
    const encode = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = async function (options) {
      const blob = await encode.call(this, options);
      if (options.type === 'image/jpeg') {
        window.compressionEncodes++;
        if (window.compressionEncodes === 1)
          await new Promise((resolve) => {
            window.releaseCompression = resolve;
          });
      }
      return blob;
    };
  });
  await menu(page, 'Reduce file size…');
  await page
    .getByRole('dialog', { name: 'Reduce file size' })
    .getByRole('button', { name: 'Reduce size', exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => !!window.releaseCompression)).toBe(true);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await page.getByRole('button', { name: 'Leave without saving', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New blank PDF', exact: true })).toBeVisible();
  await page.evaluate(() => window.releaseCompression());
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  expect(await page.evaluate(() => window.compressionEncodes)).toBe(1);
  expect(await page.locator('#toast').textContent()).not.toContain('File size reduced');
});

test('reducing the size of a signed PDF asks first, as other edits do', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const { createSelfSignedId, signPdf, verifySignatures } =
    await import('../../src/core/digital-signature.js');
  const id = await createSelfSignedId({ name: 'Ada Lovelace' });
  const signed = await signPdf(await photoPdf(), id, { page: 0, rect: [20, 20, 180, 60] });
  await openPdf(page, signed, 2);
  await menu(page, 'Reduce file size…');
  await page
    .getByRole('dialog', { name: 'Reduce file size' })
    .getByRole('button', { name: 'Reduce size', exact: true })
    .click();
  const warning = page.getByRole('dialog', { name: 'Edit a signed PDF?' });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await settled(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  const kept = await downloaded(page);
  expect(kept.length).toBe(signed.length);
  expect((await verifySignatures(kept)).map((report) => report.status)).toEqual([
    'valid-unknown-identity',
  ]);
});
