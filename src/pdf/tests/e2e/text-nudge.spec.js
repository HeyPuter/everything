import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

async function openNudge(page) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([612, 792]);
  sheet.drawText('Nudge me', { x: 50, y: 700, size: 14, font });
  sheet.drawText('Keep me', { x: 50, y: 600, size: 14, font });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'text-nudge.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Edit text: Nudge me', exact: true }).focus();
  await page.keyboard.press('Enter');
  const handle = page.getByRole('button', { name: 'Move text', exact: true });
  await expect(handle).toBeFocused();
  return handle;
}

// Each arrow key press saved the move at once; the presses that came while it was saving
// went to a handle being replaced and were lost, so five quick presses moved the text 1 pt.
test('quick arrow key presses each move the selected text, and save as one move', async ({
  page,
}) => {
  const handle = await openNudge(page);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  const x = page.getByLabel('Text X in points', { exact: true });
  const y = page.getByLabel('Text Y in points', { exact: true });
  await expect(x).toHaveValue('55');
  await expect(y).toHaveValue('710');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(handle).toBeFocused();
  // One undo takes back the whole run of presses.
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.save-status')).not.toHaveText('Unsaved changes');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.keyboard.press('Meta+Shift+z');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await readFile(await (await pending).path());
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(saved),
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  }).promise;
  const { items } = await (await pdf.getPage(1)).getTextContent();
  const item = items.find((i) => i.str === 'Nudge me');
  expect(item.transform[4]).toBeCloseTo(55, 3);
  expect(item.transform[5]).toBeCloseTo(710, 3);
});

test('Delete and Escape right after an arrow key press act on the moved text', async ({ page }) => {
  await openNudge(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  await expect(page.getByRole('button', { name: 'Edit text: Nudge me', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Edit text: Keep me', exact: true })).toHaveCount(
    1,
  );
  await page.keyboard.press('Meta+z');
  const target = page.getByRole('button', { name: 'Edit text: Nudge me', exact: true });
  await expect(target).toHaveCount(1);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

  await target.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Move text', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  // The move is kept, and Escape lets go of the text.
  await expect(page.getByRole('button', { name: 'Move text', exact: true })).toHaveCount(0);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Move text', exact: true })).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Edit text: Nudge me', exact: true }).click();
  await expect(page.getByLabel('Text Y in points', { exact: true })).toHaveValue('699');
});
