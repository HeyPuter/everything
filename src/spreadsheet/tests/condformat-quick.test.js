import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { clearRules, presetRule, quickRule, subtractRange } from '../src/ui/condformat-quick.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

it('subtracts one rectangle from another into at most four pieces', () => {
  expect(subtractRange(parseRange('A1:C3'), parseRange('E5:F6'))).toEqual([parseRange('A1:C3')]);
  expect(subtractRange(parseRange('A1:A10'), parseRange('A1:A10'))).toEqual([]);
  expect(subtractRange(parseRange('A1:C3'), parseRange('B2'))).toEqual([parseRange('A1:C1'), parseRange('A3:C3'), parseRange('A2'), parseRange('C2')]);
});

it('writes above-average rules as a relative formula over the range', () => {
  const rule = quickRule(parseRange('B2:B9'), 'above', { style: { bold: true } });
  expect(rule).toEqual({ range: parseRange('B2:B9'), type: 'formula', value: 'AND(ISNUMBER(B2),B2>AVERAGE($B$2:$B$9))', style: { bold: true } });
  expect(quickRule(parseRange('B2:B9'), 'between', { value: '1', value2: '5' })).toMatchObject({ type: 'between', value: 1, value2: 5 });
  expect(quickRule(parseRange('B2:B9'), 'dup', { choice: 'unique' }).type).toBe('unique');
});

it('applies quick rules that format the right cells and survive an XLSX round trip', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [3, 6, 2, 9].forEach((n, r) => wb.setInput(id, r, 0, String(n)));
  wb.addRule(id, quickRule(parseRange('A1:A4'), 'gt', { value: '4', style: { bg: '#ffd6d6', color: '#9c1c1c' } }));
  wb.addRule(id, quickRule(parseRange('A1:A4'), 'below', { style: { bold: true } }));
  wb.addRule(id, presetRule(parseRange('A1:A4'), { kind: 'databar', barColor: '#9fdcb4' }));
  const style = r => wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0)) || {};
  expect(style(1)).toMatchObject({ bg: '#ffd6d6', color: '#9c1c1c' }); // 6 > 4
  expect(style(0).bg).toBeUndefined(); // 3
  expect(style(2).bold).toBe(true); // 2 is below the average of 5
  const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'cf.xlsx');
  const rules = back.sheet(back.activeSheetId).rules;
  expect(rules.map(r => r.type)).toEqual(['gt', 'formula', 'databar']);
  expect(rules[0]).toMatchObject({ value: 4, style: { bg: '#ffd6d6', color: '#9c1c1c' } });
  expect(rules[1].value.replace(/^=/, '')).toBe('AND(ISNUMBER(A1),A1<AVERAGE($A$1:$A$4))');
});

it('clears rules from the selection by trimming them, or from the whole sheet, in one undo step', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.addRule(id, quickRule(parseRange('A1:A10'), 'gt', { value: '1', style: { bold: true } }));
  wb.addRule(id, presetRule(parseRange('C1:C4'), { kind: 'scale', from: '#ffffff', to: '#63be7b' }));
  expect(clearRules(wb, id, [parseRange('A4:A6')])).toBe(1);
  const areas = wb.sheet(id).rules.filter(r => r.type === 'gt').map(r => r.range);
  expect(areas).toEqual([parseRange('A1:A3'), parseRange('A7:A10')]);
  expect(clearRules(wb, id, [parseRange('E1')])).toBe(0);
  expect(clearRules(wb, id, null)).toBe(2);
  expect(wb.sheet(id).rules).toEqual([]);
  wb.undo();
  expect(wb.sheet(id).rules.map(r => r.type)).toEqual(['gt', 'gt', 'scale']);
});
