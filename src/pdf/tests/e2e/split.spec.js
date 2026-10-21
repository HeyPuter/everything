import { unflattenableWidget } from '../fixtures/unflattenable-widget.js';
import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addMetadata, xmpDetails } from '../fixtures/metadata.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc, name = 'report.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
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
/** Names and sizes from a stored ZIP's central directory. */
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

test('Split PDF downloads the parts as one ZIP, by group size or at chosen pages', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([100 + i, 100]);
  await openPdf(page, doc);
  await menu(page, 'Split PDF…');
  const dialog = page.getByRole('dialog', { name: 'Split PDF' });
  await expect(
    dialog.getByRole('radio', { name: 'Each page as its own PDF (5 files)' }),
  ).toBeChecked();
  await expect(dialog.getByRole('status')).toHaveText('5 PDFs, downloaded together as a ZIP.');
  await dialog.getByLabel('Pages per part').fill('2');
  await expect(dialog.getByRole('radio', { name: 'Every', exact: true })).toBeChecked();
  await expect(dialog.getByRole('status')).toHaveText('3 PDFs, downloaded together as a ZIP.');
  await dialog.getByLabel('Pages where new parts begin').fill('4');
  await expect(dialog.getByRole('status')).toHaveText('2 PDFs, downloaded together as a ZIP.');
  await dialog.getByLabel('Pages where new parts begin').fill('9');
  await expect(dialog.getByRole('status')).toContainText('between 2 and 5');
  await dialog.getByLabel('Pages where new parts begin').fill('3, 5');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  const downloadEvent = await pending;
  expect(downloadEvent.suggestedFilename()).toBe('report split.zip');
  await expect(page.locator('#toast')).toHaveText('3 PDFs downloaded as a ZIP.');
  const entries = zipEntries(new Uint8Array(await readFile(await downloadEvent.path())));
  expect(entries.map((e) => e.name)).toEqual([
    'report pages 1-2.pdf',
    'report pages 3-4.pdf',
    'report pages 5.pdf',
  ]);
  const widths = await Promise.all(
    entries.map(async (e) =>
      (await PDFDocument.load(e.data)).getPages().map((p) => Math.round(p.getWidth())),
    ),
  );
  expect(widths).toEqual([[100, 101], [102, 103], [104]]);
  await expect(page.locator('.save-status')).toHaveText('Local file');
});

