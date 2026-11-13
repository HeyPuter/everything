import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFHexString, PDFNumber } from 'pdf-lib';
import {
  protectPdf,
  unlockPdf,
  aesCbcDecrypt,
  aesCbcEncrypt,
  toHex,
} from '../../src/core/security.js';

// A PDF whose permissions allow no changes, opened without a password.
async function restricted() {
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]).drawText('Restricted report', { x: 25, y: 450, size: 20 });
  doc.addPage([400, 500]).drawText('Second sheet');
  const bytes = await protectPdf(await doc.save(), { open: '', permissions: 'owner' });
  const {
    encryption: { fileKey },
  } = await unlockPdf(bytes, 'owner');
  const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const dict = raw.context.lookup(raw.context.trailerInfo.Encrypt);
  const P = 0xfffff0c0 | 0;
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
  return Buffer.from(await raw.save({ useObjectStreams: false, updateFieldAppearances: false }));
}

test('the find box offers a tool the PDF does not allow as unavailable', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'restricted.pdf', mimeType: 'application/pdf', buffer: await restricted() });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('combobox', { name: 'Find in PDF', exact: true });
  await find.fill('redact');
  const redact = page.getByRole('option', { name: 'Open tool: Redact a PDF', exact: true });
  // The pane shows Redact a PDF dimmed for this PDF; the suggestion says so too.
  await expect(redact).toBeDisabled();
  await find.press('ArrowDown');
  await find.press('Enter');
  // Choosing it is not a silent no-op that throws the words away: the find bar stays.
  await expect(find).toBeFocused();
  await expect(find).toHaveValue('redact');
  // A tool the PDF allows still opens.
  await find.fill('protect');
  const protect = page.getByRole('option', { name: 'Open tool: Protect a PDF', exact: true });
  await expect(protect).toBeEnabled();
  await protect.click();
  await expect(page.locator('.tools-panel-title')).toHaveText('Protect a PDF');
});
