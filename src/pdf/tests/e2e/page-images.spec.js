import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile, writeFile } from 'node:fs/promises';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc, name = 'album.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
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
function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  const entries = view.getUint16(end + 8, true);
  let at = view.getUint32(end + 16, true);
  const files = [];
  for (let i = 0; i < entries; i++) {
    const size = view.getUint32(at + 20, true),
      nameLength = view.getUint16(at + 28, true),
      offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const localName = view.getUint16(offset + 26, true);
    files.push({
      name,
      data: bytes.subarray(offset + 30 + localName, offset + 30 + localName + size),
    });
    at += 46 + nameLength;
  }
  return files;
}

test('pages download as JPEG pictures in a ZIP, or as one PNG file for a single page', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++)
    doc.addPage([200, 100]).drawText(`Page ${i + 1}`, { x: 20, y: 40, size: 20, font });
  await openPdf(page, doc);
  await menu(page, 'Download pages as images…');
  const dialog = page.getByRole('dialog', { name: 'Download pages as images' });
  await dialog.getByLabel('Format').selectOption('image/jpeg');
  await dialog.getByLabel('Resolution').selectOption('72');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const zipDownload = await pending;
  expect(zipDownload.suggestedFilename()).toBe('album pages.zip');
  await expect(page.locator('#toast')).toHaveText('3 pages downloaded as JPEG pictures in a ZIP.');
  const entries = zipEntries(new Uint8Array(await readFile(await zipDownload.path())));
  expect(entries.map((e) => e.name)).toEqual([
    'album page 1.jpg',
    'album page 2.jpg',
    'album page 3.jpg',
  ]);
  for (const entry of entries)
    expect(Array.from(entry.data.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  // A single page downloads directly as a PNG at the default resolution.
  await menu(page, 'Download pages as images…');
  const second = page.getByRole('dialog', { name: 'Download pages as images' });
  await second.getByRole('radio', { name: 'Current page (1)' }).check();
  const single = page.waitForEvent('download');
  await second.getByRole('button', { name: 'Download', exact: true }).click();
  const pngDownload = await single;
  expect(pngDownload.suggestedFilename()).toBe('album page 1.png');
  const png = new Uint8Array(await readFile(await pngDownload.path()));
  expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  await expect(page.locator('#toast')).toHaveText('Page 1 downloaded as a PNG picture.');
  await expect(page.locator('.save-status')).toHaveText('Local file');
});

test('overlapping image ranges export each page once in the requested order', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([200, 100]);
  await openPdf(page, doc);
  await menu(page, 'Download pages as images…');
  const dialog = page.getByRole('dialog', { name: 'Download pages as images', exact: true });
  await dialog.getByLabel('Resolution').selectOption('72');
  await dialog.getByLabel('Page range', { exact: true }).fill('3-2, 2, 1-3');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const entries = zipEntries(new Uint8Array(await readFile(await (await pending).path())));
  expect(entries.map((entry) => entry.name)).toEqual([
    'album page 3.png',
    'album page 2.png',
    'album page 1.png',
  ]);
  await expect(page.locator('#toast')).toHaveText('3 pages downloaded as PNG pictures in a ZIP.');

  await menu(page, 'Download pages as images…');
  await dialog.getByLabel('Page range', { exact: true }).fill('2, 2');
  const single = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await single).suggestedFilename()).toBe('album page 2.png');
  await expect(page.locator('#toast')).toHaveText('Page 2 downloaded as a PNG picture.');
  await expect(page.locator('.save-status')).toHaveText('Local file');
});

test('a long picture export holds the editor busy behind a progress dialog that can cancel it', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 30; i++) {
    const sheet = doc.addPage([612, 792]);
    for (let k = 0; k < 30; k++)
      sheet.drawText(`Page ${i + 1}, line ${k + 1}: the quick brown fox jumps over the lazy dog`, {
        x: 40,
        y: 740 - k * 22,
        size: 12,
        font,
      });
  }
  await openPdf(page, doc);
  await menu(page, 'Download pages as images…');
  const dialog = page.getByRole('dialog', { name: 'Download pages as images' });
  await dialog.getByLabel('Resolution').selectOption('300');
  const downloads = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const progress = page.getByRole('dialog', { name: 'Downloading pages as images' });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('status')).toHaveText(/Rendering page \d+ of 30…/);
  // Nothing can change the document while its pages render.
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  await progress.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(progress).toBeHidden();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await expect(page.locator('#toast')).toBeHidden();
  expect(downloads).toEqual([]);
  // The editor carries on as before: the page can be turned right away.
  await menu(page, 'Rotate clockwise');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
});

