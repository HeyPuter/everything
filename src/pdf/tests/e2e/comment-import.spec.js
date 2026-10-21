import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

const comment = (page, name) =>
  `<square color="#FF0000" flags="print" name="${name}" page="${page}" rect="100,100,200,180" width="1"><contents>${name}</contents></square>`;
const xfdf = (...comments) =>
  `<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>${comments.join('')}</annots></xfdf>`;

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// Comments an import leaves out are missing from the PDF, so the message says how many.
test('importing comments says how many could not be added', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'import.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  const importFile = async (name, text) => {
    const picker = page.waitForEvent('filechooser');
    await pane.getByRole('button', { name: 'Import comments…' }).click();
    await (
      await picker
    ).setFiles({ name, mimeType: 'application/vnd.adobe.xfdf', buffer: Buffer.from(text) });
  };
  const toast = page.locator('#toast');

  await importFile('some.xfdf', xfdf(comment(0, 'kept'), comment(3, 'far'), comment(5, 'farther')));
  await expect(toast).toHaveText('1 comment imported. 2 comments in the file could not be added.');
  await settled(page);
  await page.keyboard.press('Escape');

  await importFile('none.xfdf', xfdf(comment(4, 'away')));
  await expect(toast).toHaveText(
    'No comments were imported. 1 comment in the file could not be added.',
  );
  await page.keyboard.press('Escape');

  // A file whose comments are all here already has nothing new to add, and that is all.
  await importFile('again.xfdf', xfdf(comment(0, 'kept')));
  await expect(toast).toHaveText('There were no new comments to import.');
});
