import { test, expect } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';

/** A form with a text field and its own Clear and Print buttons. */
async function formWithButtons() {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('Name').addToPage(sheet, { x: 40, y: 320, width: 200, height: 24 });
  const actions = { Clear: { S: 'ResetForm' }, Print: { S: 'Named', N: 'Print' } };
  for (const [i, [label, action]] of Object.entries(actions).entries()) {
    const button = form.createButton(label);
    button.addToPage(label, sheet, { x: 40 + 100 * i, y: 260, width: 80, height: 24 });
    button.acroField.getWidgets()[0].dict.set(PDFName.of('A'), doc.context.obj(action));
  }
  return doc.save();
}

test('a form’s own Clear and Print buttons reset its fields and print it', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'buttons.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await formWithButtons()),
  });
  const settled = () => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await settled();
  const name = page.getByRole('textbox', { name: 'Name (on page)', exact: true });
  await name.fill('Ada');
  await name.press('Enter');
  await settled();
  const clear = page.getByRole('button', { name: 'Clear (on page)', exact: true });
  // The PDF's own drawing of the button shows, also with the focus on it.
  await clear.focus();
  await expect(clear).toHaveCSS('opacity', '0');
  await clear.press('Enter');
  await settled();
  await expect(name).toHaveValue('');
  // A reset is one step to undo.
  await page.keyboard.press('ControlOrMeta+z');
  await settled();
  await expect(name).toHaveValue('Ada');
  await page.getByRole('button', { name: 'Print (on page)', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Print' })).toBeVisible();
});

test('a click on an empty signature field signs it, and on a signed one shows its signature', async ({
  page,
}) => {
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
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'sign.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  const settled = () => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await settled();
  const signature = page.getByRole('button', {
    name: 'Approver: signature field (on page)',
    exact: true,
  });
  await signature.click();
  const ids = page.getByRole('dialog', { name: 'Choose a digital ID' });
  await ids.getByLabel('Create a new digital ID').check();
  await ids.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await ids.getByLabel('Password for the ID file').fill('secret-123');
  await ids.getByLabel('Confirm password').fill('secret-123');
  await ids.getByRole('button', { name: 'Continue' }).click();
  await page
    .getByRole('dialog', { name: 'Sign with a certificate' })
    .getByRole('button', { name: 'Sign', exact: true })
    .click();
  await settled();
  await expect(page.locator('.signature-bar')).toContainText('Signed');
  await expect(page.locator('#sidebar-panel-signatures')).toBeHidden();
  await signature.click();
  await expect(page.locator('#sidebar-panel-signatures')).toBeVisible();
  await expect(page.locator('#sidebar-panel-signatures')).toContainText('Ada Lovelace');
});