for (const operation of ['extract', 'split'])
  test(`${operation} exports the authoritative XMP details without editing the open PDF`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const source = await PDFDocument.create();
    for (let i = 0; i < 3; i++) source.addPage([300 + i, 400]);
    addMetadata(source);
    await openPdf(page, source);
    const splitting = operation === 'split';
    await menu(page, splitting ? 'Split PDF…' : 'Extract pages…');
    const pending = page.waitForEvent('download');
    await page
      .getByRole('dialog', { name: splitting ? 'Split PDF' : 'Extract pages' })
      .getByRole('button', { name: splitting ? 'Download ZIP' : 'Download pages', exact: true })
      .click();
    const bytes = new Uint8Array(await readFile(await (await pending).path()));
    const parts = splitting ? zipEntries(bytes).map((entry) => entry.data) : [bytes];
    expect(parts).toHaveLength(splitting ? 3 : 1);
    for (const part of parts) {
      const doc = await PDFDocument.load(part, { updateMetadata: false });
      expect(doc.getTitle()).toBe(xmpDetails.title);
      expect(doc.getAuthor()).toBe(xmpDetails.author);
      expect(doc.getSubject()).toBe(xmpDetails.subject);
      expect(doc.getKeywords()).toBe(xmpDetails.keywords);
    }
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
    await expect(page.locator('.save-status')).toHaveText('Local file');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await menu(page, 'Document details…');
    const details = page.getByRole('dialog', { name: 'Document details' });
    await expect(details.getByLabel('Title')).toHaveValue(xmpDetails.title);
    await details.getByRole('button', { name: 'Cancel', exact: true }).click();
    const original = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const unchanged = await PDFDocument.load(await readFile(await (await original).path()), {
      updateMetadata: false,
    });
    expect(unchanged.getTitle()).toBe('Info title');
    expect(unchanged.getModificationDate().toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

async function holdExtractSave(page) {
  await page.evaluate(async () => {
    const { blankPdf, validatePdf } = await import('/src/core/document.js');
    const doc = await validatePdf(await blankPdf());
    const prototype = Object.getPrototypeOf(doc);
    const save = prototype.save;
    window.extractSaveCalls = 0;
    prototype.save = async function (...args) {
      window.extractSaveCalls++;
      const bytes = await save.apply(this, args);
      if (window.extractSaveCalls === 1) {
        await new Promise((resolve, reject) => {
          window.releaseExtract = (fail) => {
            prototype.save = save;
            if (fail) reject(new Error('Extraction failed for testing.'));
            else resolve();
          };
        });
      }
      return bytes;
    };
  });
}

for (const outcome of ['success', 'failure'])
  test(`cancelling page extraction ignores a late ${outcome}`, async ({ page }) => {
    const downloads = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    await openPdf(page, doc);
    await menu(page, 'Extract pages…');
    await holdExtractSave(page);
    const dialog = page.getByRole('dialog', { name: 'Extract pages' });
    await dialog.getByRole('button', { name: 'Download pages', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!window.releaseExtract)).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate((fail) => window.releaseExtract(fail), outcome === 'failure');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(downloads).toEqual([]);
    expect(await page.locator('#toast').isHidden()).toBe(true);
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  });
test('repeated extraction submissions produce one download and allow retry after failure', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  await openPdf(page, doc);
  await menu(page, 'Extract pages…');
  await holdExtractSave(page);
  const dialog = page.getByRole('dialog', { name: 'Extract pages' });
  await dialog.getByRole('button', { name: 'Download pages', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.releaseExtract)).toBe(true);
  await dialog.locator('form').evaluate((form) => form.requestSubmit());
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
  expect(await page.evaluate(() => window.extractSaveCalls)).toBe(1);
  await page.evaluate(() => window.releaseExtract(true));
  await expect(dialog.getByRole('alert')).toHaveText('Extraction failed for testing.');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download pages', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(exported.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
  await expect(dialog).toHaveCount(0);
});

async function protectForSplit(page) {
  await menu(page, 'Protect with password…');
  const protect = page.getByRole('dialog', { name: 'Protect with password', exact: true });
  await protect.getByLabel('Password to open').fill('split-secret');
  await protect.getByLabel('Confirm password').fill('split-secret');
  await protect.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(protect).toHaveCount(0);
}

async function holdSplitEncryption(page) {
  await page.evaluate(() => {
    const digest = SubtleCrypto.prototype.digest;
    SubtleCrypto.prototype.digest = async function (...args) {
      SubtleCrypto.prototype.digest = digest;
      const result = await digest.apply(this, args);
      await new Promise((resolve) => {
        window.releaseSplitEncryption = resolve;
      });
      return result;
    };
  });
}

test('a split keeps its submitted password on every part when protection changes during export', async ({
  page,
}) => {
  const { unlockPdf } = await import('../../src/core/security.js');
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.addPage([500, 600]);
  await openPdf(page, doc);
  await protectForSplit(page);
  await holdSplitEncryption(page);
  await menu(page, 'Split PDF…');
  const pending = page.waitForEvent('download');
  await page
    .getByRole('dialog', { name: 'Split PDF', exact: true })
    .getByRole('button', { name: 'Download ZIP', exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => !!window.releaseSplitEncryption)).toBe(true);
  await menu(page, 'Remove password');
  await expect(page.getByRole('button', { name: 'Protected', exact: true })).toBeHidden();
  await page.evaluate(() => window.releaseSplitEncryption());
  const parts = zipEntries(new Uint8Array(await readFile(await (await pending).path())));
  expect(parts).toHaveLength(2);
  for (const [index, part] of parts.entries()) {
    await expect(PDFDocument.load(part.data)).rejects.toThrow(/encrypted/i);
    const decrypted = await unlockPdf(part.data, 'split-secret');
    const exported = await PDFDocument.load(decrypted.bytes);
    expect(exported.getPage(0).getWidth()).toBe(index ? 500 : 300);
  }
  // The newer protection choice still applies to later output of the open document.
  const current = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const plain = await PDFDocument.load(await readFile(await (await current).path()));
  expect(plain.getPageCount()).toBe(2);
});

for (const stage of ['copying', 'encryption'])
  test(`closing a PDF stops pending split ${stage} without downloading or notifying the next view`, async ({
    page,
  }) => {
    const downloads = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([500, 600]);
    await openPdf(page, doc);
    if (stage === 'encryption') await protectForSplit(page);
    await menu(page, 'Split PDF…');
    if (stage === 'copying') await holdExtractSave(page);
    else await holdSplitEncryption(page);
    await page
      .getByRole('dialog', { name: 'Split PDF', exact: true })
      .getByRole('button', { name: 'Download ZIP', exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => !!(window.releaseExtract || window.releaseSplitEncryption)))
      .toBe(true);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    if (stage === 'encryption')
      await page.getByRole('button', { name: 'Leave without saving', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New blank PDF', exact: true })).toBeVisible();
    await page.evaluate(() => (window.releaseExtract || window.releaseSplitEncryption)(false));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(downloads).toEqual([]);
    expect(await page.locator('#toast').textContent()).not.toContain('PDFs downloaded as a ZIP');
  });

test('large PDFs start with a valid split and explain plans over the file limit before export', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 501; i++) doc.addPage([100 + i, 100]);
  await openPdf(page, doc);
  await menu(page, 'Split PDF…');
  const dialog = page.getByRole('dialog', { name: 'Split PDF', exact: true });
  const submit = dialog.getByRole('button', { name: 'Download ZIP', exact: true });
  await expect(dialog.getByRole('radio', { name: 'Every', exact: true })).toBeChecked();
  await expect(dialog.getByRole('status')).toHaveText('251 PDFs, downloaded together as a ZIP.');
  await expect(submit).toBeEnabled();
  await dialog.getByRole('radio', { name: 'Each page as its own PDF (501 files)' }).check();
  await expect(dialog.getByRole('status')).toContainText('at most 500');
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Pages per part').fill('1');
  await expect(submit).toBeDisabled();
  await dialog
    .getByLabel('Pages where new parts begin')
    .fill(Array.from({ length: 500 }, (_, i) => i + 2).join(', '));
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Pages per part').fill('2');
  await expect(submit).toBeEnabled();
  const pending = page.waitForEvent('download');
  await submit.click();
  const parts = zipEntries(new Uint8Array(await readFile(await (await pending).path())));
  expect(parts).toHaveLength(251);
  const widths = (
    await Promise.all(
      parts.map(async (part) =>
        (await PDFDocument.load(part.data)).getPages().map((page) => page.getWidth()),
      ),
    )
  ).flat();
  expect(widths).toEqual(Array.from({ length: 501 }, (_, i) => i + 100));
});

async function extractOtherPage(page) {
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel' }).click();
  await page.locator('.thumb-item').nth(1).hover();
  await page.getByRole('button', { name: 'Page 2 actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Extract this page', exact: true }).click();
}

for (const stage of ['copying', 'encryption'])
  test(`closing a PDF cancels a thumbnail extraction during ${stage}`, async ({ page }) => {
    const downloads = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([500, 600]);
    await openPdf(page, doc);
    if (stage === 'copying') await holdExtractSave(page);
    else {
      await protectForSplit(page);
      await holdSplitEncryption(page);
    }
    await extractOtherPage(page);
    await expect
      .poll(() => page.evaluate(() => !!(window.releaseExtract || window.releaseSplitEncryption)))
      .toBe(true);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    if (stage === 'encryption')
      await page.getByRole('button', { name: 'Leave without saving', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New blank PDF', exact: true })).toBeVisible();
    await page.evaluate(() => (window.releaseExtract || window.releaseSplitEncryption)(false));
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(downloads).toEqual([]);
    expect(await page.locator('#toast').textContent()).not.toContain('downloaded as a new PDF');
  });

test('thumbnail extraction retains its submitted protection while the source password changes', async ({
  page,
}) => {
  const { unlockPdf } = await import('../../src/core/security.js');
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.addPage([500, 600]);
  await openPdf(page, doc);
  await protectForSplit(page);
  await holdExtractSave(page);
  await extractOtherPage(page);
  await expect.poll(() => page.evaluate(() => !!window.releaseExtract)).toBe(true);
  await menu(page, 'Remove password');
  await expect(page.getByRole('button', { name: 'Protected', exact: true })).toBeHidden();
  const pending = page.waitForEvent('download');
  await page.evaluate(() => window.releaseExtract(false));
  const bytes = await readFile(await (await pending).path());
  await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
  const decrypted = await unlockPdf(new Uint8Array(bytes), 'split-secret');
  const extracted = await PDFDocument.load(decrypted.bytes);
  expect(extracted.getPageCount()).toBe(1);
  expect(extracted.getPage(0).getSize()).toEqual({ width: 500, height: 600 });
  const current = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const plain = await PDFDocument.load(await readFile(await (await current).path()));
  expect(plain.getPageCount()).toBe(2);
});

test('mixed valid and invalid split points cannot silently produce a partial split', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([100 + i, 100]);
  await openPdf(page, doc);
  await menu(page, 'Split PDF…');
  const dialog = page.getByRole('dialog', { name: 'Split PDF', exact: true });
  const points = dialog.getByLabel('Pages where new parts begin');
  const download = dialog.getByRole('button', { name: 'Download ZIP', exact: true });
  const downloads = [];
  page.on('download', (file) => downloads.push(file.suggestedFilename()));
  for (const value of ['3, 99', '3, 0', '3, 1', '3, 999999999999999999999999']) {
    await points.fill(value);
    await expect(download).toBeDisabled();
    await expect(dialog.getByRole('status')).toContainText('between 2 and 5');
    await points.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('between 2 and 5');
    await expect(dialog).toBeVisible();
  }
  expect(downloads).toEqual([]);
  await points.fill('5, 3, 3');
  await expect(download).toBeEnabled();
  await expect(dialog.getByRole('status')).toHaveText('3 PDFs, downloaded together as a ZIP.');
  const pending = page.waitForEvent('download');
  await points.press('Enter');
  const entries = zipEntries(new Uint8Array(await readFile(await (await pending).path())));
  const widths = await Promise.all(
    entries.map(async (entry) =>
      (await PDFDocument.load(entry.data)).getPages().map((sheet) => sheet.getWidth()),
    ),
  );
  expect(widths).toEqual([[100, 101], [102, 103], [104]]);
  await expect(page.locator('.save-status')).toHaveText('Local file');
});

for (const operation of ['extract', 'split'])
  test(`${operation} refuses an indirect widget that cannot be flattened and preserves the open form`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await unflattenableWidget());
    const splitting = operation === 'split';
    await menu(page, splitting ? 'Split PDF…' : 'Extract pages…');
    const dialog = page.getByRole('dialog', { name: splitting ? 'Split PDF' : 'Extract pages' });
    const downloads = [];
    page.on('download', (download) => downloads.push(download));
    await dialog
      .getByRole('button', { name: splitting ? 'Download ZIP' : 'Download pages', exact: true })
      .click();
    // Splitting closes its options dialog before copying; extraction keeps it open for retry.
    await expect(splitting ? page.locator('#toast') : dialog.getByRole('alert')).toContainText(
      'could not be flattened safely',
    );
    expect(downloads).toHaveLength(0);
    if (!splitting) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
    await expect(page.locator('.save-status')).toHaveText('Local file');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    expect(
      saved
        .getForm()
        .getFields()
        .map((field) => field.getName()),
    ).toEqual(['Signature']);
    expect(saved.getPage(0).node.Annots().size()).toBe(1);
    if (!splitting) {
      await menu(page, 'Extract pages…');
      await dialog.getByLabel('Page range', { exact: true }).fill('2');
      const output = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download pages', exact: true }).click();
      const safe = await PDFDocument.load(await readFile(await (await output).path()));
      expect(safe.getPageCount()).toBe(1);
      expect(safe.getPage(0).getWidth()).toBe(450);
      expect(safe.getForm().getFields()).toHaveLength(0);
    }
  });

