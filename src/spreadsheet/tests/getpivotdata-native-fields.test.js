import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// GETPIVOTDATA read an Excel report off its cells alone and never looked at the field names: in a report of trips
// with From on rows and To on columns, From=Paris, To=London gave 14 (the London column's total) instead of 3, and
// From=Rome gave the Rome column's total. A report from a file now answers from its saved layout, which says which
// field each item belongs to, as Excel does.
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const CITIES = ['London', 'Paris', 'Rome'];

function book() {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Report' }] });
  const [data, report] = wb.sheets;
  const trips = [['Paris', 'London', 3], ['Paris', 'Rome', 5], ['London', 'Paris', 7], ['Rome', 'London', 11], ['London', 'Rome', 13]];
  [['From', 'To', 'Trips'], ...trips].forEach((row, r) => row.forEach((v, c) => wb.setInput(data.id, r, c, String(v))));
  const shared = `<sharedItems count="3">${CITIES.map((c) => `<s v="${c}"/>`).join('')}</sharedItems>`;
  const cache = `<pivotCacheDefinition xmlns="${M}" recordCount="5"><cacheSource type="worksheet"><worksheetSource sheet="Data" ref="A1:C6"/></cacheSource><cacheFields count="3">`
    + `<cacheField name="From">${shared}</cacheField><cacheField name="To">${shared}</cacheField>`
    + '<cacheField name="Trips"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" containsInteger="1" minValue="3" maxValue="13"/></cacheField></cacheFields></pivotCacheDefinition>';
  const items = '<items count="4"><item x="0"/><item x="1"/><item x="2"/><item t="default"/></items>';
  const axisItems = '<i><x/></i><i><x v="1"/></i><i><x v="2"/></i><i t="grand"><x/></i>';
  const definition = `<pivotTableDefinition xmlns="${M}" name="PivotTable1" cacheId="5" dataCaption="Values"><location ref="A1:E6" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>`
    + `<pivotFields count="3"><pivotField axis="axisRow" showAll="0">${items}</pivotField><pivotField axis="axisCol" showAll="0">${items}</pivotField><pivotField dataField="1" showAll="0"/></pivotFields>`
    + `<rowFields count="1"><field x="0"/></rowFields><rowItems count="4">${axisItems}</rowItems>`
    + `<colFields count="1"><field x="1"/></colFields><colItems count="4">${axisItems}</colItems>`
    + '<dataFields count="1"><dataField name="Sum of Trips" fld="2" baseField="0" baseItem="0"/></dataFields></pivotTableDefinition>';
  wb.nativePivots = { version: 1, caches: [{ key: 'c1', scope: 'main', sourceSheetId: data.id, sourceRef: 'A1:C6', xml: cache }],
    tables: [{ name: 'PivotTable1', cache: 'c1', owner: report.id, ref: 'A1:E6', xml: definition }], formats: {}, dxfs: [], styles: [] };
  const shown = [['Sum of Trips', 'Column Labels', null, null, null], ['Row Labels', ...CITIES, 'Grand Total'],
    ['London', null, 7, 13, 20], ['Paris', 3, null, 5, 8], ['Rome', 11, null, null, 11], ['Grand Total', 14, 7, 18, 39]];
  shown.forEach((row, r) => row.forEach((v, c) => v != null && wb.setInput(report.id, r, c, String(v))));
  const gpd = (args) => { wb.setInput(report.id, 10, 0, `=GETPIVOTDATA(${args})`); const v = wb.getValue(report.id, 10, 0); return v?.error ?? v; };
  return { gpd };
}

it('finds row and column items by their fields when the two share names', () => {
  const { gpd } = book();
  expect(gpd('"Trips",A1,"From","Paris","To","London"')).toBe(3);
  expect(gpd('"Trips",A1,"To","London","From","Paris"')).toBe(3);
  expect(gpd('"Trips",A1,"From","Rome"')).toBe(11);
  expect(gpd('"Sum of Trips",$A$1,"To","Rome"')).toBe(18);
  expect(gpd('"Trips",C4')).toBe(39);
});

it('reads #REF! for an item, field or data field the report does not have', () => {
  const { gpd } = book();
  expect(gpd('"Trips",A1,"From","Oslo"')).toBe('#REF!');
  expect(gpd('"Trips",A1,"Region","Paris"')).toBe('#REF!');
  expect(gpd('"Fares",A1')).toBe('#REF!');
});
