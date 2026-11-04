import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

// Hebrew drawn as PDFs draw it: glyph after glyph from the left, so "שלום" is stored ם ו ל ש.
const SHALOM = '<01020304>';

async function openDocument(page, content) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([500, 500]);
  const font = doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      FirstChar: 1,
      LastChar: 6,
      Widths: [600, 600, 600, 600, 333, 333],
      Encoding: {
        Type: 'Encoding',
        Differences: [
          1,
          'finalmemhebrew',
          'vavhebrew',
          'lamedhebrew',
          'shinhebrew',
          'parenleft',
          'parenright',
        ],
      },
    }),
  );
  sheet.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font } }));
  sheet.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'rtl.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

async function exportedText(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = await readFile(await (await pending).path());
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items;
    return items.map((item) => item.str).filter(Boolean);
  } finally {
    await task.destroy();
  }
}

for (const [label, content] of [
  ['one text command', `BT /F 30 Tf 50 300 Td ${SHALOM} Tj ET`],
  ['two text commands', 'BT /F 30 Tf 50 300 Td <0102> Tj <0304> Tj ET'],
])
  test(`right-to-left text is edited in reading order (${label})`, async ({ page }) => {
    await openDocument(page, content);
    const target = page.getByRole('button', { name: 'Edit text: שלום', exact: true });
    await expect(target).toBeVisible();
    await target.dblclick();
    const input = page.getByRole('textbox', { name: 'Edit text' });
    await expect(input).toBeFocused();
    expect(await input.evaluate((node) => node.value)).toBe('שלום');
    // Retype the word without its first letter, in the order it is read.
    await input.evaluate((node) => {
      if (node.select) node.select();
      else window.getSelection().selectAllChildren(node);
    });
    await page.keyboard.insertText('לום');
    await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Edit text: לום', exact: true })).toBeVisible();
    expect(await exportedText(page)).toEqual(['לום']);
  });

test('parentheses in right-to-left text open and close the way they read', async ({ page }) => {
  // "(שלום)" as a PDF draws it: the "(" glyph at the left closes the parenthesis.
  await openDocument(page, 'BT /F 30 Tf 50 300 Td <050102030406> Tj ET');
  const target = page.getByRole('button', { name: 'Edit text: (שלום)', exact: true });
  await expect(target).toBeVisible();
  await target.dblclick();
  const input = page.getByRole('textbox', { name: 'Edit text' });
  await expect(input).toBeFocused();
  expect(await input.evaluate((node) => node.value)).toBe('(שלום)');
  await input.evaluate((node) => {
    if (node.select) node.select();
    else window.getSelection().selectAllChildren(node);
  });
  await page.keyboard.insertText('(לום)');
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // Drawn from the left as "(םול)", so the page shows what was typed.
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  const contents = doc.getPage(0).node.Contents();
  const streams = contents.asArray
    ? contents.asArray().map((ref) => doc.context.lookup(ref))
    : [contents];
  const { inflateSync } = await import('node:zlib');
  const source = streams
    .map((stream) => {
      const bytes = stream.getContents();
      return Buffer.from(
        stream.dict.has(PDFName.of('Filter')) ? inflateSync(bytes) : bytes,
      ).toString('latin1');
    })
    .join('\n');
  expect(source).toContain('<0501020306> Tj');
});
