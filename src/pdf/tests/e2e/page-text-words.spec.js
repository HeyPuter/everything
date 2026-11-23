import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

test('the page text screen readers read keeps words split between fonts or lines whole', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([500, 600]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  sheet.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ Font: { F: regular.ref, B: bold.ref } }),
  );
  // "Important" starts in bold, and "hyphenated" breaks across two lines.
  sheet.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        'BT /B 14 Tf 50 500 Td (Im) Tj /F 14 Tf (portant words follow, and a hyphen-) Tj ET ' +
          'BT /F 14 Tf 50 482 Td (ated word on the next line.) Tj ET',
      ),
    ),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'words.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  const text = page.getByRole('region', { name: 'Page text', exact: true });
  await expect(text).toContainText('Important words follow');
  await expect(text).toHaveText(
    /^Important words follow, and a hyphenated word on the next line\.$/,
  );
});
