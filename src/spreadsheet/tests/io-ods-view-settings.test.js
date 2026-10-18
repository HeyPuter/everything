import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// LibreOffice keeps a sheet's frozen rows and columns, its tab colour and the sheet a book opens on in its
// view settings (settings.xml, ooo:view-settings), which an .ods from here did not write and which were not
// read: Download as .ods opened in LibreOffice with the header rows scrolling away and plain tabs, and a
// LibreOffice spreadsheet opened here unfrozen on its first sheet.

const entryOf = (bytes, name) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), name).content);
const item = (name, type, value) => `<config:config-item config:name="${name}" config:type="${type}">${value}</config:config-item>`;

it('writes the frozen panes, tab colours and open sheet where LibreOffice reads them', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Summary' }, { name: 'Q1 & Q2' }, { name: 'Notes' }] });
  const [, data, notes] = wb.sheets;
  wb.setFrozen(data.id, 1, 2);
  wb.setSheetColor(data.id, '#3366ff');
  wb.setFrozen(notes.id, 3, 0);
  wb.setActiveSheet(data.id);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const settings = entryOf(bytes, 'settings.xml');
  const table = (name) => settings.match(new RegExp(`<config:config-item-map-entry config:name="${name}">([\\s\\S]*?)</config:config-item-map-entry>`))?.[1];
  expect(table('Q1 &amp; Q2')).toContain(item('HorizontalSplitMode', 'short', 2) + item('HorizontalSplitPosition', 'int', 2));
  expect(table('Q1 &amp; Q2')).toContain(item('VerticalSplitMode', 'short', 2) + item('VerticalSplitPosition', 'int', 1));
  expect(table('Q1 &amp; Q2')).toContain(item('TabColor', 'int', 0x3366ff));
  expect(table('Notes')).toContain(item('VerticalSplitPosition', 'int', 3));
  expect(table('Notes')).not.toContain('HorizontalSplitMode');
  expect(table('Summary')).toBeUndefined();
  expect(settings).toContain(item('ActiveTable', 'string', 'Q1 &amp; Q2'));
  // Read back as another program's file (no settings of this app's own), they come through.
  const back = await workbookFromFile(bytes, 'quarters.ods');
  expect(back.sheets.map((s) => [s.name, s.frozenRows, s.frozenCols, s.color])).toEqual([
    ['Summary', 0, 0, null], ['Q1 & Q2', 1, 2, '#3366ff'], ['Notes', 3, 0, null]]);
  expect(back.activeSheet.name).toBe('Q1 & Q2');
});

it("reads a LibreOffice file's view settings, leaving a plain split and an automatic tab colour alone", async () => {
  const book = X.utils.book_new();
  for (const name of ['Sheet1', 'Sheet2', 'Sheet3']) X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['x']]), name);
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'ods' })), { type: 'array' });
  const tableEntry = (name, items) => `<config:config-item-map-entry config:name="${name}">${items.join('')}</config:config-item-map-entry>`;
  const settings = `<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.3"><office:settings>
    <config:config-item-set config:name="ooo:view-settings">${item('VisibleAreaTop', 'int', 0)}
      <config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>${item('ViewId', 'string', 'view1')}
        <config:config-item-map-named config:name="Tables">
          ${tableEntry('Sheet1', [item('CursorPositionX', 'int', 0), item('HorizontalSplitMode', 'short', 0), item('VerticalSplitMode', 'short', 2), item('HorizontalSplitPosition', 'int', 0), item('VerticalSplitPosition', 'int', 1), item('ActiveSplitRange', 'short', 2), item('PositionBottom', 'int', 1), item('ZoomValue', 'int', 100), item('TabColor', 'int', -1)])}
          ${tableEntry('Sheet2', [item('HorizontalSplitMode', 'short', 1), item('VerticalSplitMode', 'short', 1), item('HorizontalSplitPosition', 'int', 2500), item('VerticalSplitPosition', 'int', 800), item('TabColor', 'int', 16711680)])}
          ${tableEntry('Sheet3', [item('HorizontalSplitMode', 'short', 2), item('HorizontalSplitPosition', 'int', 1), item('VerticalSplitMode', 'short', 0)])}
        </config:config-item-map-named>${item('ActiveTable', 'string', 'Sheet3')}${item('HorizontalScrollbarWidth', 'int', 1241)}
      </config:config-item-map-entry></config:config-item-map-indexed>
    </config:config-item-set>
    <config:config-item-set config:name="ooo:configuration-settings">${item('ShowGrid', 'boolean', 'true')}</config:config-item-set>
  </office:settings></office:document-settings>`;
  X.CFB.utils.cfb_add(zip, 'settings.xml', new TextEncoder().encode(settings));
  const wb = await workbookFromFile(new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), 'libre.ods');
  expect(wb.sheets.map((s) => [s.name, s.frozenRows, s.frozenCols, s.color])).toEqual([
    ['Sheet1', 1, 0, null], ['Sheet2', 0, 0, '#ff0000'], ['Sheet3', 0, 1, null]]);
  expect(wb.activeSheet.name).toBe('Sheet3');
});
