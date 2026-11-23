import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { createSelfSignedId, signPdf } from '../../src/core/digital-signature.js';

async function openSigned(page) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const id = await createSelfSignedId({ name: 'Grace Hopper', keyType: 'P-256' });
  const signed = await signPdf(await doc.save(), id, {
    page: 0,
    rect: { x: 40, y: 40, width: 200, height: 50 },
  });
  const pending = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await pending
  ).setFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(signed) });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.signature-bar')).toContainText('Signed');
}

// Certifying a signed PDF is refused, but only after a digital ID was chosen (or made, and
// downloaded) and the certification's details typed in.
test('certifying a PDF someone has signed is refused before asking for a digital ID', async ({
  page,
}) => {
  await openSigned(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Use a certificate', exact: true }).click();
  await pane.getByRole('button', { name: /Certify/ }).click();
  await expect(
    page.getByText('A document can be certified only before anyone has signed it.'),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Choose a digital ID' })).toHaveCount(0);
});
