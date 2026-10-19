import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// Excel's "Format only cells with: Cell Value greater than 10" rule (cellIs) opens as the formula rule
// A1>(10), which means the same; saving wrote that back as a "Use a formula" rule, so after one trip
// through this app Excel no longer listed it as the Cell Value rule it was made as. A formula rule spelled
// that way is now written as Excel's cellIs again.
const DXF = '<dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>';
async function open(rules) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([[1], [5], [12], ['text'], [20]]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const edit = (path, change) => { const entry = X.CFB.find(zip, path); entry.content = new TextEncoder().encode(change(new TextDecoder().decode(entry.content))); entry.size = entry.content.length; };
  edit('/xl/worksheets/sheet1.xml', (xml) => xml.replace('</sheetData>', () => `</sheetData>${rules}`));
  edit('/xl/styles.xml', (xml) => xml.replace('</cellXfs>', () => `</cellXfs>${DXF}`));
  return workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'rules.xlsx');
}
const cfRules = async (wb) => {
  const xml = new TextDecoder().decode(X.CFB.find(X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' }), '/xl/worksheets/sheet1.xml').content);
  return [...xml.matchAll(/<cfRule\b([^>]*)>([\s\S]*?)<\/cfRule>/g)].map(([, attrs, body]) => ({
    type: /type="(\w+)"/.exec(attrs)[1], operator: /operator="(\w+)"/.exec(attrs)?.[1], formulas: [...body.matchAll(/<formula>([^<]*)<\/formula>/g)].map((m) => m[1]),
  }));
};
const cellIs = (operator, ...formulas) => `<conditionalFormatting sqref="A1:A5"><cfRule type="cellIs" dxfId="0" priority="1" operator="${operator}">${formulas.map((f) => `<formula>${f}</formula>`).join('')}</cfRule></conditionalFormatting>`;

it.each([
  ['greaterThan', ['10'], [false, false, true, true, true]],
  ['equal', ['$A$2'], [false, true, false, false, false]],
  ['lessThanOrEqual', ['5'], [true, true, false, false, false]],
  ['between', ['2', '$A$5'], [false, true, true, false, true]],
  ['notBetween', ['2', '15'], [true, false, false, true, true]],
])('saves an Excel Cell Value %s rule as Excel wrote it', async (operator, formulas, painted) => {
  const wb = await open(cellIs(operator, ...formulas));
  const id = wb.activeSheetId;
  expect(wb.activeSheet.rules[0].type).toBe('formula');
  expect(painted.map((_, r) => !!wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0))?.bg)).toEqual(painted);
  expect(await cfRules(wb)).toEqual([{ type: 'cellIs', operator, formulas }]);
  // Reopened, the rule is the same one, and it paints the same cells.
  const back = await workbookFromFile(await workbookToXlsx(wb), 'again.xlsx');
  expect(back.activeSheet.rules.map((r) => r.value)).toEqual(wb.activeSheet.rules.map((r) => r.value));
  expect(painted.map((_, r) => !!back.conditionalStyle(back.activeSheetId, r, 0, back.getValue(back.activeSheetId, r, 0))?.bg)).toEqual(painted);
});

it('keeps other formula rules as formulas', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', rules: [
    { range: { r1: 0, c1: 0, r2: 4, c2: 0 }, type: 'formula', value: '=A1>(1)*(2)', style: { bg: '#ffeeaa' } },
    { range: { r1: 0, c1: 0, r2: 4, c2: 0 }, type: 'formula', value: '=B1>(10)', style: { bg: '#ffeeaa' } },
    { range: { r1: 0, c1: 0, r2: 4, c2: 0 }, type: 'formula', value: '=AND(A1>=(1),B1<=(2))', style: { bg: '#ffeeaa' } },
  ] }] });
  expect((await cfRules(wb)).map((r) => r.type)).toEqual(['expression', 'expression', 'expression']);
});
