import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

test('Download pages as images shows its format and resolution choices whole', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('One', { x: 40, y: 200, size: 14, font });
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Open a PDF/ })
    .first()
    .click();
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
  await pane.getByRole('button', { name: 'Export a PDF', exact: true }).click();
  await pane.getByRole('button', { name: /Image \(PNG or JPEG\)/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Download pages as images' });
  // "144 dpi (sharp on screens)" was cut off beside the format, and on a phone both were.
  for (const label of ['Format', 'Resolution']) {
    const select = dialog.getByLabel(label, { exact: true });
    const room = await select.evaluate((node) => {
      const style = getComputedStyle(node);
      const context = document.createElement('canvas').getContext('2d');
      context.font = style.font;
      const longest = Math.max(
        ...[...node.options].map((option) => context.measureText(option.text).width),
      );
      // The text sits between the padding, and the drop-down arrow takes about 20 px of it.
      const inner =
        node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 20;
      return inner - longest;
    });
    expect(room, label).toBeGreaterThanOrEqual(0);
  }
});
