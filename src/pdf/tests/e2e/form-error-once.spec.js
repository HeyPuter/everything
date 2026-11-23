import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

// A value a field refuses was said twice: above the page, next to the field it names, and
// again in a message over the page, so a screen reader read it out twice and on a phone the
// message covered the fields below.
test('a value a field refuses is reported once, above the page', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const amount = doc.getForm().createTextField('Amount');
  amount.addToPage(sheet, { x: 40, y: 300, width: 200, height: 24 });
  amount.acroField.dict.set(
    PDFName.of('AA'),
    doc.context.obj({
      F: { S: 'JavaScript', JS: PDFString.of('AFNumber_Format(2, 0, 0, 0, "$", true);') },
    }),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'amount.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const input = page.getByRole('textbox', { name: 'Amount (on page)', exact: true });
  await input.fill('twelve');
  await input.press('Enter');
  const message = 'Enter a number in Amount, such as 1234.5.';
  await expect(page.locator('.form-edit-error')).toHaveText(message);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toBeFocused();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByText(message)).toHaveCount(1);
  // A value it takes goes in as before.
  await input.fill('12');
  await input.press('Enter');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.form-edit-error')).toBeHidden();
  await expect(input).toHaveValue('12');
});
