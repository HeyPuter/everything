import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib';
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

test('Alt with an arrow key turns the page without moving the field in focus', async ({ page }) => {
  const doc = await PDFDocument.create();
  const note = doc.getForm().createTextField('Note');
  note.addToPage(doc.addPage([600, 400]), { x: 100, y: 100, width: 120, height: 24 });
  doc.addPage([600, 400]);
  const start = note.acroField.getWidgets()[0].getRectangle();
  await openPdf(page, doc);
  await prepareForm(page);
  await designer(page, 'Note#0').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  const saved = (await PDFDocument.load(await downloaded(page))).getForm().getTextField('Note');
  expect(saved.acroField.getWidgets()[0].getRectangle()).toEqual(start);
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

test('a radio button named after another radio group joins that group', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 500]);
  const size = doc.getForm().createRadioGroup('Size');
  size.addOptionToPage('Small', sheet, { x: 40, y: 340, width: 16, height: 16 });
  size.addOptionToPage('Large', sheet, { x: 80, y: 340, width: 16, height: 16 });
  size.select('Large');
  doc
    .getForm()
    .createRadioGroup('Extra')
    .addOptionToPage('Medium', sheet, { x: 120, y: 340, width: 16, height: 16 });
  await openPdf(page, doc);
  await prepareForm(page);
  await designer(page, 'Extra#0').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Radio button properties' });
  await dialog.getByLabel('Name', { exact: true }).fill('Size');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(page.locator('.designer-field')).toHaveCount(3);
  await expect(designer(page, 'Size#2')).toBeFocused();
  await expect(designer(page, 'Size#2')).toHaveAccessibleName('Radio button Size: Medium');
  const saved = await PDFDocument.load(await downloaded(page));
  const form = saved.getForm();
  expect(form.getFields().map((field) => field.getName())).toEqual(['Size']);
  expect(form.getRadioGroup('Size').getOptions()).toEqual(['Small', 'Large', 'Medium']);
  expect(form.getRadioGroup('Size').getSelected()).toBe('Large');
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

test('a field dragged or nudged past the edge stops at the edge of the page', async ({ page }) => {
  const doc = await PDFDocument.create();
  const note = doc.getForm().createTextField('Note');
  note.addToPage(doc.addPage([600, 400]), { x: 100, y: 300, width: 120, height: 24 });
  const start = note.acroField.getWidgets()[0].getRectangle();
  await openPdf(page, doc);
  await prepareForm(page);
  const paper = await page.locator('.form-designer').boundingBox();
  const box = await designer(page, 'Note#0').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x - 400, box.y - 400, { steps: 5 });
  await page.mouse.up();
  await settled(page);
  const dropped = await designer(page, 'Note#0').boundingBox();
  expect(dropped.x).toBeCloseTo(paper.x, 0);
  expect(dropped.y).toBeCloseTo(paper.y, 0);
  let saved = (await PDFDocument.load(await downloaded(page))).getForm().getTextField('Note');
  let rect = saved.acroField.getWidgets()[0].getRectangle();
  expect(rect.x).toBeCloseTo(0, 1);
  expect(rect.y + rect.height).toBeCloseTo(400, 1);
  expect(rect.width).toBeCloseTo(start.width, 1);
  // At the edge, the arrow keys do not push it any further.
  await designer(page, 'Note#0').focus();
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowLeft');
  await settled(page);
  saved = (await PDFDocument.load(await downloaded(page))).getForm().getTextField('Note');
  const nudged = saved.acroField.getWidgets()[0].getRectangle();
  expect(nudged.x).toBeCloseTo(rect.x, 1);
  expect(nudged.y).toBeCloseTo(rect.y, 1);
});

test('asking to detect fields again while they are found opens one list', async ({ page }) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 300; i++) {
    const sheet = doc.addPage([600, 800]);
    for (let row = 0; row < 10; row++)
      sheet.drawText(`Item ${row}: ____________`, { x: 40, y: 700 - row * 40, size: 12, font });
  }
  await openPdf(page, doc);
  await prepareForm(page);
  await settled(page);
  // The second request comes while the pages of the first are still being read.
  await page.evaluate(async () => {
    const detect = document.querySelector('[aria-label="Detect form fields…"]');
    detect.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    detect.click();
  });
  await expect(page.getByRole('dialog', { name: 'Fields found' })).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
});

