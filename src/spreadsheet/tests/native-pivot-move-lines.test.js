import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Insert and Delete rows renumber a native PivotTable's location and refuse to cut through it, but Move
// rows/columns did neither: the report's cells moved while its location stayed, and a move could tear
// lines out of the report.
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const cache = { key: 'c', sourceSheetId: 'report', sourceRef: 'A1:B3', xml: `<pivotCacheDefinition xmlns="${MAIN}"><cacheSource type="worksheet"><worksheetSource ref="A1:B3" sheet="Report"/></cacheSource><cacheFields count="2"><cacheField name="k"><sharedItems count="2"><s v="x"/><s v="y"/></sharedItems></cacheField><cacheField name="v"/></cacheFields></pivotCacheDefinition>` };
const pivot = { name: 'PT', owner: 'report', cache: 'c', ref: 'D8:F12', xml: `<pivotTableDefinition xmlns="${MAIN}"><location ref="A1:C5" firstDataRow="1" firstDataCol="1"/></pivotTableDefinition>` };
const book = () => new Workbook({ sheets: [{ id: 'report', name: 'Report', cells: { '7,3': { v: 'Row Labels' }, '11,3': { v: 'Grand Total' } } }],
  nativePivots: { version: 1, caches: [cache], tables: [pivot] } });
const ref = (wb) => wb.nativePivots.tables[0]?.ref;

describe('Move rows and columns around a native PivotTable', () => {
  it('renumbers the report and its cache source when lines move past them, and undo restores them', () => {
    const wb = book();
    const before = wb.toJSON();
    expect(wb.moveRows('report', 0, 2, 20)).toBe(18);
    expect(ref(wb)).toBe('D6:F10');
    expect(wb.getValue('report', 5, 3)).toBe('Row Labels');
    expect(wb.nativePivots.caches[0].sourceRef).toBe('A1:B1');
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    expect(wb.moveCols('report', 3, 3, 0)).toBe(0);
    expect(ref(wb)).toBe('A8:C12');
  });

  it('carries the report whole when the moved lines hold all of it', () => {
    const wb = book();
    expect(wb.moveRows('report', 7, 5, 30)).toBe(25);
    expect(ref(wb)).toBe('D26:F30');
  });

  it('refuses a move that takes lines out of the report or lands lines inside it', () => {
    const wb = book();
    const events = [];
    wb.addEventListener('change', e => { if (e.detail.type === 'pivot-edit') events.push(e.detail.reason); });
    const before = wb.toJSON();
    expect(wb.moveRows('report', 9, 1, 0)).toBeNull();
    expect(wb.moveRows('report', 0, 1, 10)).toBeNull();
    expect(wb.moveCols('report', 4, 1, 10)).toBeNull();
    expect(events).toEqual(['partial', 'partial', 'partial']);
    expect(wb.toJSON()).toEqual(before);
    expect(wb.undoLabels()).toEqual([]);
  });
});
