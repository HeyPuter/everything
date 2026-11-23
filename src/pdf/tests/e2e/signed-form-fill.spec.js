import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFHexString } from 'pdf-lib';
import { createSelfSignedId, signPdf, verifySignatures } from '../../src/core/digital-signature.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

/** A form one person signed, with fields left for the next. */
async function signedForm(certify) {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('Note').addToPage(sheet, { x: 40, y: 300, width: 200, height: 24 });
  form.createCheckBox('Agree').addToPage(sheet, { x: 40, y: 250, width: 18, height: 18 });
  const id = await createSelfSignedId({ name: 'Grace Hopper', keyType: 'P-256' });
  return signPdf(await doc.save(), id, {
    page: 0,
    rect: { x: 40, y: 40, width: 200, height: 50 },
    certify,
  });
}

async function open(page, bytes) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await settled(page);
  await expect(page.locator('.signature-bar')).toContainText('valid');
}

// Filling in a signed form rewrote the whole file: the signature then showed as invalid, so
// nobody could fill in the fields a signer left for them.
for (const certify of [undefined, 2])
  test(`fields filled in after ${certify ? 'certifying' : 'signing'} keep the signature valid`, async ({
    page,
  }) => {
    const signed = await signedForm(certify);
    await open(page, signed);
    const note = page.getByRole('textbox', { name: 'Note (on page)' });
    await note.fill('Reviewed');
    await note.press('Enter');
    await settled(page);
    await page.getByRole('checkbox', { name: 'Agree (on page)' }).check();
    await page.getByRole('textbox', { name: 'Note (on page)' }).focus();
    await page.keyboard.press('Enter');
    await settled(page);
    // Nothing to warn about: the signature allows filling in.
    await expect(page.getByRole('dialog', { name: 'Edit a signed PDF?' })).toHaveCount(0);
    await expect(page.locator('.signature-bar')).toContainText('valid');
    await expect(page.locator('.signature-bar')).not.toContainText('changed');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await readFile(await (await pending).path());
    expect(Buffer.from(saved.subarray(0, signed.length)).equals(Buffer.from(signed))).toBe(true);
    const [report] = await verifySignatures(new Uint8Array(saved));
    expect(report.status).toBe('valid-unknown-identity');
    const form = (await PDFDocument.load(saved)).getForm();
    expect(form.getTextField('Note').getText()).toBe('Reviewed');
    expect(form.getCheckBox('Agree').isChecked()).toBe(true);
    // Undo takes the value back out.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await settled(page);
    await expect(page.getByRole('checkbox', { name: 'Agree (on page)' })).not.toBeChecked();
    await expect(page.locator('.signature-bar')).toContainText('valid');
  });

// A certification that allows no changes still asks first, and says what filling in does.
test('filling in a PDF certified against changes asks first', async ({ page }) => {
  await open(page, await signedForm(1));
  const note = page.getByRole('textbox', { name: 'Note (on page)' });
  await note.fill('Reviewed');
  await note.press('Enter');
  const ask = page.getByRole('dialog', { name: 'Edit a signed PDF?' });
  await expect(ask).toContainText('does not allow this field to change');
  await ask.getByRole('button', { name: 'Edit anyway' }).click();
  await settled(page);
  await expect(page.locator('.signature-bar')).toContainText('changed after it was signed');
});

// A field the signature locks still asks first; another field fills in without asking.
test('filling in a field a signature locks asks first', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('Note').addToPage(sheet, { x: 40, y: 300, width: 200, height: 24 });
  form.createTextField('Total').addToPage(sheet, { x: 40, y: 250, width: 200, height: 24 });
  const field = doc.context.obj({
    FT: 'Sig',
    T: PDFHexString.fromText('Approver'),
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: [40, 40, 240, 90],
    F: 4,
    P: sheet.ref,
    Lock: { Type: 'SigFieldLock', Action: 'Include', Fields: [PDFHexString.fromText('Total')] },
  });
  const ref = doc.context.register(field);
  form.acroForm.addField(ref);
  sheet.node.addAnnot(ref);
  const id = await createSelfSignedId({ name: 'Grace Hopper', keyType: 'P-256' });
  await open(page, await signPdf(await doc.save(), id, { fieldName: 'Approver' }));
  const note = page.getByRole('textbox', { name: 'Note (on page)' });
  await note.fill('Reviewed');
  await note.press('Enter');
  await settled(page);
  const ask = page.getByRole('dialog', { name: 'Edit a signed PDF?' });
  await expect(ask).toHaveCount(0);
  const total = page.getByRole('textbox', { name: 'Total (on page)' });
  await total.fill('12');
  await total.press('Enter');
  await expect(ask).toContainText('does not allow this field to change');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(total).toHaveValue('12');
  await expect(page.locator('.signature-bar')).not.toContainText('changed');
});
