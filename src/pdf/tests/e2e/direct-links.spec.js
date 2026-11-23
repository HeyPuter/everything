import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listLinks } from '../../src/core/links.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// Some writers put link dictionaries in the page's Annots array itself, not as objects of
// their own. They could be followed but not edited or removed.
test('links written directly into the page annotation list can be edited and removed', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 400]);
  first.drawText('Visit our website', { x: 40, y: 340, size: 18, font });
  first.drawText('Visit the shop', { x: 40, y: 240, size: 18, font });
  const link = (y, url) =>
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [40, y, 200, y + 25],
      Border: [0, 0, 0],
      A: { S: 'URI', URI: PDFString.of(url) },
    });
  first.node.set(
    PDFName.of('Annots'),
    doc.context.obj([link(335, 'https://example.com/'), link(235, 'https://shop.example/')]),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'links.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Link to example.com' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit link' });
  await editor
    .getByRole('textbox', { name: 'Web address to link to' })
    .fill('https://example.org/');
  await editor.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Link updated.');
  await settled(page);
  await page.getByRole('button', { name: 'Link to shop.example' }).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Remove link', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Link removed.');
  await settled(page);
  await expect(page.getByRole('button', { name: 'Link to shop.example' })).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  expect(listLinks(saved, 0).map((entry) => entry.url)).toEqual(['https://example.org/']);
});
