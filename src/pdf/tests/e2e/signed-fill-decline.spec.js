import { test, expect } from '@playwright/test';
import { PDFDocument, PDFHexString } from 'pdf-lib';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

/** A form with a text field and an empty signature field. */
async function form() {
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
  doc.getForm().createTextField('Note').addToPage(sheet, { x: 40, y: 300, width: 200, height: 24 });
  return doc.save();
}

// Declining "Edit a signed PDF?" left the words typed in the field, taken for saved: the PDF
// did not have them, and the next Undo took the signature away instead. A field filled in
// after signing keeps the signature valid (signed-form-fill.spec.js); a certification that
// allows no changes still asks first.
test('declining to edit a signed PDF keeps the typed words as a draft', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await form()) });
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Use a certificate', exact: true }).click();
  await pane.getByRole('button', { name: /Certify/ }).click();
  const ids = page.getByRole('dialog', { name: 'Choose a digital ID' });
  await ids.getByLabel('Create a new digital ID').check();
  await ids.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await ids.getByLabel('Password for the ID file').fill('secret-123');
  await ids.getByRole('button', { name: 'Continue' }).click();
  const details = page.getByRole('dialog', { name: 'Certify document' });
  await details
    .getByLabel('Changes allowed after certifying')
    .selectOption({ label: 'No changes' });
  await details.getByRole('button', { name: 'Certify', exact: true }).click();
  // The signing ends by settling the page's drafts (the Select tool is chosen again) after the
  // page is no longer busy; its message comes last. A field filled before then is that draft.
  await expect(
    page.getByText('Certified. Download or save the PDF to keep the certification.'),
  ).toBeVisible();
  await settled(page);
  const bar = page.locator('.signature-bar');
  await expect(bar).toContainText('Certified');
  const note = page.getByRole('textbox', { name: 'Note (on page)' });
  await note.fill('After signing');
  await note.press('Enter');
  const ask = page.getByRole('dialog', { name: 'Edit a signed PDF?' });
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  await expect(note).toHaveValue('After signing');
  // Still a change to make, not one taken for made.
  const widget = note.locator('xpath=..');
  await expect(widget).toHaveClass(/has-draft/);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  await expect(note).toHaveValue('');
  await settled(page);
  await expect(widget).not.toHaveClass(/has-draft/);
  // The certification is still there.
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Certified');
});
