import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { tableCells, rowGrid } from '../src/engine/tables.js';
import { parseFormula, evaluateFormula, formatFormulaNumber, insertFormula, formulaInstruction, buildInstruction, cellNumber, suggestedFormula, columnName, cellReference } from '../src/engine/table-formula.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const open = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
// Item | Q1 | Q2 / Pens | 10 | $1,200.50 / Ink | 5 | (30) / Total | _ | _
function sheet() {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = open(pkg);
  doc.insertTable(4, 3, 9000);
  const values = ['Item', 'Q1', 'Q2', 'Pens', '10', '$1,200.50', 'Ink', '5', '(30)', 'Total', '', ''];
  tableCells(doc.tables[0]).forEach((cell, i) => { doc.selectCell(cell.id); if (values[i]) doc.replace(values[i]); });
  return { pkg, doc };
}
const cellAt = (doc, r, c) => rowGrid(doc.tables[0].rows[r]).find(x => x.column <= c && x.end > c).cell;
const textAt = (doc, r, c) => doc.paragraphs.filter(p => p.cellId === cellAt(doc, r, c).id).map(paragraphText).join('/');

it('parses arithmetic, functions, references and directions', () => {
  expect(parseFormula('SUM(ABOVE)')).toEqual({ type: 'call', name: 'SUM', args: [{ type: 'direction', value: 'ABOVE' }] });
  expect(parseFormula('2+3*4^2').type).toBe('binary');
  expect(parseFormula('A1:B2')).toEqual({ type: 'range', from: { row: 0, column: 0 }, to: { row: 1, column: 1 } });
  expect(() => parseFormula('SUM(')).toThrow();
  expect(() => parseFormula('NOPE(1)')).toThrow('not a formula function');
  expect(columnName(27)).toBe('AB'); expect(cellReference('AB3')).toEqual({ row: 2, column: 27 });
  expect([cellNumber('$1,200.50'), cellNumber('(30)'), cellNumber('-4 apples'), cellNumber('none')]).toEqual([1200.5, -30, -4, null]);
});

it('formats numbers with pictures, sections and grouping', () => {
  expect(formatFormulaNumber(1234.567, '#,##0.00')).toBe('1,234.57');
  expect(formatFormulaNumber(-1234.5, '$#,##0.00;($#,##0.00)')).toBe('($1,234.50)');
  expect(formatFormulaNumber(-2, '0.0')).toBe('-2.0');
  expect(formatFormulaNumber(0.5, '0%')).toBe('1%');
  expect(formatFormulaNumber(7, '00')).toBe('07');
  expect(formatFormulaNumber(2 / 3)).toBe('0.67');
  expect(formatFormulaNumber(12.5, '0.##')).toBe('12.5');
  expect(formulaInstruction(' =SUM(ABOVE) \\# "#,##0.00" ')).toEqual({ formula: 'SUM(ABOVE)', picture: '#,##0.00' });
  expect(buildInstruction('=AVERAGE(LEFT)', '0.0')).toBe(' =AVERAGE(LEFT) \\# "0.0" ');
});

it('evaluates directions, ranges and functions against the table', () => {
  const { doc } = sheet();
  const total = cellAt(doc, 3, 1).id, other = cellAt(doc, 3, 2).id;
  expect(evaluateFormula(doc, '=SUM(ABOVE)', total)).toBe('15');
  expect(evaluateFormula(doc, '=SUM(ABOVE)', other)).toBe('1170.5');
  expect(evaluateFormula(doc, '=AVERAGE(B2:B3) \\# "0.0"', other)).toBe('7.5');
  expect(evaluateFormula(doc, '=MAX(B2:C3)', other)).toBe('1200.5');
  expect(evaluateFormula(doc, '=MIN(B2,C3,4)', other)).toBe('-30');
  expect(evaluateFormula(doc, '=PRODUCT(ABOVE)', total)).toBe('50');
  expect(evaluateFormula(doc, '=COUNT(ABOVE)', total)).toBe('2');
  expect(evaluateFormula(doc, '=SUM(LEFT)', cellAt(doc, 1, 2).id)).toBe('10');
  expect(evaluateFormula(doc, '=IF(B2>B3, 1, 0)+ROUND(2.345,2)', other)).toBe('3.35');
  expect(() => evaluateFormula(doc, '=1/0', other)).toThrow('Zero Divide');
  expect(evaluateFormula(doc, '=R2C2+R3C2', other)).toBe('15');
  expect(evaluateFormula(doc, '=SUM(R2C2:R3C2)', other)).toBe('15');
});

