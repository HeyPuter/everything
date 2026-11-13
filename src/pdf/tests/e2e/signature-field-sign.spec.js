import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFHexString } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

/** A form as other tools leave it: an empty signature field on a 400 × 400 page. */
async function formWithSignatureField() {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const field = doc.context.obj({
    FT: 'Sig',
    T: PDFHexString.fromText('Approver'),
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: [40, 100, 240, 140],
    F: 4,
    P: sheet.ref,
  });
  const ref = doc.context.register(field);
  doc.getForm().acroForm.addField(ref);
  sheet.node.addAnnot(ref);
  return doc.save();
}

async function startSigning(page) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'form.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await formWithSignatureField()),
  });
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Use a certificate', exact: true }).click();
  await pane.getByRole('button', { name: /Digitally sign/ }).click();
}

async function finishSigning(page) {
  const chooser = page.getByRole('dialog', { name: 'Choose a digital ID' });
  await chooser.getByLabel('Create a new digital ID').check();
  await chooser.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await chooser.getByLabel('Password for the ID file').fill('secret-123');
  await chooser.getByRole('button', { name: 'Continue' }).click();
  const details = page.getByRole('dialog', { name: 'Sign with a certificate' });
  await details.getByRole('button', { name: 'Sign', exact: true }).click();
  await settled(page);
  await expect(page.locator('.signature-bar')).toContainText('Signed');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const { listSignatureFields } = await import('../../src/core/digital-signature.js');
  return listSignatureFields(new Uint8Array(await readFile(await (await pending).path())));
}

test('a click on an empty signature field signs that field', async ({ page }) => {
  await startSigning(page);
  // The middle of the field, at (140, 120) on the page.
  const box = await page.locator('.drawing-overlay').boundingBox();
  await page.mouse.click(box.x + (140 / 400) * box.width, box.y + (280 / 400) * box.height);
  const fields = await finishSigning(page);
  expect(fields.map(({ name, signed, page }) => ({ name, signed, page }))).toEqual([
    { name: 'Approver', signed: true, page: 0 },
  ]);
});

test('Place at page center signs the page’s empty signature field', async ({ page }) => {
  await startSigning(page);
  await page.getByRole('button', { name: 'Place at page center' }).click();
  const fields = await finishSigning(page);
  expect(fields.map(({ name, signed }) => ({ name, signed }))).toEqual([
    { name: 'Approver', signed: true },
  ]);
});
