import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createSelfSignedId, signPdf, verifySignatures } from '../../src/core/digital-signature.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function openSigned(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText('Contract', { x: 30, y: 200, size: 18 });
  const id = await createSelfSignedId({ name: 'Ada Lovelace' });
  const signed = await signPdf(await doc.save(), id, { reason: 'Approved' });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(signed) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.signature-bar')).toContainText('Signed');
}
async function protect(page) {
  await page
    .getByRole('menubar', { name: 'PDF menus' })
    .getByRole('menuitem', { name: 'File' })
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Protect with password…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Protect with password' });
  await dialog.getByLabel('Password to open').fill('user');
  await dialog.getByLabel('Confirm password').fill('user');
  await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.skip(({ isMobile }) => isMobile, 'desktop menus');

test('protecting a signed PDF asks first, since encrypting invalidates its signature', async ({
  page,
}) => {
  await openSigned(page);
  await protect(page);
  // Encrypting rewrites every string and stream the signature covers.
  const warning = page.getByRole('dialog', { name: 'Edit a signed PDF?' });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(warning).toBeHidden();
  await expect(page.getByRole('button', { name: 'Protected', exact: true })).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const kept = new Uint8Array(await readFile(await (await pending).path()));
  expect((await verifySignatures(kept)).map((report) => report.byteRange && report.status)).toEqual(
    ['valid-unknown-identity'],
  );

  await protect(page);
  await page
    .getByRole('dialog', { name: 'Edit a signed PDF?' })
    .getByRole('button', { name: 'Edit anyway' })
    .click();
  await expect(page.locator('#toast')).toHaveText(
    'The password is applied when you download or save.',
  );
});

test('declining to save a signed PDF as PDF/A leaves its PDF/A level as it was', async ({
  page,
}) => {
  await openSigned(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'PDF standards', exact: true }).click();
  await pane.getByRole('button', { name: 'Save as PDF/A…' }).click();
  const convert = page.getByRole('dialog', { name: 'Save as PDF/A' });
  await convert.getByLabel('Level').selectOption('1b');
  await convert.getByRole('button', { name: 'Convert' }).click();
  await page
    .getByRole('dialog', { name: 'Edit a signed PDF?' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.standards-bar')).toBeHidden();
  // The declined level was kept as the file's own: the next check offered it first.
  await pane.getByRole('button', { name: 'Check compliance…' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Check PDF/A compliance' }).getByLabel('Level'),
  ).toHaveValue('2b');
});

test('an invisible signature offers no page to go to', async ({ page }) => {
  await openSigned(page);
  await page.getByRole('tab', { name: 'Signatures' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Signatures' });
  await expect(panel.getByRole('listitem').first()).toContainText('Signed by Ada Lovelace');
  // It offered "Go to signature on page 1", where nothing of it shows.
  await expect(panel.getByRole('button', { name: /Go to signature/ })).toHaveCount(0);
  await panel.getByText('Details').click();
  await expect(panel.locator('dd')).toContainText(['Invisible']);
});