test('pages extracted from a PDF with a long name keep their page numbers in the file name', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([300, 400]);
  const stem = 'A longitudinal study of sleep and shift work among hospital workers '.repeat(3);
  await openPdf(page, doc, `${stem}.pdf`);
  let pending = page.waitForEvent('download');
  await extractOtherPage(page);
  const single = (await pending).suggestedFilename();
  expect(single).toMatch(/ page 2\.pdf$/);
  expect(new TextEncoder().encode(single).length).toBeLessThan(255);
  pending = page.waitForEvent('download');
  await menu(page, 'Extract pages…');
  const dialog = page.getByRole('dialog', { name: 'Extract pages', exact: true });
  await dialog.getByRole('button', { name: 'Download pages', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/ pages? [\d,– -]+\.pdf$/);
});

test('Batch process keeps the password of the open PDF on its processed copy', async ({ page }) => {
  const { unlockPdf } = await import('../../src/core/security.js');
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  await openPdf(page, doc);
  await protectForSplit(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Batch process', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Batch process' });
  await dialog.getByLabel('Rotate all pages').check();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  const bytes = new Uint8Array(await readFile(await (await pending).path()));
  await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypt/i);
  const unlocked = await PDFDocument.load((await unlockPdf(bytes, 'split-secret')).bytes);
  expect(unlocked.getPage(0).getRotation().angle).toBe(90);
});
