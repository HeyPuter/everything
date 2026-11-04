import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// The desktop workspace: phones overlay the tools pane, which phone-shell.spec.js covers.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env: 'web', auth: { isSignedIn: () => false, getUser: async () => null, signIn: async () => {} }, fs: {}, ui: {} };`,
    }),
  );
  await page.goto('/');
  await expect(page).toHaveTitle('Untitled.pdf · PDF Editor');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
});
const twoPages = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  doc.addPage([300, 300]);
  return Buffer.from(await doc.save());
};
async function tool(page, name) {
  const pane = page.getByRole('complementary', { name: 'Tools' });
  if (!(await pane.getByRole('button', { name, exact: true }).isVisible()))
    await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name, exact: true }).click();
  return page.getByRole('dialog', { name });
}

test('Combine files leaves out the untouched blank PDF the app opens with', async ({ page }) => {
  const dialog = await tool(page, 'Combine files');
  await expect(dialog.getByLabel('Start with Untitled.pdf')).not.toBeChecked();
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Add files…' }).click();
  await (
    await chooser
  ).setFiles([
    { name: 'a.pdf', mimeType: 'application/pdf', buffer: await twoPages() },
    { name: 'b.pdf', mimeType: 'application/pdf', buffer: await twoPages() },
  ]);
  await expect(dialog.getByText('b.pdf')).toBeVisible();
  await dialog.getByRole('button', { name: 'Combine', exact: true }).click();
  // Four pages, with no empty sheet in front of them.
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
});

test('Batch process leaves out the untouched blank PDF the app opens with', async ({ page }) => {
  const dialog = await tool(page, 'Batch process');
  await expect(dialog.getByLabel('Include Untitled.pdf')).not.toBeChecked();
});

test('a blank PDF that has been worked on is still offered first', async ({ page }) => {
  await page
    .getByRole('menubar', { name: 'PDF menus' })
    .getByRole('menuitem', { name: 'Page', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Rotate clockwise', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const dialog = await tool(page, 'Combine files');
  await expect(dialog.getByLabel('Start with Untitled.pdf')).toBeChecked();
});

test('a combined PDF counts as unsaved until it is saved or downloaded', async ({ page }) => {
  const dialog = await tool(page, 'Combine files');
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Add files…' }).click();
  await (
    await chooser
  ).setFiles([
    { name: 'a.pdf', mimeType: 'application/pdf', buffer: await twoPages() },
    { name: 'b.pdf', mimeType: 'application/pdf', buffer: await twoPages() },
  ]);
  await dialog.getByRole('button', { name: 'Combine', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
  // The combined PDF exists only here: leaving must not lose it without a word.
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page).toHaveTitle('* Combined.pdf · PDF Editor');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  const leave = page.getByRole('dialog', { name: 'Save before leaving?' });
  await leave.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await pending;
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New blank PDF', exact: true })).toBeVisible();
});

test('a PDF made from pictures counts as unsaved; a new blank PDF does not', async ({ page }) => {
  // A plain 2 by 2 PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNocFAAIgYIBQAaDgOBnA45xwAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Pictures to PDF', exact: true }).click();
  await (await chooser).setFiles([{ name: 'scan.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // Like a combined PDF, it exists only here: leaving must not lose it without a word.
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page).toHaveTitle('* scan.pdf · PDF Editor');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  const leave = page.getByRole('dialog', { name: 'Save before leaving?' });
  await leave.getByRole('button', { name: 'Leave without saving', exact: true }).click();
  // An untouched new blank PDF has nothing to lose, so it leaves without asking.
  await page.getByRole('button', { name: 'New blank PDF', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.save-status')).not.toHaveText('Unsaved changes');
  await expect(page).toHaveTitle('Untitled.pdf · PDF Editor');
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pictures to PDF', exact: true })).toBeVisible();
  await expect(leave).toBeHidden();
});
