import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

test('fields on the page are named by their tooltips, or by their names without one', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 400]);
  const form = doc.getForm();
  const first = form.createTextField('topmostSubform[0].f1_01[0]');
  first.addToPage(sheet, { x: 40, y: 320, width: 200, height: 24 });
  first.acroField.dict.set(PDFName.of('TU'), PDFString.of('Your first name'));
  const size = form.createRadioGroup('Size');
  size.addOptionToPage('Small', sheet, { x: 40, y: 240, width: 16, height: 16 });
  size.addOptionToPage('Large', sheet, { x: 80, y: 240, width: 16, height: 16 });
  size.acroField.dict.set(PDFName.of('TU'), PDFString.of('Shirt size'));
  form.createCheckBox('Agree').addToPage(sheet, { x: 40, y: 280, width: 16, height: 16 });
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({
    name: 'tooltips.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const named = page.getByRole('textbox', { name: 'Your first name (on page)', exact: true });
  await expect(named).toBeVisible();
  await expect(named).toHaveAttribute('title', 'Your first name');
  await expect(page.getByRole('checkbox', { name: 'Agree (on page)', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Shirt size: Large (on page)' })).toBeVisible();
  await named.fill('Ada');
  await named.press('Tab');
  await expect(named).toHaveValue('Ada');
});

test('the Fill forms dialog labels fields by their tooltips too', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 400]);
  const form = doc.getForm();
  const first = form.createTextField('topmostSubform[0].f1_01[0]');
  first.addToPage(sheet, { x: 40, y: 320, width: 200, height: 24 });
  first.acroField.dict.set(PDFName.of('TU'), PDFString.of('Your first name'));
  form.createCheckBox('Agree').addToPage(sheet, { x: 40, y: 280, width: 16, height: 16 });
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({
    name: 'tooltips.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Fill forms' });
  await dialog.getByLabel('Your first name', { exact: true }).fill('Ada');
  await dialog.getByLabel('Agree', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Your first name (on page)', exact: true }),
  ).toHaveValue('Ada');
});
