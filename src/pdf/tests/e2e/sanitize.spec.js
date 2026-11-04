import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function openPdf(page, bytes) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
}
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
async function sanitizeDialog(page) {
  await page.getByRole('button', { name: 'Redact a PDF', exact: true }).first().click();
  await page.getByRole('button', { name: 'Remove hidden information…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove hidden information' });
  await expect(dialog.getByRole('checkbox', { name: 'Scripts' })).toBeVisible();
  return dialog;
}
async function plainPdf({ unreadableDrawing = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.drawText('Quarterly plan', { x: 50, y: 300, size: 16, font });
  if (unreadableDrawing) {
    // A drawing group whose data no reader can decode: what it holds cannot be examined.
    const form = doc.context.register(
      doc.context.stream('BT 3 Tr ET', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        Filter: 'UnknownDecode',
      }),
    );
    page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Fm0: form }));
    page.node.addContentStream(doc.context.register(doc.context.stream('q /Fm0 Do Q')));
  }
  return doc.save();
}

test('Remove hidden information that finds nothing says so and leaves the PDF unchanged', async ({
  page,
}) => {
  await openPdf(page, await plainPdf());
  const dialog = await sanitizeDialog(page);
  for (const box of await dialog.getByRole('checkbox').all()) await box.uncheck();
  await dialog.getByRole('checkbox', { name: 'Scripts' }).check();
  await dialog.getByRole('checkbox', { name: 'File attachments' }).check();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toHaveText(
    'No hidden information of the chosen kinds was found.',
  );
  await settled(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.save-status')).not.toHaveText('Unsaved changes');
});

test('Remove hidden information lists the content it could not examine', async ({ page }) => {
  await openPdf(page, await plainPdf({ unreadableDrawing: true }));
  const dialog = await sanitizeDialog(page);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog).toBeHidden();
  const notice = page.getByRole('dialog', { name: 'Check the cleaned PDF' });
  await expect(notice).toContainText('Hidden information removed.');
  await expect(notice.getByRole('listitem')).toHaveText([
    'A drawing group could not be read and was left unchanged.',
  ]);
  await notice.getByRole('button', { name: 'OK' }).click();
  await expect(notice).toBeHidden();
  await settled(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
});
