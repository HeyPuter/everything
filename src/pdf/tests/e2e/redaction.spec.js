import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('Apply redactions counts what it removed in words that agree with the numbers', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([300, 300]);
  sheet.drawText('X', { x: 40, y: 200, size: 16, font });
  sheet.drawRectangle({ x: 100, y: 100, width: 50, height: 50, color: rgb(0.2, 0.4, 0.8) });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'one.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Redact pages…' }).click();
  await page
    .getByRole('dialog', { name: 'Redact pages' })
    .getByRole('button', { name: 'Mark pages' })
    .click();
  await settled(page);
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Apply redactions' });
  await confirm.getByLabel(/Also remove hidden information/).uncheck();
  await confirm.getByRole('button', { name: 'Apply', exact: true }).click();
  await settled(page);
  await expect(page.locator('#toast')).toContainText(
    'Redactions applied: removed 1 character, 1 drawing.',
  );
});
