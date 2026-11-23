import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

test('a filled-in amount shows formatted while another field has the focus', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const form = doc.getForm();
  const amount = form.createTextField('Amount');
  amount.addToPage(sheet, { x: 40, y: 300, width: 200, height: 24 });
  amount.acroField.dict.set(
    PDFName.of('AA'),
    doc.context.obj({
      F: { S: 'JavaScript', JS: PDFString.of('AFNumber_Format(2, 0, 0, 0, "$", true);') },
    }),
  );
  form.createTextField('Note').addToPage(sheet, { x: 40, y: 240, width: 200, height: 24 });
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
  const shown = input.locator('..').locator('.form-shown');
  await input.fill('1234.5');
  // While typing, the value as typed.
  await expect(shown).toBeHidden();
  await input.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Note (on page)', exact: true })).toBeFocused();
  await expect(shown).toBeVisible();
  await expect(shown).toHaveText('$1,234.50');
  await expect(input).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  // The value itself stays as typed, and shows so again when the field has the focus.
  await expect(input).toHaveValue('1234.5');
  await input.focus();
  await expect(shown).toBeHidden();
  // Text that is no number shows as typed.
  await input.fill('twelve');
  await input.press('Tab');
  await expect(shown).toBeHidden();
});

test('a total shows what the fields filled in so far work out to, before the form is saved', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('Qty').addToPage(sheet, { x: 40, y: 300, width: 200, height: 24 });
  form.createTextField('Price').addToPage(sheet, { x: 40, y: 260, width: 200, height: 24 });
  const total = form.createTextField('Total');
  total.addToPage(sheet, { x: 40, y: 220, width: 200, height: 24 });
  total.enableReadOnly();
  const js = (script) => ({ S: 'JavaScript', JS: PDFString.of(script) });
  total.acroField.dict.set(
    PDFName.of('AA'),
    doc.context.obj({
      C: js('/*** BVCALC Qty * Price EVCALC ***/ event.value = 0;'),
      F: js('AFNumber_Format(2, 0, 0, 0, "$", true);'),
    }),
  );
  form.acroForm.dict.set(PDFName.of('CO'), doc.context.obj([total.ref]));
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const totalField = page.getByRole('textbox', {
    name: 'Total (on page) (read only)',
    exact: true,
  });
  const shown = totalField.locator('..').locator('.form-shown');
  await page.getByRole('textbox', { name: 'Qty (on page)', exact: true }).fill('3');
  await expect(shown).toHaveText('$0.00');
  await page.getByRole('textbox', { name: 'Price (on page)', exact: true }).fill('12.5');
  await expect(shown).toBeVisible();
  await expect(shown).toHaveText('$37.50');
  // The field holds the total shown, for a screen reader to read, as it will once saved.
  await expect(totalField).toHaveValue('37.5');
  // Escape takes the price back out, and the total with it.
  await page.keyboard.press('Escape');
  await expect(shown).toHaveText('$0.00');
  await expect(totalField).toHaveValue('0');
  await page.getByRole('textbox', { name: 'Price (on page)', exact: true }).fill('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // Saved, the page draws the total itself.
  await expect(shown).toBeHidden();
  await expect(
    page.getByRole('textbox', { name: 'Total (on page) (read only)', exact: true }),
  ).toHaveValue('6');
});
