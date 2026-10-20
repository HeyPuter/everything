import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
async function open(page, bytes) {
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({ name: 'sizes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await settled(page);
}
async function download(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await pending).path()));
}
/** A radio group whose first two buttons both export "Small", with states of their own. */
async function sizes(unison = false) {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 400]);
  const group = doc.getForm().createRadioGroup('Size');
  for (const [value, x] of [
    ['Small', 40],
    ['Small', 80],
    ['Large', 120],
  ])
    group.addOptionToPage(value, sheet, { x, y: 340, width: 16, height: 16 });
  if (unison) group.acroField.dict.set(PDFName.of('Ff'), PDFNumber.of((1 << 15) | (1 << 25)));
  return doc.save();
}
const states = (doc) =>
  doc
    .getForm()
    .getRadioGroup('Size')
    .acroField.getWidgets()
    .map((widget) => widget.dict.lookup(PDFName.of('AS'))?.decodeText());

test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
});

test('a radio button sharing its export value with another is chosen on its own', async ({
  page,
}) => {
  await open(page, await sizes());
  const radios = page.getByRole('radio');
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(0)).toHaveAccessibleName('Size: Small (on page)');
  await radios.nth(0).check();
  await expect(radios.nth(1)).not.toBeChecked();
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  await settled(page);
  expect(await radios.evaluateAll((all) => all.map((radio) => radio.checked))).toEqual([
    true,
    false,
    false,
  ]);
  let saved = await download(page);
  expect(states(saved)).toEqual(['0', 'Off', 'Off']);
  // The other "Small" button takes over, and reopening shows the one that is on.
  await radios.nth(1).check();
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  await settled(page);
  saved = await download(page);
  expect(states(saved)).toEqual(['Off', '1', 'Off']);
  await open(page, await saved.save());
  expect(await radios.evaluateAll((all) => all.map((radio) => radio.checked))).toEqual([
    false,
    true,
    false,
  ]);
});

test('radio buttons in unison that share an export value switch on together', async ({ page }) => {
  await open(page, await sizes(true));
  const radios = page.getByRole('radio');
  await radios.nth(0).check();
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  await settled(page);
  expect(await radios.evaluateAll((all) => all.map((radio) => radio.checked))).toEqual([
    true,
    true,
    false,
  ]);
  const saved = await download(page);
  expect(states(saved)).toEqual(['0', '1', 'Off']);
});
