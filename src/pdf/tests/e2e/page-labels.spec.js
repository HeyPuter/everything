import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop page panel');

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

/** Six pages: three of front matter numbered i, ii, iii, then 1, 2, 3. */
async function labelledPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 6; i++)
    doc.addPage([300, 400]).drawText(`Sheet ${i + 1}`, { x: 40, y: 200, size: 20, font });
  doc.catalog.set(
    PDFName.of('PageLabels'),
    doc.context.obj({ Nums: [0, { S: PDFName.of('r') }, 3, { S: PDFName.of('D') }] }),
  );
  return Buffer.from(await doc.save());
}

test('pages with labels of their own are named by them in the caption, thumbnails and grid', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'book.pdf', mimeType: 'application/pdf', buffer: await labelledPdf() });
  const caption = page.locator('.page-caption');
  await expect(caption).toHaveText('Page i (1 of 6)');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const labels = page.locator('.thumbnail > span');
  await expect(labels).toHaveText(['i', 'ii', 'iii', '1', '2', '3']);
  await expect(page.getByRole('button', { name: 'Go to page 4 (1)' })).toBeVisible();

  await page.getByRole('button', { name: 'Go to page 5 (2)' }).click();
  await expect(caption).toHaveText('Page 2 (5 of 6)');

  // The labels move with the pages: with page ii deleted, page iii becomes ii.
  await page.getByRole('button', { name: 'Page 2 actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page' }).click();
  await expect(labels).toHaveText(['i', 'ii', '1', '2', '3']);
  await expect(caption).toHaveText('Page 2 (4 of 5)');

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await expect(grid.locator('.organize-label')).toHaveText(['i', 'ii', '1', '2', '3']);
  await expect(grid.getByRole('option', { name: 'Page 3 (1)' })).toBeVisible();
});

// A link and the dialogs' Current page named the page by its number alone, while the caption
// names it by its label first: "Page iii (3 of 6)" was "Link to page 3", "Current page (3)".
test('links and the Current page choice name a labelled page as the caption does', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  const source = await PDFDocument.load(await labelledPdf());
  source.getPage(0).node.addAnnot(
    source.context.register(
      source.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 300, 200, 330],
        Dest: [source.getPage(2).ref, 'Fit'],
      }),
    ),
  );
  source.getPage(0).node.addAnnot(
    source.context.register(
      source.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 340, 200, 370],
        Dest: [source.getPage(4).ref, 'Fit'],
      }),
    ),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'book.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page i (1 of 6)');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Link to page iii (3)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Link to page 2 (5)' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+p');
  await expect(
    page.getByRole('dialog', { name: 'Print' }).getByRole('radio', { name: 'Current page i (1)' }),
  ).toBeVisible();
});