test('saving a field’s properties unchanged records no edit', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc
    .getForm()
    .createTextField('Note')
    .addToPage(doc.addPage([600, 400]), { x: 100, y: 100, width: 120, height: 24 });
  await openPdf(page, doc);
  await prepareForm(page);
  await designer(page, 'Note#0').dblclick();
  const dialog = page.getByRole('dialog', { name: 'Text field properties' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
});

test('Done on a new field keeps what was set for it', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([600, 400]);
  await openPdf(page, doc);
  await prepareForm(page);
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Text field', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center' }).click();
  const dialog = page.getByRole('dialog', { name: 'Text field properties' });
  await dialog.getByLabel('Name', { exact: true }).fill('Full name');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(designer(page, 'Full name#0')).toBeVisible();
  const saved = (await PDFDocument.load(await downloaded(page))).getForm();
  expect(saved.getFields().map((field) => field.getName())).toEqual(['Full name']);
});

test('deleting a field from its properties keeps the focus on the fields', async ({ page }) => {
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
  await dialog.getByRole('button', { name: 'Delete field' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await settled(page);
  await expect(designer(page, 'Note#0')).toHaveCount(0);
  await expect(designer(page, 'Other#0')).toBeFocused();
});

test('deleting a radio button hands the focus to the next button of its group', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 500]);
  const size = doc.getForm().createRadioGroup('Size');
  size.addOptionToPage('Small', sheet, { x: 40, y: 340, width: 16, height: 16 });
  size.addOptionToPage('Large', sheet, { x: 80, y: 340, width: 16, height: 16 });
  await openPdf(page, doc);
  await prepareForm(page);
  await designer(page, 'Size#0').focus();
  await page.keyboard.press('Delete');
  await settled(page);
  await expect(page.locator('.designer-field')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Radio button Size: Large' })).toBeFocused();
});

test('the fields listed in the tools pane tell the buttons of a radio group apart', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 500]);
  const size = doc.getForm().createRadioGroup('Size');
  size.addOptionToPage('Small', sheet, { x: 40, y: 340, width: 16, height: 16 });
  size.addOptionToPage('Large', sheet, { x: 80, y: 340, width: 16, height: 16 });
  await openPdf(page, doc);
  await prepareForm(page);
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await expect(pane.getByRole('button', { name: /^Size: Small/ })).toBeVisible();
  await pane.getByRole('button', { name: /^Size: Large/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Radio button properties' });
  await expect(dialog.getByLabel('Export value')).toHaveValue('Large');
});

test('choosing a fill or border color for a field without one applies it', async ({ page }) => {
  const doc = await PDFDocument.create();
  const note = doc.getForm().createTextField('Note');
  note.addToPage(doc.addPage([600, 400]), {
    x: 100,
    y: 100,
    width: 120,
    height: 24,
    borderColor: undefined,
    backgroundColor: undefined,
  });
  await openPdf(page, doc);
  await prepareForm(page);
  await designer(page, 'Note#0').dblclick();
  const dialog = page.getByRole('dialog', { name: 'Text field properties' });
  await expect(dialog.getByLabel('No fill')).toBeChecked();
  await expect(dialog.getByLabel('No border')).toBeChecked();
  await dialog.getByLabel('Fill color').fill('#ffff00');
  await dialog.getByLabel('Border color').fill('#0000ff');
  await expect(dialog.getByLabel('No fill')).not.toBeChecked();
  await expect(dialog.getByLabel('No border')).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  const saved = (await PDFDocument.load(await downloaded(page))).getForm().getTextField('Note');
  const look = saved.acroField.getWidgets()[0].getAppearanceCharacteristics();
  expect(look.getBackgroundColor()).toEqual([1, 1, 0]);
  expect(look.getBorderColor()).toEqual([0, 0, 1]);
});

test('what was typed into a field stays when Prepare a form moves a field', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 400]);
  for (const [name, y] of [
    ['Note', 100],
    ['Other', 200],
  ])
    doc.getForm().createTextField(name).addToPage(sheet, { x: 100, y, width: 120, height: 24 });
  await openPdf(page, doc);
  await page.getByRole('textbox', { name: 'Note (on page)' }).fill('typed words');
  await prepareForm(page);
  await designer(page, 'Other#0').focus();
  await page.keyboard.press('ArrowRight');
  await settled(page);
  await expect(designer(page, 'Other#0')).toBeVisible();
  const saved = (await PDFDocument.load(await downloaded(page))).getForm();
  expect(saved.getTextField('Note').getText()).toBe('typed words');
  expect(saved.getTextField('Other').acroField.getWidgets()[0].getRectangle().x).toBeCloseTo(
    100.5,
    1,
  );
});

