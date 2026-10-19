import { expect, it } from 'vitest';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// An Excel 2003 XML spreadsheet (the "XML Spreadsheet" many reporting tools and older exports write) opened
// with its number formats but none of its formatting: bold headers, red text, fills, borders, alignment and
// wrapping all came in plain. A cell's style, through its ss:Parent styles, now gives it its font, fill,
// borders and alignment; what the workbook's Default style says too is left to the sheet's defaults.
const file = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/><Borders/><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#000000"/><Interior/><NumberFormat/><Protection/></Style>
  <Style ss:ID="Heading" ss:Name="Heading"><Font ss:FontName="Calibri" ss:Size="14" ss:Color="#1F4E78" ss:Bold="1"/></Style>
  <Style ss:ID="s62" ss:Parent="Heading"><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#1F4E78"/><Border ss:Position="Top" ss:LineStyle="Double" ss:Weight="3"/></Borders>
   <Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/></Style>
  <Style ss:ID="s63"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#FF0000" ss:Italic="1" ss:Underline="Single" ss:StrikeThrough="1"/><NumberFormat ss:Format="0.00"/><Alignment ss:Horizontal="Right" ss:Vertical="Bottom" ss:Rotate="45"/></Style>
  <Style ss:ID="s64"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#000000"/></Style>
 </Styles>
 <Worksheet ss:Name="Report"><Table>
  <Row><Cell ss:StyleID="s62"><Data ss:Type="String">Quarterly report</Data></Cell><Cell ss:StyleID="s64"><Data ss:Type="String">plain</Data></Cell></Row>
  <Row><Cell ss:StyleID="s63"><Data ss:Type="Number">-3.5</Data></Cell><Cell><Data ss:Type="String">none</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`;

it('opens an Excel 2003 XML spreadsheet with its cells\' formatting', async () => {
  const wb = await workbookFromFile(new TextEncoder().encode(file), 'report.xml');
  const id = wb.activeSheetId;
  const heading = wb.getCell(id, 0, 0).s;
  expect(heading).toMatchObject({ bold: true, color: '#1f4e78', size: 14 * 4 / 3, bg: '#ddebf7', align: 'center', valign: 'middle', wrap: true, bb: true, bt: true });
  expect(heading.bbBorder ?? heading).toMatchObject({ bs: 'medium', bc: '#1f4e78' });
  expect(heading.btBorder ?? heading).toMatchObject({ bs: 'double' });
  expect(wb.getCell(id, 1, 0).s).toMatchObject({ fmt: 'number', dec: 2, italic: true, underline: true, strike: true, color: '#ff0000', align: 'right', rot: 45 });
  expect(wb.getDisplay(id, 1, 0)).toBe('-3.50');
  // The Default style's font, ink and bottom alignment are the sheet's own: nothing to add to a cell.
  for (const [r, c] of [[0, 1], [1, 1]]) {
    const s = wb.getCell(id, r, c).s || {};
    for (const key of ['font', 'size', 'color', 'valign', 'bold']) expect(s[key]).toBeUndefined();
  }
  // And it saves as an .xlsx that keeps them.
  const back = await workbookFromFile(await workbookToXlsx(wb), 'report.xlsx');
  expect(back.getCell(back.activeSheetId, 0, 0).s).toMatchObject({ bold: true, bg: '#ddebf7', align: 'center', wrap: true });
});
