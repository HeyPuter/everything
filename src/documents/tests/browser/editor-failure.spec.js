import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';

const fileButton = page => page.getByRole('button', { name: 'File', exact: true });

// A file that is not a DOCX archive cannot open.
async function openTextImport(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'damaged.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not a zip') });
}

test('a document that cannot open keeps the header and offers ways forward', async ({ page }) => {
  await openTextImport(page);
  const message = page.locator('.canvas-message.editor-error');
  await expect(message).toBeVisible();
  for (const name of ['Back to documents', 'New document']) await expect(message.getByRole('button', { name, exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Back to documents', exact: true }).first()).toBeVisible();
  await expect(fileButton(page)).toBeVisible();
  await expect(page.locator('.ribbon-card')).toBeHidden();
  // The message does not cover the header: its top is below it.
  const header = await page.locator('.canvas-header').boundingBox(), box = await message.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  await message.getByRole('button', { name: 'New document', exact: true }).click();
  // The unopened import is unsaved, so leaving it asks first, as any navigation does.
  await page.locator('.modal-root:not(.closing)').getByRole('button', { name: 'Leave without saving', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue('');

  await openTextImport(page);
  await expect(message).toBeVisible();
  await message.getByRole('button', { name: 'Back to documents', exact: true }).click();
  await page.locator('.modal-root:not(.closing)').getByRole('button', { name: 'Leave without saving', exact: true }).click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
});

test('a damaged file keeps its original available beside the navigation', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'broken.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not a zip') });
  const message = page.locator('.canvas-message.editor-error');
  await expect(message).toContainText('Could not read this DOCX archive');
  const download = page.waitForEvent('download');
  await message.getByRole('button', { name: 'Download original', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('broken.docx');
  await expect(fileButton(page)).toBeVisible();
});

// A macro-enabled document opens read-only, and its download is the file as it was. Named Budget.docx, Word refused
// it: a package whose main part is macro-enabled must keep the .docm extension (and a template its .dotx).
function macroEnabledDocument() {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Macro text</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  };
  const parts = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]));
  parts['word/vbaProject.bin'] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
  return Buffer.from(zipSync(parts));
}

test('a read-only macro-enabled document downloads under its own extension', async ({ page }) => {
  const buffer = macroEnabledDocument();
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  // Saved to this device without a name of its kind (the download of an e-mail attachment, say).
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'Budget', mimeType: 'application/octet-stream', buffer });
  await expect(page.getByText('Read only').first()).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.keyboard.press('Meta+s');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Budget.docm');
  expect(readFileSync(await download.path()).equals(buffer)).toBe(true);
});

// Save As writes a read-only document's own bytes: a macro-enabled package keeps .docm, as its download does.
test('Save As of a read-only macro-enabled document keeps its .docm extension', async ({ page }) => {
  const buffer = macroEnabledDocument();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'Budget', mimeType: 'application/octet-stream', buffer });
  await expect(page.getByText('Read only').first()).toBeVisible();
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'File' });
  await view.getByRole('tab', { name: 'Save' }).click();
  await view.getByRole('textbox', { name: 'New file name' }).fill('Budget kept');
  await view.getByRole('button', { name: 'Save As', exact: true }).click();
  await expect(view.getByRole('status')).toHaveText('Saved. You are now editing the copy.');
  const drive = await page.evaluate(() => Object.fromEntries(Object.entries(JSON.parse(sessionStorage.getItem('documents-mock-state')).fs).map(([k, f]) => [k, f.b64])));
  expect(Object.keys(drive)).toEqual(['Documents/Budget kept.docm']);
  expect(Buffer.from(drive['Documents/Budget kept.docm'], 'base64').equals(buffer)).toBe(true);
});

// A package picked under "All files" that is not a Word document (an OpenDocument text, here) cannot open, and its
// original was offered as Minutes.docx: the file it is keeps its own name.
test('the original of a file that cannot open keeps its own name', async ({ page }) => {
  const odt = Buffer.from(zipSync({ mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }], 'content.xml': strToU8('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>') }));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'Minutes.odt', mimeType: 'application/vnd.oasis.opendocument.text', buffer: odt });
  const message = page.locator('.canvas-message.editor-error');
  await expect(message).toBeVisible();
  const downloading = page.waitForEvent('download');
  await message.getByRole('button', { name: 'Download original', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Minutes.odt');
  expect(readFileSync(await download.path()).equals(odt)).toBe(true);
});
