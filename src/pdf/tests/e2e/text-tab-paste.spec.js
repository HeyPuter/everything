import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { clickAway } from './editing-helpers.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

/** Put text on the system clipboard and paste it with the keyboard, as a person does. */
async function paste(page, text) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press('ControlOrMeta+v');
}
async function exportedText(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = new Uint8Array(await readFile(await (await pending).path()));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const content = await (await (await task.promise).getPage(1)).getTextContent();
    return content.items.map((item) => item.str).join(' ');
  } finally {
    await task.destroy();
  }
}

// Spreadsheet cells and tables copy with tabs between them. The text fonts have no tab, so a
// pasted tab becomes spaces, as it does in a text box comment, instead of failing the edit.
test('text pasted with tabs is added and edited with spaces in their place', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  sheet.drawText('Hello world', { x: 60, y: 600, size: 20, font });
  // Mixed fonts on one line edit as styled spans rather than a plain text field.
  sheet.drawText('Mixed ', { x: 60, y: 500, size: 20, font });
  sheet.drawText('bold', {
    x: 60 + font.widthOfTextAtSize('Mixed ', 20),
    y: 500,
    size: 20,
    font: bold,
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'tab-paste.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Text', exact: true }).click();

  await page.getByRole('button', { name: 'Place at page center' }).click();
  const added = page.getByLabel('Text to add', { exact: true });
  await added.focus();
  await paste(page, 'Name\tValue');
  await expect(added).toHaveValue('Name    Value');
  await clickAway(page);
  await expect(added).toHaveCount(0);
  await settled(page);

  await page.getByRole('button', { name: 'Edit text: Hello world', exact: true }).click();
  const edited = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(edited).toBeFocused();
  await settled(page);
  await edited.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
  await paste(page, '\tA\tB');
  await clickAway(page);
  await expect(edited).toHaveCount(0);
  await settled(page);

  await page.getByRole('button', { name: 'Edit text: Mixed bold', exact: true }).click();
  const styled = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(styled).toBeFocused();
  await settled(page);
  await styled.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node.lastElementChild);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await paste(page, '\tC');
  await expect.poll(() => styled.evaluate((node) => node.value)).toBe('Mixed bold    C');
  await clickAway(page);
  await expect(styled).toHaveCount(0);
  await settled(page);
  await expect(page.locator('.text-edit-error')).toHaveCount(0);
  const text = await exportedText(page);
  expect(text).toMatch(/Name\s+Value/);
  expect(text).toMatch(/Hello world\s+A\s+B/);
  expect(text).toMatch(/Mixed\s+bold\s+C/);
});

// A browser cuts a paste short at a field's length limit without a word. Text too long to keep
// must be refused with a reason, with the draft left whole for shortening.
test('text pasted beyond the length limit is not cut short without a word', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Hello world', { x: 60, y: 600, size: 20, font });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'long-paste.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const long = 'word '.repeat(1200);
  // An existing line, then new text.
  await page.getByRole('button', { name: 'Edit text: Hello world', exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await input.press('ControlOrMeta+a');
  await paste(page, long);
  await expect.poll(() => input.evaluate((node) => node.value.length)).toBe(long.length);
  await clickAway(page);
  await expect(page.locator('.text-edit-error')).toHaveText(
    'Keep text edits under 5,000 characters.',
  );
  await input.press('Escape');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.drawing-overlay').click({ position: { x: 60, y: 300 } });
  const added = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await expect(added).toBeFocused();
  await paste(page, long);
  await expect.poll(() => added.evaluate((node) => node.value.length)).toBe(long.length);
  await clickAway(page);
  await expect(page.locator('.text-edit-error')).toHaveText(
    'Keep text edits under 5,000 characters.',
  );
  expect(await added.evaluate((node) => node.value.length)).toBe(long.length);
});
