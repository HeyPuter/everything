import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test('a signature that filling in the form invalidated still shows, as invalid', async ({
  page,
}) => {
  const { createSelfSignedId, signPdf, verifySignatures } =
    await import('../../src/core/digital-signature.js');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  doc.getForm().createTextField('Name').addToPage(sheet, { x: 40, y: 300, width: 200, height: 24 });
  const signed = await signPdf(await doc.save(), await createSelfSignedId({ name: 'Ada' }), {
    rect: { x: 40, y: 100, width: 200, height: 50 },
  });
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(signed) });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.signature-bar')).toContainText('Signed');
  await page.getByRole('textbox', { name: 'Name (on page)' }).fill('Ada');
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Edit a signed PDF?' })
    .getByRole('button', {
      name: 'Edit anyway',
    })
    .click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // The rewritten file keeps the signature, compressed, and every reader shows it invalid;
  // here the bar and the Signatures panel went away as if the PDF had never been signed.
  await expect(page.locator('.signature-bar')).toHaveText(/At least one signature is invalid/);
  await page.getByRole('tab', { name: 'Signatures' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Signatures' })).toContainText(
    'Signature is invalid',
  );
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = new Uint8Array(await readFile(await (await pending).path()));
  expect((await verifySignatures(saved)).map((report) => report.status)).toEqual(['invalid']);
});
