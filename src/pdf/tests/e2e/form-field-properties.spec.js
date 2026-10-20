import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
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

test('adding a dropdown option keeps the export values of the others', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 500]);
  const country = doc.getForm().createDropdown('Country');
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
  await designer(page, 'Country#0').dblclick();
  const dialog = page.getByRole('dialog', { name: 'Dropdown properties' });
  const options = dialog.getByLabel('Options, one per line');
  await expect(options).toHaveValue('United States\nFrance');
  await options.fill('United States\nFrance\nGermany');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  const saved = (await PDFDocument.load(await downloaded(page))).getForm().getDropdown('Country');
  expect(
    saved.acroField
      .getOptions()
      .map(({ value, display }) => [value.decodeText(), (display ?? value).decodeText()]),
  ).toEqual([
    ['US', 'United States'],
    ['FR', 'France'],
    ['Germany', 'Germany'],
  ]);
  expect(saved.acroField.dict.lookup(PDFName.of('V')).decodeText()).toBe('FR');
});

test('arrow keys move a field the way they point on a turned page', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 400]);
  sheet.setRotation(degrees(90));
  const note = doc.getForm().createTextField('Note');
  note.addToPage(sheet, { x: 100, y: 100, width: 120, height: 24 });
  const start = note.acroField.getWidgets()[0].getRectangle();
  await openPdf(page, doc);
  await prepareForm(page);
  const field = designer(page, 'Note#0');
  const before = await field.boundingBox();
  await field.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await settled(page);
  await designer(page, 'Note#0').focus();
  await page.keyboard.press('Shift+ArrowUp');
  await settled(page);
  const after = await designer(page, 'Note#0').boundingBox();
  expect(after.x).toBeGreaterThan(before.x + 5);
  expect(after.y).toBeLessThan(before.y - 5);
  const saved = (await PDFDocument.load(await downloaded(page))).getForm().getTextField('Note');
  const rect = saved.acroField.getWidgets()[0].getRectangle();
  // Turned a quarter clockwise: screen right is +y on the page, screen up is -x.
  expect(rect).toEqual({ ...start, x: start.x - 10, y: start.y + 10 });
});

test('a field nudged with the arrow keys keeps the keyboard focus', async ({ page }) => {
  const doc = await PDFDocument.create();
  const note = doc.getForm().createTextField('Note');
  note.addToPage(doc.addPage([600, 400]), { x: 100, y: 100, width: 120, height: 24 });
  const start = note.acroField.getWidgets()[0].getRectangle();
  await openPdf(page, doc);
  await prepareForm(page);
  await designer(page, 'Note#0').focus();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+ArrowRight');
    await settled(page);
    await expect(designer(page, 'Note#0')).toBeFocused();
  }
  const saved = (await PDFDocument.load(await downloaded(page))).getForm().getTextField('Note');
  expect(saved.acroField.getWidgets()[0].getRectangle()).toEqual({ ...start, x: start.x + 30 });
});

test('Tab order by rows or by columns is the order Tab follows on the page', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 500]);
  // Added bottom right first: a two-by-two grid.
  for (const [name, x, y] of [
    ['D', 300, 300],
    ['B', 300, 400],
    ['C', 40, 302],
    ['A', 40, 398],
  ])
    doc.getForm().createTextField(name).addToPage(sheet, { x, y, width: 150, height: 24 });
  await openPdf(page, doc);
  await prepareForm(page);
  const pane = page.getByRole('complementary', { name: 'Tools' });
  const visited = async () => {
    await pane.getByRole('button', { name: 'Back to all tools' }).click();
    await settled(page);
    const order = [];
    await page.getByRole('textbox', { name: 'A (on page)' }).focus();
    for (let i = 0; i < 4; i++) {
      order.push(await page.evaluate(() => document.activeElement.getAttribute('aria-label')));
      await page.keyboard.press('Tab');
    }
    return order.map((label) => label.replace(' (on page)', ''));
  };
  await pane.getByRole('button', { name: 'Tab order: by rows' }).click();
  await settled(page);
  expect(await visited()).toEqual(['A', 'B', 'C', 'D']);
  await prepareForm(page);
  await pane.getByRole('button', { name: 'Tab order: by columns' }).click();
  await settled(page);
  expect(await visited()).toEqual(['A', 'C', 'B', 'D']);
});

test('the buttons of a radio group are told apart by their export values', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 500]);
  const size = doc.getForm().createRadioGroup('Size');
  size.addOptionToPage('Small', sheet, { x: 40, y: 340, width: 16, height: 16 });
  size.addOptionToPage('Large', sheet, { x: 80, y: 340, width: 16, height: 16 });
  await openPdf(page, doc);
  await prepareForm(page);
  await expect(
    page.getByRole('button', { name: 'Radio button Size: Small', exact: true }),
  ).toHaveAttribute('data-key', 'Size#0');
  await expect(
    page.getByRole('button', { name: 'Radio button Size: Large', exact: true }),
  ).toHaveAttribute('data-key', 'Size#1');
});

test('the keyboard focus stays on the fields after editing or deleting one', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 400]);
  for (const [name, y] of [
    ['Note', 100],
    ['Other', 200],
  ])
    doc.getForm().createTextField(name).addToPage(sheet, { x: 100, y, width: 120, height: 24 });
  await openPdf(page, doc);
  await prepareForm(page);
  await designer(page, 'Note#0').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Text field properties' });
  await dialog.getByLabel('Tooltip (read to screen reader users)').fill('A short note');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(designer(page, 'Note#0')).toBeFocused();
  await page.keyboard.press('Delete');
  await settled(page);
  await expect(designer(page, 'Note#0')).toHaveCount(0);
  await expect(designer(page, 'Other#0')).toBeFocused();
});

test('a field renamed from the keyboard keeps the focus', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc
    .getForm()
    .createTextField('Note')
    .addToPage(doc.addPage([600, 400]), { x: 100, y: 100, width: 120, height: 24 });
  await openPdf(page, doc);
  await prepareForm(page);
  await designer(page, 'Note#0').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Text field properties' });
  await dialog.getByLabel('Name', { exact: true }).fill('Remark');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(designer(page, 'Remark#0')).toBeFocused();
  await expect(designer(page, 'Remark#0')).toHaveAttribute('aria-pressed', 'true');
});
