import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// ODF collapses and trims only the XML white space characters (space, tab, line feed, return) of a
// paragraph. The .ods reader trimmed with JavaScript's trim(), which also takes no-break spaces and
// the ideographic space off a text's ends, so "Note:" followed by a no-break space, as Microsoft's
// templates write it, lost that space when saved as .ods and opened again, and a Japanese label
// indented with an ideographic space lost its indent.

const file = (cells) => new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>'
  + '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
  + ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">'
  + `<office:body><office:spreadsheet><table:table table:name="Data"><table:table-row>${cells}</table:table-row></table:table></office:spreadsheet></office:body></office:document>`);
const text = (t) => `<table:table-cell office:value-type="string"><text:p>${t}</text:p></table:table-cell>`;

it('keeps no-break and ideographic spaces at the ends of a cell\'s text', async () => {
  const wb = await workbookFromFile(file(text('Note: ') + text('　見出し') + text('  x  ')), 'spaces.fods');
  const id = wb.activeSheetId;
  expect([0, 1, 2].map((c) => wb.getValue(id, 0, c))).toEqual(['Note: ', '　見出し', '  x  ']);
});

it('still trims the white space ODF ignores', async () => {
  const wb = await workbookFromFile(file(text('\n   padded\t ') + text('a <text:s/>b')), 'plain.fods');
  expect([wb.getValue(wb.activeSheetId, 0, 0), wb.getValue(wb.activeSheetId, 0, 1)]).toEqual(['padded', 'a  b']);
});

it('keeps them through a save as .ods', async () => {
  const wb = new Workbook();
  wb.setInput(wb.activeSheetId, 0, 0, 'Note: ');
  const back = await workbookFromFile(new Uint8Array(await (await workbookToOds(wb)).arrayBuffer()), 'saved.ods');
  expect(back.getValue(back.activeSheetId, 0, 0)).toBe('Note: ');
});
