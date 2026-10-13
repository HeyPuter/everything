import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

const book = () => {
  const cells = {};
  for (let r = 0; r < 30; r++) { cells[`${r},0`] = { v: r === 0 ? 'Name' : `n${r}` }; cells[`${r},1`] = { v: r === 0 ? 'Size' : r }; }
  return new Workbook({ sheets: [{ name: 'Data', cells }, { name: 'Notes', cells: { '0,0': { v: 'x' } } }] });
};
const zipOf = async wb => X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
const text = (zip, path) => new TextDecoder().decode(X.CFB.find(zip, path).content);
const save = (zip, path, value) => { const f = X.CFB.find(zip, path); f.content = new TextEncoder().encode(value); f.size = f.content.length; };
const reopen = zip => workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'views.xlsx');

describe('xlsx custom views', () => {
  it('writes customWorkbookViews and a customSheetView per sheet in schema order', async () => {
    const wb = book(), data = wb.sheets[0];
    wb.setSheetView(data.id, { viewZoom: 1.25 });
    wb.setFrozen(data.id, 1, 0);
    wb.setPrintSettings(data.id, { orientation: 'landscape', rowBreaks: [10] });
    wb.addCustomView('Wide', { print: true, hidden: true });
    wb.addCustomView('Quick', { print: false, hidden: false });
    const zip = await zipOf(wb);
    const workbook = text(zip, '/xl/workbook.xml'), sheet = text(zip, '/xl/worksheets/sheet1.xml');
    expect(workbook).toMatch(/<customWorkbookViews><customWorkbookView name="Wide" guid="\{[0-9A-F-]{36}\}" maximized="1" windowWidth="1600" windowHeight="900" activeSheetId="1"\/><customWorkbookView name="Quick"[^>]*includePrintSettings="0" includeHiddenRowCol="0"/);
    expect(workbook.indexOf('<customWorkbookViews')).toBeGreaterThan(workbook.indexOf('</sheets>'));
    const views = sheet.match(/<customSheetViews>[\s\S]*?<\/customSheetViews>/)[0];
    expect(views).toMatch(/<customSheetView guid="[^"]+" scale="125"[^>]*><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
    expect(views).toMatch(/<rowBreaks count="1" manualBreakCount="1"><brk id="10"[^>]*\/><\/rowBreaks><pageMargins[^>]*\/><printOptions[^>]*\/><pageSetup[^>]*orientation="landscape"/);
    expect(sheet.indexOf('<customSheetViews')).toBeGreaterThan(sheet.indexOf('</sheetData>'));
    expect(sheet.indexOf('<customSheetViews')).toBeLessThan(sheet.indexOf('<pageMargins'));
    expect(text(zip, '/xl/worksheets/sheet2.xml')).toContain('<customSheetViews>');
  });

  it('round-trips every view, hidden lines and filters included', async () => {
    const wb = book(), data = wb.sheets[0];
    wb.setHidden(data.id, 'row', [4, 5], true);
    wb.setFilterRange(data.id, { r1: 0, c1: 0, r2: 29, c2: 1 });
    wb._setFilter(data, { range: data.filter.range, criteria: { 1: { op: 'gt', value: '20' } } }, 'Filter');
    wb.setSheetView(data.id, { viewZoom: 0.8 });
    wb.addCustomView('Filtered');
    const back = await reopen(await zipOf(wb));
    expect(back.customViews).toHaveLength(1);
    const view = back.customViews[0], state = view.sheets[back.sheets[0].id];
    expect(view.name).toBe('Filtered');
    expect(view.id).toBe(wb.customViews[0].id);
    expect(state).toMatchObject({ zoom: 0.8, hiddenRows: [4, 5] });
    expect(state.filter.criteria[1]).toMatchObject({ op: 'gt' });
    // The view's AutoFilter is not mistaken for the sheet's own.
    back.clearFilter(back.sheets[0].id);
    const again = await reopen(await zipOf(back));
    expect(again.sheets[0].filter).toBeNull();
    expect(again.customViews[0].sheets[again.sheets[0].id].filter).toBeTruthy();
  });

  it('reads views another program wrote', async () => {
    const guid = '{11111111-2222-4333-8444-555555555555}';
    const bytes = otherProgramsXlsx({ sheetNames: ['Data', 'Other'], sheetXml: {
      Data: { rows: '<row r="1"><c r="A1"><v>1</v></c></row>', tail: `<customSheetViews><customSheetView guid="${guid}" scale="150" showGridLines="0" view="pageBreakPreview" topLeftCell="C5"><selection activeCell="D7" sqref="D7:E9"/><pageMargins left="1" right="1" top="1" bottom="1" header="0.5" footer="0.5"/><pageSetup orientation="landscape"/></customSheetView></customSheetViews>` },
      Other: { rows: '', tail: `<customSheetViews><customSheetView guid="${guid}" state="hidden"/></customSheetViews>` },
    }, patch: { '/xl/workbook.xml': xml => xml.replace('</workbook>', `<customWorkbookViews><customWorkbookView name="Print view" guid="${guid}" windowWidth="800" windowHeight="600" activeSheetId="1" includeHiddenRowCol="0"/></customWorkbookViews></workbook>`) } });
    const wb = await workbookFromFile(bytes, 'other.xlsx');
    expect(wb.customViews).toHaveLength(1);
    const view = wb.customViews[0];
    expect(view).toMatchObject({ name: 'Print view', id: guid, print: true, hidden: false, activeSheetId: wb.sheets[0].id });
    expect(view.sheets[wb.sheets[0].id]).toMatchObject({ zoom: 1.5, gridlines: false, mode: 'pageBreak', origin: { r: 4, c: 2 }, printSettings: { orientation: 'landscape' } });
    expect(view.sheets[wb.sheets[0].id].selection.active).toEqual({ r: 6, c: 3 });
    expect(view.sheets[wb.sheets[1].id].sheetHidden).toBe(true);
    // The view's page setup is not the sheet's own.
    expect(wb.sheets[0].printSettings?.orientation ?? 'portrait').toBe('portrait');
    // Showing it hides the other sheet and brings the first to the front.
    wb.setActiveSheet(wb.sheets[1].id);
    wb.showCustomView(guid);
    expect(wb.activeSheetId).toBe(wb.sheets[0].id);
    expect(wb.sheets[1].hidden).toBe(true);
    expect(wb.sheets[0].viewMode).toBe('pageBreak');
  });

  it('drops a view another program deleted, even though the app record still has it', async () => {
    const wb = book();
    wb.addCustomView('Gone');
    const zip = await zipOf(wb);
    save(zip, '/xl/workbook.xml', text(zip, '/xl/workbook.xml').replace(/<customWorkbookViews>[\s\S]*?<\/customWorkbookViews>/, ''));
    const back = await reopen(zip);
    expect(back.customViews).toEqual([]);
  });
});
