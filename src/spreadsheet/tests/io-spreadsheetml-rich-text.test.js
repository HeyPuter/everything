import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// Excel 2003 XML writes a cell with mixed formatting as HTML runs in its <ss:Data>, and a comment's
// text the same way. Only the text inside <Font> runs was kept, so a cell written as
// <B>Total</B><Font html:Color="#FF0000"> due</Font> opened as " due"; a comment kept its "&lt;" and
// "&amp;" as written; and text such as "<b>" (written &lt;b&gt;) was taken out of a rich cell as a tag.

const file = (cells) => new TextEncoder().encode('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
  + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel"'
  + ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">'
  + `<Worksheet ss:Name="Data"><Table><Row>${cells}</Row></Table></Worksheet></Workbook>`);
const rich = (runs) => `<Cell><ss:Data ss:Type="String" xmlns="http://www.w3.org/TR/REC-html40">${runs}</ss:Data></Cell>`;

it('keeps every run of a rich cell, inside a <Font> or not', async () => {
  const wb = await workbookFromFile(file(rich('<B>Total</B><Font html:Color="#FF0000"> due</Font>')
    + rich('<I><Font html:Color="#0000FF">a</Font></I><U>b</U>c') + rich('<B>x &lt;b&gt; &amp;amp; y</B>')), 'rich.xml');
  const id = wb.activeSheetId;
  expect(wb.getValue(id, 0, 0)).toBe('Total due');
  expect(wb.getValue(id, 0, 1)).toBe('abc');
  expect(wb.getValue(id, 0, 2)).toBe('x <b> &amp; y');
});

it('reads a comment\'s text with its characters decoded', async () => {
  const wb = await workbookFromFile(file('<Cell><Data ss:Type="String">x</Data><Comment ss:Author="Ann"><ss:Data xmlns="http://www.w3.org/TR/REC-html40">'
    + '<B><Font html:Face="Tahoma" html:Size="8">Ann:</Font></B><Font html:Face="Tahoma" html:Size="8">&#10;Check &lt;this&gt; &amp; that</Font></ss:Data></Comment></Cell>'
    + '<Cell><Data ss:Type="String">y</Data><Comment><Data>Fish &amp; chips</Data></Comment></Cell>'), 'notes.xml');
  const id = wb.activeSheetId;
  expect(wb.getNote(id, 0, 0)).toBe('Ann:\nCheck <this> & that');
  expect(wb.getNote(id, 0, 1)).toBe('Fish & chips');
});

it('reads a plain cell as before', async () => {
  const wb = await workbookFromFile(file('<Cell><Data ss:Type="String">Fish &amp; chips &#169;</Data></Cell>'), 'plain.xml');
  expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe('Fish & chips ©');
});
