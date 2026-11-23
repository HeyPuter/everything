import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';

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
