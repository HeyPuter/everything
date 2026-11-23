import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

// Fields that take digits alone (Acrobat's ZIP Code, phone and Social Security number formats)
// brought up a phone's letter keyboard.
test('fields that take digits bring up a phone’s number pad', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const form = doc.getForm();
  const fields = [
    ['Zip', 'AFSpecial_Format(0);'],
    ['Phone', 'AFSpecial_Format(2);'],
    ['SSN', 'AFSpecial_Format(3);'],
    ['Amount', 'AFNumber_Format(2, 0, 0, 0, "$", true);'],
    ['Name', null],
  ];
  fields.forEach(([name, script], i) => {
    const field = form.createTextField(name);
    field.addToPage(sheet, { x: 40, y: 340 - i * 40, width: 200, height: 24 });
    if (script)
      field.acroField.dict.set(
        PDFName.of('AA'),
        doc.context.obj({ F: { S: 'JavaScript', JS: PDFString.of(script) } }),
      );
  });
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'digits.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  const box = (name) => page.getByRole('textbox', { name: `${name} (on page)`, exact: true });
  await expect(box('Zip')).toHaveAttribute('inputmode', 'numeric');
  await expect(box('Phone')).toHaveAttribute('inputmode', 'tel');
  await expect(box('SSN')).toHaveAttribute('inputmode', 'numeric');
  // A number pad has no minus sign, which amounts can need; other fields keep the keyboard.
  await expect(box('Amount')).not.toHaveAttribute('inputmode');
  await expect(box('Name')).not.toHaveAttribute('inputmode');
  // Typed digits still show in the format's pattern.
  await box('Phone').fill('5551234567');
  await box('Name').focus();
  await expect(page.locator('.form-shown').nth(1)).toHaveText('(555) 123-4567');
});
