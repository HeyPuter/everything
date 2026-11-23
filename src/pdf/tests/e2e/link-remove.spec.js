import { test, expect } from '@playwright/test';
import { PDFDocument, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listLinks } from '../../src/core/links.js';

// A link could be removed only from its right-click menu, which a phone or a keyboard on a
// Mac cannot open. The Edit link dialog, which a tap or Enter opens, removes it too.
test('a link can be removed from its Edit link dialog', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const first = doc.addPage([400, 500]);
  first.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 375, 380, 420],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of('https://example.com/') },
      }),
    ),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'link-remove.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const link = page.getByRole('button', { name: 'Link to example.com', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true });
  await dialog.getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Link removed.');
  await expect(dialog).toBeHidden();
  await expect(link).toHaveCount(0);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await download).path()));
  expect(listLinks(saved, 0)).toEqual([]);
  // One Undo brings it back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(link).toHaveCount(1);
});
