import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Drives the desktop menu bar.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  await bar.getByRole('menuitem', { name: 'Page', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name, exact: true }).click();
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
/** Each page says which it is, so the page on view can be told apart after a move. */
async function namedPages(count) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++)
    doc.addPage([300, 300]).drawText(`Sheet ${i + 1}`, { x: 20, y: 250, size: 18, font });
  return doc;
}
/** The text of the page being worked on. */
const shown = (page) => page.locator('.paper .textLayer');

test('a page move and its undo keep the moved page on view', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await namedPages(6));
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 6');
  await expect(shown(page)).toContainText('Sheet 3');
  await menu(page, 'Move page later');
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 6');
  await expect(shown(page)).toContainText('Sheet 3');
  await expect(page.locator('.paper')).toBeInViewport({ ratio: 0.5 });
  await page.keyboard.press('Meta+Z');
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 6');
  await expect(shown(page)).toContainText('Sheet 3');
  await expect(page.locator('.paper')).toBeInViewport({ ratio: 0.5 });
  await page.keyboard.press('Meta+Shift+Z');
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 6');
  await expect(shown(page)).toContainText('Sheet 3');
  await expect(page.locator('.paper')).toBeInViewport({ ratio: 0.5 });
});

test('undoing a page added before the page on view keeps that page on view', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await namedPages(6));
  const input = page.getByLabel('Page number', { exact: true });
  await input.fill('5');
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 5 of 6');
  await page.getByRole('button', { name: 'Page 2 actions' }).click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Duplicate page', exact: true })
    .click();
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 6 of 7');
  await expect(shown(page)).toContainText('Sheet 5');
  await page.keyboard.press('Meta+Z');
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 5 of 6');
  await expect(shown(page)).toContainText('Sheet 5');
});

test('a page on view that moves keeps its place on screen, partway down it', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 6; i++)
    doc.addPage([300, 900]).drawText(`Sheet ${i + 1}`, { x: 20, y: 850, size: 18, font });
  await openPdf(page, doc);
  const input = page.getByLabel('Page number', { exact: true });
  await input.fill('3');
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 6');
  await settled(page);
  // Read on partway down the page.
  const workspace = page.locator('.workspace');
  await workspace.evaluate((node) => (node.scrollTop += 150));
  const offset = () =>
    page.evaluate(
      () =>
        document.querySelector('.paper').getBoundingClientRect().top -
        document.querySelector('.workspace').getBoundingClientRect().top,
    );
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 6');
  const before = await offset();
  expect(before).toBeLessThan(-100);
  await menu(page, 'Move page later');
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 6');
  expect(Math.abs((await offset()) - before)).toBeLessThan(2);
  // A page deleted before it leaves it in place too.
  await page.getByRole('button', { name: 'Page 1 actions' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete page', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page', exact: true }).click();
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 5');
  expect(Math.abs((await offset()) - before)).toBeLessThan(2);
  await page.keyboard.press('Meta+Z');
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 6');
  await expect(shown(page)).toContainText('Sheet 3');
  expect(Math.abs((await offset()) - before)).toBeLessThan(2);
  // The page that takes the place of a deleted page on view is shown from its top.
  await input.fill('6');
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 6 of 6');
  await settled(page);
  await workspace.evaluate((node) => (node.scrollTop += 150));
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
  await menu(page, 'Delete page');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page', exact: true }).click();
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 5 of 5');
  expect(await offset()).toBeGreaterThanOrEqual(0);
});

test('once the reader has gone to another page, Undo of a page move leaves the view alone', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await namedPages(6));
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 6');
  await menu(page, 'Move page later');
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 6');
  // Away and back to the same page number: the reader chose it, the edit did not.
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 6');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 6');
  await settled(page);
  await page.keyboard.press('Meta+Z');
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 6');
  await expect(shown(page)).toContainText('Sheet 4');
});
