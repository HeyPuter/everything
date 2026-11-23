import { expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { defaultTextFieldAppearanceProvider } from '../src/core/appearance-providers.js';

/** A multi-line field 250 × 120 with the default appearance `da`, holding `text`. */
async function field(text, da) {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const notes = doc.getForm().createTextField('Notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 60, y: 500, width: 250, height: 120, borderWidth: 0 });
  notes.setText(text);
  notes.acroField.dict.set(PDFName.of('DA'), PDFString.of(da));
  return { doc, notes, widget: notes.acroField.getWidgets()[0] };
}
/** The lines drawn, their size, and where each starts. */
function drawn(operators) {
  const ops = operators.map(String);
  const size = Number(
    ops
      .find((op) => op.endsWith(' Tf'))
      .split(' ')
      .at(-2),
  );
  const lines = ops
    .filter((op) => op.endsWith(' Tj'))
    .map((op) => Buffer.from(op.match(/<([0-9A-F]*)>/i)[1], 'hex').toString('latin1'));
  const ys = ops.filter((op) => op.endsWith(' Tm')).map((op) => Number(op.split(' ').at(-2)));
  return { size, lines, ys };
}

const LONG = 'Supercalifragilisticexpialidociousandevenlongerwordwithoutanyspaces then more words';

for (const [da, label] of [
  ['/Helv 12 Tf 0 g', 'a set size'],
  ['/Helv 0 Tf 0 g', 'an automatic size'],
])
  it(`wraps a word wider than a multi-line field, and the words after it, at ${label}`, async () => {
    const { doc, notes, widget } = await field(LONG, da);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const { size, lines, ys } = drawn(defaultTextFieldAppearanceProvider(notes, widget, font));
    // Everything shows, and each line fits the field (less its 1 pt padding each side).
    expect(lines.join('').replace(/ /g, '')).toBe(LONG.replace(/ /g, ''));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(font.widthOfTextAtSize(line, size)).toBeLessThanOrEqual(248);
    // An automatic size still fits all the lines in the field's height.
    expect(ys.at(-1)).toBeGreaterThan(0);
    if (label === 'a set size') expect(size).toBe(12);
  });

it('wraps text without spaces, such as Chinese, between its characters', async () => {
  const text = '这是一个很长的中文句子用于测试多行文本字段的自动换行功能是否正常工作。'.repeat(2);
  const { notes, widget } = await field(text, '/Helv 12 Tf 0 g');
  // A face whose characters are all an em wide, encoding them by code point.
  const font = {
    name: 'CJK',
    widthOfTextAtSize: (line, size) => [...line].length * size,
    heightAtSize: (size) => size,
    encodeText: (line) =>
      PDFHexString.of(
        [...line].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join(''),
      ),
  };
  const ops = defaultTextFieldAppearanceProvider(notes, widget, font).map(String);
  const lines = ops
    .filter((op) => op.endsWith(' Tj'))
    .map((op) =>
      String.fromCodePoint(
        ...op
          .match(/<([0-9A-F]*)>/i)[1]
          .match(/.{4}/g)
          .map((h) => parseInt(h, 16)),
      ),
    );
  expect(lines.join('')).toBe(text);
  // 248 pt at 12 pt an em: 20 characters a line.
  expect(lines.map((line) => [...line].length)).toEqual([20, 20, 20, 10]);
});

// pdf-lib grew a few words until they filled the field (40 pt in this one), where Acrobat,
// PDF.js and the page's own box show them at 12 pt.
it('draws a few words at 12 pt at most in a multi-line field of automatic size', async () => {
  const { doc, notes, widget } = await field('Line one\nLine two', '/Helv 0 Tf 0 g');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { size, lines } = drawn(defaultTextFieldAppearanceProvider(notes, widget, font));
  expect(size).toBe(12);
  expect(lines).toEqual(['Line one', 'Line two']);
  // Words that do not fit at 12 pt still shrink to fit.
  const long = await field('word '.repeat(200), '/Helv 0 Tf 0 g');
  const shrunk = drawn(defaultTextFieldAppearanceProvider(long.notes, long.widget, font));
  expect(shrunk.size).toBeLessThan(12);
  expect(shrunk.ys.at(-1)).toBeGreaterThan(0);
});
