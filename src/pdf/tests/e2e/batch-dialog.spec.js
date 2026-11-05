import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
});

async function openPdf(page) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++)
    doc.addPage([400, 500]).drawText(`Page ${i + 1} words`, { x: 40, y: 100, size: 20, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

test("setting a batch step's option chooses the step", async ({ page }) => {
  await openPdf(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Batch process', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Batch process' });
  const rotate = dialog.getByLabel('Rotate all pages');
  await expect(rotate).not.toBeChecked();
  await dialog.getByLabel('Rotation').selectOption('270');
  await expect(rotate).toBeChecked();
  await dialog.getByLabel('Bates prefix').fill('LAW');
  await expect(dialog.getByLabel('Add Bates numbers')).toBeChecked();
  // The step can still be left out once its option is set.
  await dialog.getByLabel('Add Bates numbers').uncheck();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  const download = await pending;
  const result = await PDFDocument.load(await readFile(await download.path()));
  expect(result.getPages().map((p) => p.getRotation().angle)).toEqual([270, 270]);
});
