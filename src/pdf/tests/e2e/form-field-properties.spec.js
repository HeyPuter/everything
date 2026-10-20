import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
async function openPdf(page, doc, name = 'form.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
  await settled(page);
}
async function downloaded(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return new Uint8Array(await readFile(await (await pending).path()));
}
async function prepareForm(page) {
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Prepare a form', exact: true }).click();
}
const designer = (page, key) => page.locator(`.designer-field[data-key="${key}"]`);
/** Open a field's properties, change only its tooltip, and save. */
async function retitle(page, target, dialogName, tooltip) {
  await target.dblclick();
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.getByLabel('Tooltip (read to screen reader users)').fill(tooltip);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
}

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
});

test('saving a field’s properties keeps what was filled in and its export values', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 500]);
  const form = doc.getForm();
  const text = form.createTextField('Customer');
  text.addToPage(sheet, { x: 40, y: 420, width: 200, height: 24 });
  text.setText('Ada Lovelace');
  const box = form.createCheckBox('Agree');
  box.addToPage(sheet, { x: 40, y: 380, width: 16, height: 16 });
  box.check();
  const size = form.createRadioGroup('Size');
  size.addOptionToPage('Small', sheet, { x: 40, y: 340, width: 16, height: 16 });
  size.addOptionToPage('Large', sheet, { x: 80, y: 340, width: 16, height: 16 });
  size.select('Small');
  size.acroField.dict.set(PDFName.of('DV'), PDFName.of('Small'));
  // A dropdown whose options export codes rather than their labels.
  const country = form.createDropdown('Country');
  country.addToPage(sheet, { x: 40, y: 290, width: 200, height: 24 });
  country.acroField.dict.set(
    PDFName.of('Opt'),
    doc.context.obj([
      [PDFString.of('US'), PDFString.of('United States')],
      [PDFString.of('FR'), PDFString.of('France')],
    ]),
  );
  country.acroField.dict.set(PDFName.of('V'), PDFString.of('FR'));
  await openPdf(page, doc);
  await prepareForm(page);
  await retitle(page, designer(page, 'Customer#0'), 'Text field properties', 'Full name');
  await retitle(page, designer(page, 'Agree#0'), 'Check box properties', 'I agree');
  await retitle(page, designer(page, 'Size#1'), 'Radio button properties', 'Pick a size');
  await retitle(page, designer(page, 'Country#0'), 'Dropdown properties', 'Country of residence');
  const saved = (await PDFDocument.load(await downloaded(page))).getForm();
  expect(saved.getTextField('Customer').getText()).toBe('Ada Lovelace');
  expect(saved.getCheckBox('Agree').isChecked()).toBe(true);
  const sizes = saved.getRadioGroup('Size');
  expect(sizes.getSelected()).toBe('Small');
  expect(sizes.acroField.dict.lookup(PDFName.of('DV'))).toBe(PDFName.of('Small'));
  const countries = saved.getDropdown('Country');
  expect(countries.acroField.getOptions().map(({ value }) => value.decodeText())).toEqual([
    'US',
    'FR',
  ]);
  expect(countries.acroField.dict.lookup(PDFName.of('V')).decodeText()).toBe('FR');
  expect(countries.acroField.dict.lookup(PDFName.of('TU')).decodeText()).toBe(
    'Country of residence',
  );
});
