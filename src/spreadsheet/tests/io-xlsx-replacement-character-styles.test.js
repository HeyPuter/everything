import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

/** A one-cell workbook whose styles part is changed by `edit`. */
function styledFile(edit) {
  const zip = X.CFB.read(new Uint8Array(X.write({ SheetNames: ['Data'], Sheets: { Data: { '!ref': 'A1', A1: { t: 's', v: 'Kept' } } } }, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const styles = X.CFB.find(zip, '/xl/styles.xml');
  styles.content = new TextEncoder().encode(edit(new TextDecoder().decode(styles.content)));
  styles.size = styles.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

// A font name another program mangled into replacement characters (a Chinese face, say, written in the wrong
// encoding as "��") is well-formed text, which the XML parser only warns about. The styles reader took that
// warning for broken markup, and the whole file failed to open with "Unicode replacement character
// detected, source encoding issues?".
it('opens a file whose styles name a font with replacement characters', async () => {
  const bytes = styledFile((xml) => xml.replace(/<name val="[^"]*"\/>/, '<name val="��"/>'));
  const wb = await workbookFromFile(bytes, 'mangled.xlsx');
  expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe('Kept');
  const back = await workbookFromFile(await workbookToXlsx(wb), 'saved.xlsx');
  expect(back.getValue(back.activeSheetId, 0, 0)).toBe('Kept');
});
