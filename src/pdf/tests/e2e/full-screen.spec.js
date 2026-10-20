import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts, PDFString } from 'pdf-lib';

// Full screen shows the pages alone: anything the app pops over them has to show there too.
const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

async function openLinkedPdf(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 400]);
  first.drawText('Visit our website', { x: 40, y: 340, size: 18, font });
  first.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 335, 200, 360],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of('https://example.com/') },
      }),
    ),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'link.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
async function enterFullScreen(page) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible()) await bar.getByRole('menuitem', { name: 'View', exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  }
  await page.getByRole('menuitem', { name: 'Full screen mode', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe('document-area');
}
/** Whether the element is what the reader sees at its own center, not something hidden under it. */
const onTop = (locator) =>
  locator.evaluate((node) => {
    // The message box lets taps through, which hit testing would skip; it is tested as a box.
    const events = node.style.pointerEvents;
    node.style.pointerEvents = 'auto';
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    node.style.pointerEvents = events;
    return node.contains(hit);
  });

test('a menu and its message show over the pages in full screen', async ({ page }) => {
  await openLinkedPdf(page);
  await enterFullScreen(page);
  await page.locator('.link-target').first().click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Link', exact: true });
  await expect(menu).toBeVisible();
  expect(await onTop(menu)).toBe(true);
  await menu.getByRole('menuitem', { name: 'Remove link', exact: true }).click();
  const toast = page.locator('#toast');
  await expect(toast).toHaveText('Link removed.');
  expect(await onTop(toast)).toBe(true);
  // Leaving full screen hands the message back to the page, where the next one shows.
  await page.evaluate(() => document.exitFullscreen());
  await expect
    .poll(() => toast.evaluate((node) => node.parentElement === document.body))
    .toBe(true);
  await expect(toast).toHaveText('Link removed.');
});

test('closing the PDF from full screen keeps the message box for the library', async ({ page }) => {
  await openLinkedPdf(page);
  await enterFullScreen(page);
  await page.locator('.link-target').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove link', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Link removed.');
  await page.evaluate(() => (location.hash = '#library'));
  await page
    .getByRole('dialog', { name: 'Leave this PDF?' })
    .getByRole('button', { name: 'Leave without saving', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Your PDFs' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect(page.locator('#toast')).toHaveCount(1);
  expect(
    await page.evaluate(() => document.querySelector('#toast').parentElement === document.body),
  ).toBe(true);
});
