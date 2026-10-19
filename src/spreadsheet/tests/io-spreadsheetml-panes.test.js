import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// An Excel 2003 XML spreadsheet's frozen header row and first column (WorksheetOptions FreezePanes, with the
// split's rows and columns) and its hidden gridlines were ignored: the sheet opened scrolling its headers away.
const file = (options) => new TextEncoder().encode(`<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Report"><Table><Row><Cell><Data ss:Type="String">Head</Data></Cell></Row></Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">${options}</WorksheetOptions></Worksheet>
</Workbook>`);

it('keeps frozen rows and columns and hidden gridlines', async () => {
  const wb = await workbookFromFile(file('<Selected/><DoNotDisplayGridlines/><FreezePanes/><FrozenNoSplit/><SplitHorizontal>2</SplitHorizontal><TopRowBottomPane>2</TopRowBottomPane><SplitVertical>1</SplitVertical><LeftColumnRightPane>1</LeftColumnRightPane><ActivePane>0</ActivePane>'), 'report.xml');
  expect(wb.activeSheet).toMatchObject({ frozenRows: 2, frozenCols: 1, gridlines: false });
});

it('leaves a sheet without frozen panes as it was', async () => {
  // A split that is not frozen is a split view, which is not a frozen pane.
  const wb = await workbookFromFile(file('<Selected/><SplitHorizontal>3</SplitHorizontal><TopRowBottomPane>3</TopRowBottomPane>'), 'report.xml');
  expect(wb.activeSheet).toMatchObject({ frozenRows: 0, frozenCols: 0, gridlines: true });
});
