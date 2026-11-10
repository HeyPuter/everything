import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile } from 'node:fs/promises';

for (const edge of ['Top', 'Bottom'])
  test(`overlapping ${edge.toLowerCase()} text can be corrected without losing entries or changing history`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.setTitle('Quarterly report summary');
    const opening = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (
      await opening
    ).setFiles({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    const bar = page.getByRole('menubar', { name: 'PDF menus' });
    if (await bar.isVisible())
      await bar.getByRole('menuitem', { name: 'Insert', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'Insert', exact: true }).click();
    }
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: 'Header and footer…', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Header and footer', exact: true });
    const apply = dialog.getByRole('button', { name: 'Add header and footer', exact: true });
    await dialog.getByLabel(`${edge} left`, { exact: true }).fill('{title}');
    await dialog.getByLabel(`${edge} center`, { exact: true }).fill('Confidential');
    await dialog.getByLabel('Size (pt)', { exact: true }).fill('12');
    await apply.click();
    await expect(dialog.getByRole('alert')).toContainText('overlap on page 1');
    await expect(dialog.getByLabel(`${edge} left`, { exact: true })).toHaveValue('{title}');
    await expect(dialog.getByLabel(`${edge} center`, { exact: true })).toHaveValue('Confidential');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.locator('.textLayer')).not.toContainText('Confidential');
    await dialog.getByLabel('Size (pt)', { exact: true }).fill('6');
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.textLayer')).toContainText('Confidential');
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const task = pdfjs.getDocument({
      data: new Uint8Array(await readFile(await (await downloading).path())),
    });
    try {
      const content = await (await (await task.promise).getPage(1)).getTextContent();
      const left = content.items.find((item) => item.str === 'Quarterly report summary');
      const center = content.items.find((item) => item.str === 'Confidential');
      expect(left).toBeDefined();
      expect(center).toBeDefined();
      expect(left.transform[4] + left.width).toBeLessThan(center.transform[4]);
    } finally {
      await task.destroy();
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.textLayer')).not.toContainText('Confidential');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.locator('.textLayer')).toContainText('Confidential');
  });

test('a header refused for its size leaves the keyboard where it was in the dialog', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const opening = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opening
  ).setFiles({
    name: 'small.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible())
    await bar.getByRole('menuitem', { name: 'Insert', exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Insert', exact: true }).click();
  }
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Header and footer…', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Header and footer', exact: true });
  const field = dialog.getByLabel('Top left', { exact: true });
  await field.fill('A header far too long to fit across a page this small');
  await field.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('too wide for page 1');
  // The field was disabled while the header was tried; it has the focus back to be corrected.
  await expect(field).toBeFocused();
  const apply = dialog.getByRole('button', { name: 'Add header and footer', exact: true });
  await apply.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('too wide for page 1');
  await expect(apply).toBeFocused();
});
