import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addTextBox, listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

async function open(page) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  await addTextBox(doc, 0, { rect: { x: 40, y: 380, width: 180, height: 50 }, text: 'Framed' });
  // A measurement label is a text box without a border.
  await addTextBox(doc, 0, {
    rect: { x: 40, y: 200, width: 180, height: 50 },
    text: 'Plain',
    borderColor: null,
    borderWidth: 0,
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'text-box-properties.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  return page.getByRole('complementary', { name: 'Selection properties' });
}
async function savedSizes(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  return listAnnotations(saved, 0).map((entry) => entry.fontSize);
}

test('a text box takes any font size its field allows and refuses others in the field', async ({
  page,
}) => {
  const props = await open(page);
  await page.getByRole('button', { name: 'Text box: Framed', exact: true }).click();
  const size = props.getByLabel('Font size', { exact: true });
  for (const refused of ['300', '0', '']) {
    await size.fill(refused);
    await size.press('Enter');
    await settled(page);
    // The field says what is wrong with it; no error about another range appears.
    expect(await size.evaluate((input) => input.validity.valid)).toBe(false);
    await expect(page.locator('#toast')).not.toContainText('font size');
  }
  expect(await savedSizes(page)).toEqual([12, 12]);
  await size.fill('10.5');
  await size.press('Enter');
  await settled(page);
  expect(await savedSizes(page)).toEqual([10.5, 12]);
});

test('Width is offered for a framed text box only', async ({ page }) => {
  const props = await open(page);
  await page.getByRole('button', { name: 'Text box: Framed', exact: true }).click();
  await expect(props.getByLabel('Line width', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Text box: Plain', exact: true }).click();
  await expect(props.getByLabel('Font size', { exact: true })).toBeVisible();
  await expect(props.getByLabel('Line width', { exact: true })).toHaveCount(0);
});
