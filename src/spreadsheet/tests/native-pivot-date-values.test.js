import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { planNativePivotReport } from '../src/core/native-pivot-report.js';
import { insertTimeline, setTimelineSelection, pivotDateSerial } from '../src/core/timeline.js';

// A PivotTable from Excel summarizing a date field (Max of When, Min, Average, Count Numbers) recomputed to 0 (or
// #DIV/0!) as soon as a slicer or timeline rebuilt it: the cache keeps dates as ISO text, which went into MAX and
// COUNT unconverted. They are aggregated as the serials they stand for.
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function book(dataField, shown) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Report' }] });
  const [data, report] = wb.sheets;
  [['Region', 'Amount', 'When'], ['East', 4, 45292], ['West', 9, 45383], ['East', 2, 45658]].forEach((row, r) => row.forEach((v, c) => wb.setInput(data.id, r, c, String(v))));
  const cache = `<pivotCacheDefinition xmlns="${M}" recordCount="3"><cacheSource type="worksheet"><worksheetSource sheet="Data" ref="A1:C4"/></cacheSource><cacheFields count="3">`
    + '<cacheField name="Region"><sharedItems count="2"><s v="East"/><s v="West"/></sharedItems></cacheField>'
    + '<cacheField name="Amount"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" containsInteger="1" minValue="2" maxValue="9"/></cacheField>'
    + '<cacheField name="When" numFmtId="14"><sharedItems containsSemiMixedTypes="0" containsNonDate="0" containsDate="1" containsString="0" minDate="2024-01-01T00:00:00" maxDate="2025-01-01T00:00:00"/></cacheField></cacheFields></pivotCacheDefinition>';
  const records = `<pivotCacheRecords xmlns="${M}" count="3"><r><x v="0"/><n v="4"/><d v="2024-01-01T00:00:00"/></r><r><x v="1"/><n v="9"/><d v="2024-04-01T00:00:00"/></r><r><x v="0"/><n v="2"/><d v="2025-01-01T00:00:00"/></r></pivotCacheRecords>`;
  const definition = `<pivotTableDefinition xmlns="${M}" name="PivotTable1" cacheId="5" dataCaption="Values"><location ref="A3:B6" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>`
    + '<pivotFields count="3"><pivotField axis="axisRow" showAll="0"><items count="3"><item x="0"/><item x="1"/><item t="default"/></items></pivotField><pivotField showAll="0"/><pivotField dataField="1" showAll="0"/></pivotFields>'
    + '<rowFields count="1"><field x="0"/></rowFields><rowItems count="3"><i><x/></i><i><x v="1"/></i><i t="grand"><x/></i></rowItems><colItems count="1"><i/></colItems>'
    + `<dataFields count="1">${dataField}</dataFields></pivotTableDefinition>`;
  wb.nativePivots = { version: 1, caches: [{ key: 'c1', scope: 'main', sourceSheetId: data.id, sourceRef: 'A1:C4', xml: cache, records }],
    tables: [{ name: 'PivotTable1', cache: 'c1', owner: report.id, ref: 'A3:B6', xml: definition }], formats: {}, dxfs: [], styles: [] };
  shown.forEach((row, r) => row.forEach((v, c) => wb.setInput(report.id, 2 + r, c, String(v))));
  return { wb, report, pivot: wb.nativePivots.tables[0] };
}

it('summarizes a date field by its dates', () => {
  for (const [sub, label, values] of [['max', 'Max of When', [45658, 45383, 45658]], ['min', 'Min of When', [45292, 45383, 45292]],
    ['countNums', 'Count of When', [2, 1, 3]], ['average', 'Average of When', [45475, 45383, (45292 + 45383 + 45658) / 3]]]) {
    const { wb, pivot } = book(`<dataField name="${label}" fld="2" subtotal="${sub}" baseField="0" baseItem="0"/>`, [['Row Labels', label]]);
    const plan = planNativePivotReport(pivot, wb.nativePivots.caches[0]);
    expect(plan.cells.filter((c) => c.role === 'value').map((c) => c.value)).toEqual(values);
  }
});

it('keeps a Max of dates when a timeline rebuilds the report', () => {
  const { wb, report, pivot } = book('<dataField name="Max of When" fld="2" subtotal="max" baseField="0" baseItem="0"/>',
    [['Row Labels', 'Max of When'], ['East', 45658], ['West', 45383], ['Grand Total', 45658]]);
  const id = insertTimeline(wb, report.id, pivot, 2);
  setTimelineSelection(wb, report.id, id, pivotDateSerial('2024-01-01'), pivotDateSerial('2025-12-31'));
  expect([3, 4, 5].map((r) => wb.getValue(report.id, r, 1))).toEqual([45658, 45383, 45658]);
});
