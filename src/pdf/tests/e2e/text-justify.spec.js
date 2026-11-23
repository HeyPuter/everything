import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import {
  PDFDocument,
  StandardFonts,
  beginText,
  endText,
  setFontAndSize,
  setWordSpacing,
  moveText,
  showText,
} from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const lines = [
  'The committee reviewed the proposed changes to the annual',
  'budget and agreed that the allocation for maintenance should',
  'increase by a modest amount, while the remaining categories',
  'stay the same as in the previous year.',
];
const column = 320,
  indent = 22;

/** A justified paragraph, its first line indented, as word processors write it. */
async function justifiedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const natural = (text) => [...text].reduce((sum, c) => sum + font.widthOfTextAtSize(c, 11), 0);
  const sheet = doc.addPage([400, 400]);
  const name = sheet.node.newFontDictionary('F', font.ref);
  sheet.pushOperators(beginText(), setFontAndSize(name, 11));
  lines.forEach((text, i) => {
    const start = i ? 0 : indent;
    const spaces = text.split(' ').length - 1;
    // Word spacing spreads every line but the last to the column's edge.
    sheet.pushOperators(
      setWordSpacing(i < lines.length - 1 ? (column - start - natural(text)) / spaces : 0),
      moveText(i ? (i === 1 ? -indent : 0) : 40 + indent, i ? -14 : 300),
      showText(font.encodeText(text)),
    );
  });
  sheet.pushOperators(endText());
  return { bytes: await doc.save(), natural };
}

async function savedRows(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(await (await pending).path())),
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const content = await (await (await task.promise).getPage(1)).getTextContent();
    return content.items.filter((item) => item.str.trim());
  } finally {
    await task.destroy();
  }
}

test('an edited justified paragraph is saved justified, its first line still indented', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const { bytes } = await justifiedPdf();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'justified.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  // The whole paragraph, its indented first line included, is one edit.
  await page.locator('[aria-label^="Edit text: The committee reviewed"]').click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveText(lines.join(' '));
  const style = await input.evaluate((el) => ({
    align: getComputedStyle(el).textAlign,
    indent: parseFloat(getComputedStyle(el).textIndent),
    width: el.getBoundingClientRect().width,
  }));
  expect(style.align).toBe('justify');
  expect(style.indent / style.width).toBeCloseTo(indent / column, 1);
  await input.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.querySelector('span').firstChild, 0);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.type('This week, ');
  await clickAway(page);
  await expect(input).toHaveCount(0);
  const rows = await savedRows(page);
  expect(
    rows
      .map((row) => row.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).toBe(`This week, ${lines.join(' ')}`);
  // PDF.js splits a widely spaced line into words: gather them back into lines.
  const saved = [...Map.groupBy(rows, (row) => Math.round(row.transform[5])).values()];
  expect(saved.length).toBeGreaterThanOrEqual(4);
  // The first line starts at its indent and the others at the margin; every line but the
  // last ends at the column's right edge, and the last keeps its natural spacing.
  expect(saved.map((line) => line[0].transform[4])).toEqual([
    expect.closeTo(40 + indent, 1),
    ...saved.slice(1).map(() => expect.closeTo(40, 1)),
  ]);
  const ends = saved.map((line) => line.at(-1).transform[4] + line.at(-1).width);
  for (const end of ends.slice(0, -1)) expect(end).toBeCloseTo(40 + column, 0);
  expect(ends.at(-1)).toBeLessThan(40 + column - 11);
});
