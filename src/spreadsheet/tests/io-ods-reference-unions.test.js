import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const parser = new (new JSDOM('').window.DOMParser)();
const ns = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
function content(bytes) {
  const zip = X.CFB.read(bytes, { type: 'array' });
  return parser.parseFromString(new TextDecoder().decode(X.CFB.find(zip, 'content.xml').content), 'application/xml');
}
const cases = [
  ['SUM((A1,B1))', 'SUM(([.A1]~[.B1]))', 30],
  ['AREAS((A1,B1))', 'AREAS(([.A1]~[.B1]))', 2],
  ['INDEX((A1,B1),1,1,2)', 'INDEX(([.A1]~[.B1]);1;1;2)', 20],
  ['SUM((A1:B1,A2:B2))', 'SUM(([.A1:.B1]~[.A2:.B2]))', 100],
  ['SUM(IF(TRUE,(A1,B1),A2))', 'SUM(IF(TRUE;([.A1]~[.B1]);[.A2]))', 30],
  ['IF("x,y"="x,y",SUM((A1,B1)),0)', 'IF("x,y"="x,y";SUM(([.A1]~[.B1]));0)', 30],
  ['SUM((IF(TRUE,A1,A2),OFFSET(B1,0,0)))', 'SUM((IF(TRUE;[.A1];[.A2])~OFFSET([.B1];0;0)))', 30],
  ['LET(pair,LAMBDA(x,y,SUM((x,y))),pair(A1,B1))', 'COM.MICROSOFT.LET(pair;COM.MICROSOFT.LAMBDA(x;y;SUM((x~y)));pair([.A1];[.B1]))', 30],
  ['SUM((LAMBDA(A1)(),B1))', 'SUM((COM.MICROSOFT.LAMBDA([.A1])()~[.B1]))', 30],
  ['LET(fn,LAMBDA(x,y,x+y),fn(SUM((A1,B1)),SUM({1,2;3,4})))', 'COM.MICROSOFT.LET(fn;COM.MICROSOFT.LAMBDA(x;y;x+y);fn(SUM(([.A1]~[.B1]));SUM({1;2|3;4})))', 40],
  ['IF(FALSE,"(,{",SUM((A1,B1)))', 'IF(FALSE;"(,{";SUM(([.A1]~[.B1])))', 30],
  ['SUM ( ( A1 , B1 ) )', 'SUM ( ( [.A1] ~ [.B1] ) )', 30],
  ['SUM(A1,B1)', 'SUM([.A1];[.B1])', 30],
  ['(LAMBDA(x,y,x+y))(10,20)', '(COM.MICROSOFT.LAMBDA(x;y;x+y))(10;20)', 30],
];

it.each(cases)('exports union and argument separators correctly in %s', async (formula, expected, value) => {
  let wb = new Workbook(), id = wb.activeSheetId;
  [[10, 20], [30, 40]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.setInput(id, 3, 3, `=${formula}`);
  expect(wb.getValue(id, 3, 3)).toBe(value);
  for (let i = 0; i < 2; i++) {
    const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
    const node = [...content(bytes).getElementsByTagNameNS(ns, 'table-cell')].find((n) => n.hasAttributeNS(ns, 'formula'));
    expect(node.getAttributeNS(ns, 'formula')).toBe(`of:=${expected}`);
    wb = await workbookFromFile(bytes, 'unions.ods'); id = wb.sheets[0].id;
    expect(wb.getValue(id, 3, 3)).toBe(value);
  }
});

it('exports union operators inside named formulas and retains live source references', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '10'); wb.setInput(id, 0, 1, '20');
  wb.defineName('Combined', 'SUM((Sheet1!A1,Sheet1!B1))'); wb.setInput(id, 1, 0, '=Combined');
  const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
  expect(content(bytes).getElementsByTagNameNS(ns, 'named-expression')[0].getAttributeNS(ns, 'expression'))
    .toBe('of:=SUM(([$Sheet1.A1]~[$Sheet1.B1]))');
  const copy = await workbookFromFile(bytes, 'named-union.ods'), target = copy.sheets[0].id;
  expect(copy.getValue(target, 1, 0)).toBe(30);
  copy.setInput(target, 0, 1, '40'); expect(copy.getValue(target, 1, 0)).toBe(50);
  copy.undo(); expect(copy.getValue(target, 1, 0)).toBe(30);
});

it('preserves separators inside strings and quoted sheet names', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.renameSheet(id, 'A,B'); wb.setInput(id, 0, 0, '10'); wb.setInput(id, 0, 1, '20');
  wb.setInput(id, 1, 1, '=IF("x~y;z"="x~y;z",SUM((\'A,B\'!A1,\'A,B\'!B1)),0)');
  const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
  const nodes = [...content(bytes).getElementsByTagNameNS(ns, 'table-cell')];
  expect(nodes.find((n) => n.hasAttributeNS(ns, 'formula')).getAttributeNS(ns, 'formula'))
    .toBe('of:=IF("x~y;z"="x~y;z";SUM(([$\'A,B\'.A1]~[$\'A,B\'.B1]));0)');
  const copy = await workbookFromFile(bytes, 'quoted.ods');
  expect(copy.getValue(copy.sheets[0].id, 1, 1)).toBe(30);
});
