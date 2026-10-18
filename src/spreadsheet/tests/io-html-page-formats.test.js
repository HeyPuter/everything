// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// A web page's table (an .html file, or an .xls that is a saved web page, as bank statements and
// report exports often are) was read by the library's markup scanner, which knows no CSS: account
// numbers marked as text (mso-number-format:"\@") lost their leading zeros, 50% opened as 0.5 and
// $12 as 12, links and bold headers were dropped. Where the browser parses HTML the table is now
// read as a paste of it is.

const open = (html, name = 'statement.xls') => workbookFromFile(new TextEncoder().encode(html), name);
const at = (wb, r, c) => ({ value: wb.getValue(wb.activeSheetId, r, c), shown: wb.getDisplay(wb.activeSheetId, r, c) });

const statement = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style>.txt { mso-number-format: "\\@"; } .amt { mso-number-format: "\\#\\,\\#\\#0\\.00"; }</style></head>
<body><table border="1">
<tr><th>Account</th><th>Name</th><th>Amount</th><th>Share</th></tr>
<tr><td class="txt">00123</td><td>M&#252;ller &amp; S&ouml;hne</td><td class="amt">1234.5</td><td>50%</td></tr>
<tr><td style="mso-number-format:'\\@'">0045</td><td><a href="https://example.com/r">Ren&eacute;e</a></td><td>$12</td><td>12.5%</td></tr>
</table></body></html>`;

it('keeps the text, number formats and links of an Excel-style page', async () => {
  const wb = await open(statement);
  expect(at(wb, 1, 0)).toEqual({ value: '00123', shown: '00123' });
  expect(at(wb, 2, 0)).toEqual({ value: '0045', shown: '0045' });
  expect(at(wb, 1, 1).value).toBe('Müller & Söhne');
  expect(at(wb, 1, 2)).toEqual({ value: 1234.5, shown: '1,234.50' });
  expect(at(wb, 1, 3)).toEqual({ value: 0.5, shown: '50%' });
  expect(at(wb, 2, 2)).toEqual({ value: 12, shown: '$12' });
  expect(wb.getCell(wb.activeSheetId, 2, 1)).toMatchObject({ v: 'Renée', hyperlink: 'https://example.com/r' });
  expect(wb.styleAt(wb.activeSheetId, 0, 0)?.bold).toBe(true);
  expect(wb.fitColumnsOnOpen).toEqual([wb.activeSheetId]);
});

it('keeps merged cells, fills and the spaces of inline markup', async () => {
  const wb = await open(`<!doctype html><html><head><style>.hi { background: #ffff00; font-weight: bold }</style></head><body><table>
    <tr><td colspan="2" class="hi">Quarter</td><td><b>Total</b> due</td></tr>
    <tr><td>1</td><td>2</td><td>line one<br>line two</td></tr></table></body></html>`, 'report.html');
  const sheet = wb.sheets[0];
  expect(sheet.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 1 }]);
  expect(wb.styleAt(sheet.id, 0, 0)).toMatchObject({ bold: true, bg: '#ffff00' });
  expect(at(wb, 0, 2).value).toBe('Total due');
  expect(at(wb, 1, 2).value).toBe('line one\nline two');
  expect(at(wb, 1, 1).value).toBe(2);
});

it('leaves text shaped like a formula as text, as the page shows it', async () => {
  const wb = await open('<table><tr><td>=1+1</td><td>=WEBSERVICE("https://example.com")</td></tr></table>', 'page.html');
  expect(wb.getCell(wb.activeSheetId, 0, 0)).toMatchObject({ v: '=1+1', f: null });
  expect(wb.getCell(wb.activeSheetId, 0, 1)).toMatchObject({ v: '=WEBSERVICE("https://example.com")', f: null });
});

it('still reads a page of several tables as one sheet each', async () => {
  const wb = await open('<html><body><table><tr><td>a</td></tr></table><p>and</p><table><tr><td>b</td></tr></table></body></html>', 'two.html');
  expect(wb.sheets.map((s) => wb.getValue(s.id, 0, 0))).toEqual(['a', 'b']);
});

it('still reads an XML spreadsheet with the library', async () => {
  const wb = await open('<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Data"><Table><Row><Cell><Data ss:Type="Number">7</Data></Cell></Row></Table></Worksheet></Workbook>', 'data.xml');
  expect(wb.sheets[0].name).toBe('Data');
  expect(at(wb, 0, 0).value).toBe(7);
});

it('reads a page that lays tables out in a table as its tables, and one that wraps a table as that table', async () => {
  const layout = await open('<html><body><table><tr><td><table><tr><td>a</td></tr></table></td><td><table><tr><td>b</td></tr></table></td></tr></table></body></html>', 'layout.html');
  expect(layout.sheets.length).toBeGreaterThan(1);
  const wrapped = await open('<html><body><table><tr><td><table><tr><td class="t">00123</td><td>5%</td></tr></table></td></tr></table><style>.t{mso-number-format:"\\@"}</style></body></html>', 'wrapped.html');
  expect(wrapped.sheets).toHaveLength(1);
  expect(at(wrapped, 0, 0).value).toBe('00123');
  expect(at(wrapped, 0, 1)).toEqual({ value: 0.05, shown: '5%' });
});
