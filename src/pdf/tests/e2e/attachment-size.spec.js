import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// A file too large to attach is turned down before it is read: reading a video of several
// gigabytes first could take the tab down, only for the attachment to be refused anyway.
test('a file too large to attach is not read first', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.addInitScript(() => {
    window.__reads = 0;
    for (const method of ['arrayBuffer', 'text', 'bytes', 'stream']) {
      const read = Blob.prototype[method];
      if (!read) continue;
      Blob.prototype[method] = function () {
        window.__reads++;
        return read.call(this);
      };
    }
  });
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'attach.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Attachments', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Attachments' });
  const before = await page.evaluate(() => window.__reads);
  const picker = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Attach a file…' }).click();
  await (
    await picker
  ).setFiles({
    name: 'video.mov',
    mimeType: 'video/quicktime',
    buffer: Buffer.alloc(21 * 1024 * 1024),
  });
  await expect(page.locator('#toast')).toHaveText('Attach files of up to 20 MB.');
  expect(await page.evaluate(() => window.__reads)).toBe(before);
  await expect(panel.getByRole('listitem')).toHaveCount(0);
});
