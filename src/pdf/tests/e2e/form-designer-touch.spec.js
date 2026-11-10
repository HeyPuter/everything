import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => !isMobile, 'touch screens');

test('a field’s resize handle is big enough to take with a finger', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const note = doc.getForm().createTextField('Note');
  note.addToPage(doc.addPage([400, 500]), { x: 60, y: 300, width: 160, height: 24 });
  const start = note.acroField.getWidgets()[0].getRectangle();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'form.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Prepare a form', exact: true }).click();
  // On a phone the pane steps aside once a field type is chosen.
  await pane.getByRole('button', { name: 'Text field', exact: true }).click();
  await expect(pane).toBeHidden();
  await pane
    .getByRole('button', { name: /Close|Back/ })
    .first()
    .isVisible();
  const field = page.locator('.designer-field[data-key="Note#0"]');
  await field.dispatchEvent('focus');
  const handle = field.locator('.designer-resize');
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  // Taken near its outer edge, past where a small handle would end, the corner resizes the field.
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 20, box.y + box.height - 3, { steps: 4 });
  await page.mouse.up();
  await settled(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const rect = saved.getForm().getTextField('Note').acroField.getWidgets()[0].getRectangle();
  expect(rect.width).toBeGreaterThan(start.width + 10);
});
