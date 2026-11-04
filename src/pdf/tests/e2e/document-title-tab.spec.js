import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// A PDF can ask to be shown by its own title rather than its file name. The tab follows the
// title as it is now, not as it was when the PDF was opened.
test('the tab shows the document title after it is changed, undone, or removed', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  doc.setTitle('Original title', { showInWindowTitleBar: true });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'titled.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page).toHaveTitle('Original title · PDF Editor');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.keyboard.press('ControlOrMeta+d');
  const details = page.getByRole('dialog', { name: 'Document details' });
  await details.getByLabel('Title', { exact: true }).fill('Quarterly report');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(page).toHaveTitle('* Quarterly report · PDF Editor');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page).toHaveTitle('Original title · PDF Editor');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page).toHaveTitle('* Quarterly report · PDF Editor');
  // Removing the metadata removes the title, so the tab goes back to the file name.
  await page.keyboard.press('ControlOrMeta+d');
  await details.getByLabel('Title', { exact: true }).fill('');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(page).toHaveTitle('* titled.pdf · PDF Editor');
});
