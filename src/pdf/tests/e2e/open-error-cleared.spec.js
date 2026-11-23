import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// A file dropped from the desktop brings no press or key to the page, and an error stays until
// one: "This PDF could not be opened" stayed over the PDF dropped next, which had opened.
test('a PDF that opens takes down the error left by one that could not', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'damaged.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
  });
  const toast = page.locator('#toast');
  await expect(toast).toHaveText(/could not be opened/);
  // Long enough for the error to wait for the reader's next press or key.
  await page.clock.runFor(6000);
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  const base64 = Buffer.from(await doc.save()).toString('base64');
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'dropped.pdf', {
        type: 'application/pdf',
      }),
    );
    for (const type of ['dragenter', 'dragover', 'drop'])
      document
        .querySelector('.workspace')
        .dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
  }, base64);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(toast).toBeHidden();
});
