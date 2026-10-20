import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
async function open(page, bytes) {
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({ name: 'fruit.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await settled(page);
}
async function download(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await pending).path()));
}
/** A list whose first two options both export "A". */
async function fruit() {
  const doc = await PDFDocument.create();
  const list = doc.getForm().createOptionList('Fruit');
  list.addToPage(doc.addPage([600, 400]), { x: 40, y: 250, width: 200, height: 90 });
  list.enableMultiselect();
  list.acroField.dict.set(
    PDFName.of('Opt'),
    doc.context.obj(
      [
        ['A', 'Apple'],
        ['A', 'Avocado'],
        ['B', 'Banana'],
      ].map(([value, label]) => [PDFString.of(value), PDFString.of(label)]),
    ),
  );
  return doc.save();
}
const selection = (doc) => {
  const dict = doc.getForm().getOptionList('Fruit').acroField.dict;
  const v = dict.lookup(PDFName.of('V'));
  return {
    V: v?.asArray ? v.asArray().map((s) => s.decodeText()) : v?.decodeText(),
    I: dict
      .lookup(PDFName.of('I'))
      ?.asArray()
      .map((n) => n.asNumber()),
  };
};

test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
});

test('a list option sharing its export value with another is chosen on its own', async ({
  page,
}) => {
  await open(page, await fruit());
  const list = page.getByRole('listbox', { name: 'Fruit (on page)' });
  await list.selectOption({ label: 'Avocado' });
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  await settled(page);
  const chosen = () =>
    list.evaluate((select) => [...select.selectedOptions].map((option) => option.textContent));
  expect(await chosen()).toEqual(['Avocado']);
  let saved = await download(page);
  expect(selection(saved)).toEqual({ V: 'A', I: [1] });
  await open(page, await saved.save());
  expect(await chosen()).toEqual(['Avocado']);
  // The Fill forms dialog offers both options and keeps them apart too.
  await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Fill forms' });
  const select = dialog.getByLabel('Fruit', { exact: true });
  await expect(select.locator('option:checked')).toHaveText(['Avocado']);
  await select.selectOption([{ label: 'Apple' }, { label: 'Banana' }]);
  await dialog.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settled(page);
  expect(await chosen()).toEqual(['Apple', 'Banana']);
  saved = await download(page);
  expect(selection(saved)).toEqual({ V: ['A', 'B'], I: [0, 2] });
});
