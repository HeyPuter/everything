import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectPaths } from '../../src/core/path-edit.js';

async function open(page, doc) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'label.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
}
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    await bar.getByRole('menuitem', { name: 'Insert', exact: true }).click();
    return item.click();
  }
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Insert', exact: true }).click();
  await item.click();
}
async function placedBounds(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  const paths = inspectPaths(doc, 0);
  expect(paths).toHaveLength(1);
  return paths[0].bounds;
}

for (const unit of [1, 10])
  for (const mark of ['stamp', 'signature'])
    test(`a ${mark} placed on a small page${unit > 1 ? ' with large units' : ''} fits on it`, async ({
      page,
    }) => {
      // A label-sized page, or with UserUnit 10 a 1000 by 800 point one in 100 by 80 units.
      const doc = await PDFDocument.create();
      const sheet = doc.addPage([100, 80]);
      if (unit > 1) sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
      await open(page, doc);
      if (mark === 'stamp') {
        await menu(page, 'Stamp…');
        const dialog = page.getByRole('dialog', { name: 'Add stamp' });
        await dialog.getByRole('button', { name: 'Place stamp', exact: true }).click();
      } else {
        await menu(page, 'Signature…');
        const dialog = page.getByRole('dialog', { name: 'Add signature' });
        await dialog.getByRole('tab', { name: 'Type' }).click();
        await dialog.getByLabel('Signature text').fill('Ada Lovelace');
        await dialog.getByRole('button', { name: 'Place signature' }).click();
      }
      await expect(page.locator('.properties-heading h2')).toHaveText(
        mark === 'stamp' ? 'Stamp' : 'Signature',
      );
      const [x0, y0, x1, y1] = await placedBounds(page);
      expect(x0).toBeGreaterThan(0);
      expect(y0).toBeGreaterThan(0);
      expect(x1).toBeLessThan(100);
      expect(y1).toBeLessThan(80);
      // On the large page it is sized in points like on any other: a quarter to a third across.
      if (unit > 1) {
        expect(x1 - x0).toBeGreaterThan(20);
        expect(x1 - x0).toBeLessThan(35);
      }
    });