it('reads numbers from bookmarks', () => {
  const { doc } = sheet();
  doc.select(doc.text.length); doc.insertParagraph(); doc.replace('Rate 12.5');
  const at = doc.text.lastIndexOf('12.5');
  doc.select(at, at + 4); doc.addBookmark('Rate');
  expect(evaluateFormula(doc, '=Rate*2', null)).toBe('25');
  expect(() => evaluateFormula(doc, '=Missing+1', null)).toThrow('Undefined Bookmark');
});

it('inserts an = field with its result, updates it with Update Fields and round-trips', async () => {
  const { pkg, doc } = sheet();
  doc.selectCell(cellAt(doc, 3, 1).id);
  expect(suggestedFormula(doc)).toBe('=SUM(ABOVE)');
  insertFormula(doc, '=SUM(ABOVE)', '0.00');
  expect(textAt(doc, 3, 1)).toBe('15.00');
  expect(bodyFieldRanges(doc.paragraphs).map(r => r.field.type)).toEqual(['=']);
  // Change an input; Update Fields recomputes the cached result.
  const p = doc.paragraphs.find(x => x.cellId === cellAt(doc, 1, 1).id), start = doc.paragraphOffset(doc.paragraphs.indexOf(p));
  doc.select(start, start + 2); doc.replace('20');
  expect(updateSequenceFields(doc)).toBe(1);
  expect(textAt(doc, 3, 1)).toBe('25.00');
  const bytes = new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables).arrayBuffer());
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
  expect(xml).toContain('=SUM(ABOVE) \\# &quot;0.00&quot;');
  const reopened = open(await DocxPackage.open(bytes));
  expect(textAt(reopened, 3, 1)).toBe('25.00');
  expect(bodyFieldRanges(reopened.paragraphs)[0].field.type).toBe('=');
});

it('reads cells as they read with tracked changes accepted: deleted text does not count', () => {
  const { doc } = sheet();
  // A reviewer retypes Q1's 10 as 7 with Track Changes on: "10" stays as a deletion beside "7".
  const p = doc.paragraphs.find(x => x.cellId === cellAt(doc, 1, 1).id), start = doc.paragraphOffset(doc.paragraphs.indexOf(p));
  doc.trackChanges = true; doc.revisionAuthor = 'Reviewer';
  doc.select(start, start + 2); doc.replace('7');
  doc.trackChanges = false;
  expect(p.runs.some(r => r.revision?.type === 'del')).toBe(true);
  expect(evaluateFormula(doc, '=SUM(ABOVE)', cellAt(doc, 3, 1).id)).toBe('12');
  expect(evaluateFormula(doc, '=B2*2', cellAt(doc, 3, 1).id)).toBe('14');
});

it('ROUND rounds halves away from zero, at the decimal places typed', () => {
  const { doc } = sheet();
  const at = cellAt(doc, 3, 1).id;
  expect(['=ROUND(-2.5,0)', '=ROUND(2.5,0)', '=ROUND(1.005,2)', '=ROUND(-1.005,2)', '=ROUND(1234.5,-2)', '=ROUND(0.125,2)'].map(f => evaluateFormula(doc, f, at))).toEqual(['-3', '3', '1.01', '-1.01', '1200', '0.13']);
});

it('reads only parentheses around a cell’s leading number as negative', () => {
  expect([cellNumber('100 (20)'), cellNumber('12 boxes (spare)'), cellNumber('(30)'), cellNumber('( $1,200.50 )'), cellNumber('(30) returned'), cellNumber('(30')]).toEqual([100, 12, -30, -1200.5, -30, 30]);
});
