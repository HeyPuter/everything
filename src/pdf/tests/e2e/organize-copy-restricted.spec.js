import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFHexString, PDFNumber } from 'pdf-lib';
import {
  protectPdf,
  unlockPdf,
  aesCbcDecrypt,
  aesCbcEncrypt,
  toHex,
} from '../../src/core/security.js';

// A PDF that forbids copying its words used to cancel every drag in the app, which Organize
// pages moves its tiles with: the pages of a file that allows reordering them would not move.
test.skip(({ isMobile }) => isMobile, 'mice and pens drag tiles');

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: {} };`;

/** Two pages, open without a password, allowing page assembly (bit 11) but not copying. */
async function assembleOnly() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]).drawText('First', { x: 30, y: 350, size: 24 });
  doc.addPage([400, 300]).drawText('Second', { x: 30, y: 250, size: 24 });
  const bytes = await protectPdf(await doc.save(), { open: '', permissions: 'owner' });
  const {
    encryption: { fileKey },
  } = await unlockPdf(bytes, 'owner');
  const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const dict = raw.context.lookup(raw.context.trailerInfo.Encrypt);
  const P = 0xfffff0c0 | (1 << 10) | 0;
  dict.set(PDFName.of('P'), PDFNumber.of(P));
  const perms = aesCbcDecrypt(
    fileKey,
    new Uint8Array(16),
    dict.lookup(PDFName.of('Perms')).asBytes(),
  );
  new DataView(perms.buffer, perms.byteOffset, perms.length).setInt32(0, P, true);
  dict.set(
    PDFName.of('Perms'),
    PDFHexString.of(toHex(aesCbcEncrypt(fileKey, new Uint8Array(16), perms))),
  );
  return Buffer.from(await raw.save({ useObjectStreams: false }));
}

test('a PDF that forbids copying still has its pages dragged in Organize pages', async ({
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
  ).setFiles({ name: 'locked.pdf', mimeType: 'application/pdf', buffer: await assembleOnly() });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Organize pages' }).first().click();
  const tiles = page.locator('.organize-tile');
  await expect(tiles).toHaveCount(2);
  await tiles.nth(0).dragTo(tiles.nth(1), { targetPosition: { x: 150, y: 60 } });
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
});
