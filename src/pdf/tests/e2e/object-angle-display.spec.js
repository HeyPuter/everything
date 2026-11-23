import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';

// Word stores a picture turned by 30 or 45 degrees as a matrix rounded to a few digits; the
// Angle field read 30.0007 and 44.999 for them.
test('a picture another program turned by a whole angle shows that angle', async ({ page }) => {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(Buffer.from(PIXEL, 'base64'));
  const sheet = doc.addPage([400, 400]);
  sheet.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im: image.ref } }));
  sheet.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        'q 103.92 -60 30 51.961 60 300 cm /Im Do Q q 84.854 -84.851 42.426 42.427 200 200 cm /Im Do Q',
      ),
    ),
  );
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'turned.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const angle = page.getByLabel('Image rotation in degrees', { exact: true });
  for (const [n, degrees] of [
    [1, '30'],
    [2, '45'],
  ]) {
    await page.getByRole('button', { name: `Select image ${n}`, exact: true }).click();
    await expect(angle).toHaveValue(degrees);
  }
  // Typing the angle it shows changes nothing.
  await angle.fill('45');
  await angle.press('Enter');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
