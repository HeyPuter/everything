import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Drives the desktop menu bar.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
});
test.afterEach(async ({ page, isMobile }) => {
  // Skipped phone runs never open the app, so there is no storage to clear.
  if (isMobile) return;
  await page.evaluate(() => localStorage.removeItem('pdf-editor:page-display'));
});
async function openPdf(page, count, size) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++)
    doc.addPage(size).drawText(`Page ${i + 1}`, { x: 40, y: 40, size: 24, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${count}`);
}
async function display(page, name) {
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page display' }).click();
  await page.getByRole('menuitemcheckbox', { name, exact: true }).click();
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('Page Down and Page Up turn the page in single page display', async ({ page }) => {
  await openPdf(page, 3, [400, 300]);
  await display(page, 'Single page');
  await settled(page);
  await page.locator('.workspace').focus();
  await page.keyboard.press('PageDown');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await settled(page);
  await page.keyboard.press('PageDown');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await settled(page);
  await page.keyboard.press('PageUp');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(page.locator('.page-slot:visible')).toHaveAttribute('data-page', '1');
});

test('Page Down scrolls through a tall page before turning to the next one', async ({ page }) => {
  await openPdf(page, 2, [400, 2400]);
  await display(page, 'Single page');
  await settled(page);
  const workspace = page.locator('.workspace');
  await workspace.focus();
  // The browser scrolls smoothly; the page is left to come to rest before it is moved on.
  const resting = workspace.evaluate(
    (node) => new Promise((resolve) => node.addEventListener('scrollend', resolve, { once: true })),
  );
  await page.keyboard.press('PageDown');
  await resting;
  expect(await workspace.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await workspace.evaluate((node) => (node.scrollTop = node.scrollHeight));
  await page.keyboard.press('PageDown');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await expect.poll(() => workspace.evaluate((node) => node.scrollTop)).toBe(0);
});

test('Page Up turns back to the end of a tall page, not its top', async ({ page }) => {
  await openPdf(page, 2, [400, 2400]);
  await display(page, 'Single page');
  await settled(page);
  const workspace = page.locator('.workspace');
  await workspace.focus();
  await page.keyboard.press('End');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  await expect.poll(() => workspace.evaluate((node) => node.scrollTop)).toBe(0);
  // Read backwards, the bottom of page 1 comes next; its top used to, skipping the rest.
  await page.keyboard.press('PageUp');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await settled(page);
  await expect
    .poll(() =>
      workspace.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
    )
    .toBeLessThan(2);
  expect(await workspace.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});

test('Page Down turns a pair of pages in two-page display', async ({ page }) => {
  await openPdf(page, 5, [300, 300]);
  await display(page, 'Two-page');
  await settled(page);
  await page.locator('.workspace').focus();
  await page.keyboard.press('PageDown');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 5');
  await expect(page.locator('.page-slot:visible')).toHaveCount(2);
});