for (const [type, extension] of [
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
]) {
  test(`a long document name retains unique page numbers in a ${extension} export`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++)
      doc.addPage([200, 100]).drawText(`Page ${i + 1}`, { x: 20, y: 40, font });
    const base = 'a'.repeat(180);
    await openPdf(page, doc, `${base}.pdf`);
    await menu(page, 'Download pages as images…');
    const dialog = page.getByRole('dialog', { name: 'Download pages as images' });
    await dialog.getByLabel('Format').selectOption(type);
    await dialog.getByLabel('Resolution').selectOption('72');
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    const downloaded = await pending;
    const entries = zipEntries(new Uint8Array(await readFile(await downloaded.path())));
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(2);
    expect(entries.map((entry) => entry.name)).toEqual([
      `${base} page 1.${extension}`,
      `${base} page 2.${extension}`,
    ]);
    expect(entries[0].data).not.toEqual(entries[1].data);
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  });
}

for (const [kind, name] of [
  ['CJK', '漢'.repeat(120)],
  ['emoji', '😀'.repeat(90)],
]) {
  test(`image ZIPs from long ${kind} names have portable filenames and extract to disk`, async ({
    page,
  }, testInfo) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([200, 100]);
    doc.addPage([200, 100]);
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Rename album.pdf', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Name this PDF', exact: true });
    await rename.getByLabel('File name', { exact: true }).fill(name);
    await rename.getByRole('button', { name: 'Continue', exact: true }).click();
    await menu(page, 'Download pages as images…');
    const dialog = page.getByRole('dialog', { name: 'Download pages as images' });
    await dialog.getByLabel('Resolution').selectOption('72');
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    const downloaded = await pending;
    const entries = zipEntries(new Uint8Array(await readFile(await downloaded.path())));
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(2);
    for (const [i, entry] of entries.entries()) {
      expect(entry.name.endsWith(` page ${i + 1}.png`)).toBe(true);
      expect(Buffer.byteLength(entry.name)).toBeLessThanOrEqual(255);
      const path = testInfo.outputPath(entry.name);
      await writeFile(path, entry.data);
      expect(new Uint8Array(await readFile(path))).toEqual(entry.data);
      expect(entry.name).not.toContain('\uFFFD');
    }
  });
}

test('a filename cut beside an emoji exports without replacement characters', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  doc.addPage([200, 100]);
  await openPdf(page, doc, `${'a'.repeat(179)}😀.pdf`);
  await menu(page, 'Download pages as images…');
  const dialog = page.getByRole('dialog', { name: 'Download pages as images' });
  await dialog.getByLabel('Resolution').selectOption('72');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const downloaded = await pending;
  const entries = zipEntries(new Uint8Array(await readFile(await downloaded.path())));
  expect(entries).toHaveLength(2);
  for (const entry of entries) expect(entry.name).not.toContain('\uFFFD');
});

/** Dots per inch a PNG (pHYs) or JPEG (JFIF APP0) file records, or null when it has none. */
function recordedDpi(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89) {
    for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      if (type === 'IDAT') return null;
      if (type === 'pHYs' && bytes[at + 16] === 1)
        return [view.getUint32(at + 8), view.getUint32(at + 12)].map((ppm) => ppm * 0.0254);
    }
    return null;
  }
  const jfif =
    bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.subarray(6, 10));
  if (jfif !== 'JFIF' || bytes[13] !== 1) return null;
  return [view.getUint16(14), view.getUint16(16)];
}

for (const [format, label] of [
  ['image/png', 'PNG'],
  ['image/jpeg', 'JPEG'],
])
  test(`a ${label} page picture records the resolution it was made at`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([200, 100]);
    await openPdf(page, doc);
    await menu(page, 'Download pages as images…');
    const dialog = page.getByRole('dialog', { name: 'Download pages as images' });
    await dialog.getByLabel('Format').selectOption(format);
    await dialog.getByLabel('Resolution').selectOption('300');
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    const bytes = new Uint8Array(await readFile(await (await pending).path()));
    // Printed or placed in a document, the picture is the page's own size.
    for (const dpi of recordedDpi(bytes) || [0]) expect(Math.round(dpi)).toBe(300);
  });
