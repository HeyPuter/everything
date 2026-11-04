import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'keyboard form filling');

test('Tab goes on from the last field of a page to the fields of the next page', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const form = doc.getForm();
  // Fields on the first and third pages; none on the second or the last.
  for (const [index, names] of [['A1', 'A2'], [], ['C1', 'C2'], []].entries()) {
    const sheet = doc.addPage([500, 400]);
    names.forEach((name, i) =>
      form
        .createTextField(name)
        .addToPage(sheet, { x: 40, y: 300 - i * 60, width: 200, height: 24 }),
    );
    if (!names.length) sheet.drawText(`Page ${index + 1}`, { x: 40, y: 300, size: 14 });
  }
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'pages.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await settled(page);
  const field = (name) => page.getByRole('textbox', { name: `${name} (on page)` });
  await field('A1').fill('one');
  await page.keyboard.press('Tab');
  await expect(field('A2')).toBeFocused();
  await page.keyboard.type('two');
  await page.keyboard.press('Tab');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 4');
  await expect(field('C1')).toBeFocused();
  await page.keyboard.type('three');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
  await expect(field('A2')).toBeFocused();
  await expect(field('A2')).toHaveValue('two');
  // Past the form's last field, Tab leaves the page as usual.
  await page.keyboard.press('Tab');
  await expect(field('C1')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(field('C2')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 4');
  expect(await page.evaluate(() => !!document.activeElement.closest('.form-layer'))).toBe(false);
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const values = Object.fromEntries(
    saved
      .getForm()
      .getFields()
      .map((f) => [f.getName(), f.getText() ?? '']),
  );
  expect(values).toEqual({ A1: 'one', A2: 'two', C1: 'three', C2: '' });
});