for (const rotation of [0, 90])
  test(`a field can be resized from its properties on a page turned ${rotation} degrees`, async ({
    page,
  }) => {
    const doc = await PDFDocument.create();
    const sheet = doc.addPage([600, 400]);
    sheet.setRotation(degrees(rotation));
    const note = doc.getForm().createTextField('Note');
    note.addToPage(sheet, { x: 100, y: 100, width: 120, height: 24 });
    const start = note.acroField.getWidgets()[0].getRectangle();
    await openPdf(page, doc);
    await prepareForm(page);
    await designer(page, 'Note#0').focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Text field properties' });
    // As the page shows it: turned a quarter, the field stands upright.
    const [width, height] = rotation ? [start.height, start.width] : [start.width, start.height];
    await expect(dialog.getByLabel('Width (pt)')).toHaveValue(String(width));
    await expect(dialog.getByLabel('Height (pt)')).toHaveValue(String(height));
    await dialog.getByLabel('Width (pt)').fill(String(width + 40));
    await dialog.getByLabel('Height (pt)').fill(String(height + 10));
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await settled(page);
    await expect(designer(page, 'Note#0')).toBeFocused();
    const saved = (await PDFDocument.load(await downloaded(page))).getForm().getTextField('Note');
    const rect = saved.acroField.getWidgets()[0].getRectangle();
    // The top left corner on screen stays where it was.
    const expected = rotation
      ? { x: start.x, y: start.y, width: start.width + 10, height: start.height + 40 }
      : { x: start.x, y: start.y - 10, width: start.width + 40, height: start.height + 10 };
    for (const key of ['x', 'y', 'width', 'height'])
      expect(rect[key]).toBeCloseTo(expected[key], 2);
  });

test('Escape while dragging a field puts it back without an edit', async ({ page }) => {
  const doc = await PDFDocument.create();
  const note = doc.getForm().createTextField('Note');
  note.addToPage(doc.addPage([600, 400]), { x: 100, y: 100, width: 120, height: 24 });
  await openPdf(page, doc);
  await prepareForm(page);
  const before = await designer(page, 'Note#0').boundingBox();
  await page.mouse.move(before.x + 20, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 120, before.y + 60, { steps: 5 });
  await page.keyboard.press('Escape');
  expect(await designer(page, 'Note#0').boundingBox()).toEqual(before);
  await page.mouse.move(before.x + 140, before.y + 80, { steps: 2 });
  await page.mouse.up();
  await settled(page);
  expect(await designer(page, 'Note#0').boundingBox()).toEqual(before);
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  // Prepare a form stays open: Escape went to the drag.
  await expect(page.getByRole('complementary', { name: 'Tools' })).toContainText('Prepare a form');
  // A drag the system cancels is not applied either.
  await page.mouse.move(before.x + 20, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 120, before.y + 60, { steps: 5 });
  await designer(page, 'Note#0').evaluate((node) =>
    node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })),
  );
  await page.mouse.up();
  await settled(page);
  expect(await designer(page, 'Note#0').boundingBox()).toEqual(before);
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
});

test('the hint above the page explains Prepare a form while it is open', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([600, 400]);
  await openPdf(page, doc);
  const hint = page.locator('.tool-hint');
  await expect(hint).toHaveText(/double-click text to edit/);
  await prepareForm(page);
  await expect(hint).toHaveText(/Drag fields to move them/);
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Text field', exact: true }).click();
  await expect(hint).toHaveText(/Drag a box where the field goes/);
  await page.getByRole('button', { name: 'Place at page center' }).click();
  await page.getByRole('dialog', { name: 'Text field properties' }).press('Escape');
  await settled(page);
  await pane.getByRole('button', { name: 'Back to all tools' }).click();
  await expect(hint).toHaveText(/double-click text to edit/);
});

test('a field resized as small as it goes at a high zoom stays the smallest size', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const note = doc.getForm().createTextField('Note');
  note.addToPage(doc.addPage([300, 200]), { x: 20, y: 100, width: 120, height: 24 });
  await openPdf(page, doc);
  await page.getByLabel('Zoom', { exact: true }).selectOption('4');
  await settled(page);
  await prepareForm(page);
  const field = designer(page, 'Note#0');
  await field.scrollIntoViewIfNeeded();
  await field.click({ position: { x: 5, y: 5 } });
  const handle = field.locator('.designer-resize');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 2000, box.y - 2000, { steps: 5 });
  await page.mouse.up();
  await settled(page);
  await expect(page.locator('#toast')).not.toContainText('4 points');
  const saved = (await PDFDocument.load(await downloaded(page))).getForm().getTextField('Note');
  const rect = saved.acroField.getWidgets()[0].getRectangle();
  expect(rect.width).toBeCloseTo(4, 1);
  expect(rect.height).toBeCloseTo(4, 1);
});
