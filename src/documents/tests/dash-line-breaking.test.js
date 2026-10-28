import { it, expect } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { cellIntrinsicWidths } from '../src/engine/intrinsic-widths.js';

const measure = text => ({ width: [...text].length * 8, ascent: 15, descent: 5 });
// `width` is the writing width in characters; the page adds a 10 px margin on each side.
const lines = (text, width) => layoutDocument([paragraph(text, { format: { spaceAfter: 0 } })], measure, { width: width * 8 + 20, height: 4000, margin: 10 })
  .lines.map(l => text.slice(l.start, l.end));

it('wraps after an em dash or en dash instead of splitting the next word', () => {
  // Before, the dash was no break opportunity: the line was filled and "cccc" lost a letter.
  expect(lines('aaaaaaaaaa—bbbbbbbbbb—cccc', 25)).toEqual(['aaaaaaaaaa—bbbbbbbbbb—', 'cccc']);
  expect(lines('pages 10–20 and 30–40 apply', 14)).toEqual(['pages 10–20 ', 'and 30–40 ', 'apply']);
  expect(lines('pages 10–20', 10)).toEqual(['pages 10–', '20']);
});

it('wraps at a zero-width space, as authors insert into long paths and addresses', () => {
  const path = 'https://example.com/​documents/​reports/​annual';
  expect(lines(path, 34)).toEqual(['https://example.com/​documents/​', 'reports/​annual']);
});

it('keeps a doubled dash and the punctuation after a dash on the line', () => {
  expect(lines('x aa——b', 5)).toEqual(['x ', 'aa——b']);
  expect(lines('x aaaa—” b', 7)).toEqual(['x ', 'aaaa—” ', 'b']);
  expect(lines('x aaaa—, b', 7)).toEqual(['x ', 'aaaa—, ', 'b']);
});

it('sizes AutoFit cells to the widest part between dashes', () => {
  const page = { width: 500, height: 500, left: 0, right: 0, top: 0, bottom: 0 };
  const metrics = text => cellIntrinsicWidths({ margins: { left: 0, right: 0 }, content: [{ paragraph: paragraph('', { format: { spaceAfter: 0 }, runs: [{ text }] }), index: 0 }] }, measure, page, undefined, []);
  expect(metrics('long—er—word')).toMatchObject({ min: 40, max: 96 });
});

it('never wraps at a zero-width no-break space or beside a word joiner', () => {
  // U+FEFF counted as white space, so a line ended there and split the joined text.
  expect(lines('aaaa bbbbbbbbbbbb\ufeffcccccccccccc', 25)).toEqual(['aaaa ', 'bbbbbbbbbbbb\ufeffcccccccccccc']);
  expect(lines('x aaaa\u2014\u2060bbbb', 8)).toEqual(['x ', 'aaaa\u2014\u2060bb', 'bb']);
});
