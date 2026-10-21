import { expect, it } from 'vitest';
import { toDelimited, parseClipboard } from '../src/core/tsv.js';

// Copied cells go to other apps as tab-separated text too, which is what a chat box, an email or a
// text editor pastes. Every cell holding a quote mark was wrapped in quotes with its own doubled, so
// a cell reading 12" pipe arrived as "12"" pipe". Excel quotes only a cell with a line break (or a
// tab); a quote inside the text stays as it is, and the paste here still reads the cells back.
it('leaves a quote inside a copied cell as it is in the plain text', () => {
  const rows = [['12" pipe', 'He said "hi"', 'plain'], ['5\'11"', 'a"b"c', '']];
  const text = toDelimited(rows);
  expect(text).toBe('12" pipe\tHe said "hi"\tplain\n5\'11"\ta"b"c\t');
  expect(parseClipboard(text)).toEqual(rows);
});

it('still quotes a cell with a line break or a tab, and one starting with a quote', () => {
  const rows = [['line 1\nline 2 "x"', 'a\tb', '"quoted" start', '"']];
  const text = toDelimited(rows);
  expect(text).toBe('"line 1\nline 2 ""x"""\t"a\tb"\t"""quoted"" start"\t""""');
  expect(parseClipboard(text)).toEqual(rows);
});
