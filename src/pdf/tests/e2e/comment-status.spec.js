import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { addShapeAnnotation, setReviewState } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('the Review status field shows the status a comment has', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]);
  const id = addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 100, y: 200, width: 80, height: 60 },
    text: 'Reviewed',
  });
  setReviewState(doc, 0, id, { state: 'Accepted', author: 'Ada' });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-status.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Rectangle: Reviewed', exact: true }).click();
  const props = page.getByRole('complementary', {
    name: 'Selection properties',
  });
  const status = props.getByLabel('Review status');
  await expect(status).toHaveValue('Accepted');

  // A new status stays shown once the comment is drawn again.
  await status.selectOption('Rejected');
  await settled(page);
  await expect(page.locator('#toast')).toContainText('Status set to Rejected.');
  await expect(props.getByLabel('Review status')).toHaveValue('Rejected');
});
