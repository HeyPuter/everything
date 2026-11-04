import { test, expect } from '@playwright/test';
import { PDFDocument, PDFHexString } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
});
async function openPdf(page, doc) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'form.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
/** A signature field, as other tools leave it: an empty /Sig field with one widget. */
function addSignatureField(doc, sheet, name) {
  const field = doc.context.obj({
    FT: 'Sig',
    T: PDFHexString.fromText(name),
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: [40, 100, 240, 140],
    F: 4,
    P: sheet.ref,
  });
  const ref = doc.context.register(field);
  doc.getForm().acroForm.addField(ref);
  sheet.node.addAnnot(ref);
}

test('Fill forms leaves out push buttons and points signature fields to certificates', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('Name').addToPage(sheet, { x: 40, y: 300, width: 200, height: 24 });
  form.createButton('Print').addToPage('Print', sheet, { x: 40, y: 250, width: 80, height: 24 });
  addSignatureField(doc, sheet, 'Signature');
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Fill forms' });
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText('Print');
  await expect(dialog).toContainText(
    'Signature: a signature field. Sign it with Sign with a certificate.',
  );
});

test('Fill forms with nothing to fill in says so instead of opening', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  doc
    .getForm()
    .createButton('Print')
    .addToPage('Print', sheet, { x: 40, y: 250, width: 80, height: 24 });
  addSignatureField(doc, sheet, 'Signature');
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  await expect(page.getByText('This PDF has no fields to fill in.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Fill forms' })).toHaveCount(0);
});
