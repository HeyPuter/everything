import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

// Opens Organize pages from the desktop tools pane.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

/** Two pages, each with a black square drawn in the layer "Ink". */
async function inkedPages() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const ink = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Ink') }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ink], D: { ON: [ink] } }));
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([300, 300]);
    const content = ctx.register(ctx.stream('/OC /L0 BDC 0 0 0 rg 50 50 200 200 re f EMC', {}));
    page.node.set(PDFName.of('Contents'), content);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Properties: { L0: ink } }));
  }
  return doc.save();
}
/** How many dark pixels the first tile's picture has. */
const inkOnTile = (page) =>
  page
    .locator('.organize-tile canvas')
    .first()
    .evaluate((canvas) => {
      if (!canvas.width) return -1;
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && data[i] < 60) dark++;
      return dark;
    });

test('switching a layer off in Organize pages takes it off the page tiles too', async ({
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
  ).setFiles({
    name: 'ink.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await inkedPages()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await page.getByRole('button', { name: 'Organize pages' }).first().click();
  await expect.poll(() => inkOnTile(page)).toBeGreaterThan(100);
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel' }).click();
  await tabs.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('checkbox', { name: 'Ink', exact: true }).uncheck();
  await expect.poll(() => inkOnTile(page)).toBe(0);
  await page.getByRole('checkbox', { name: 'Ink', exact: true }).check();
  await expect.poll(() => inkOnTile(page)).toBeGreaterThan(100);
});
