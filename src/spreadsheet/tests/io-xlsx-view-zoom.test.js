import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';
import { editedXlsx } from './helpers/xlsx-excel-edit.js';

it.each(['', '<sheetViews><sheetView workbookViewId="0"/></sheetViews>', '<sheetViews><sheetView workbookViewId="0" zoomScale="bad"/></sheetViews>'])('defaults absent or invalid native zoom to 100%%: %s', async head => {
  const wb = await workbookFromFile(otherProgramsXlsx({ sheetNames: ['Detail', 'Overview'], sheetXml: {
    Detail: { head: '<sheetViews><sheetView workbookViewId="0" zoomScale="175"/></sheetViews>' }, Overview: { head },
  } }), 'views.xlsx');
  expect(wb.sheets.map(s => s.viewZoom)).toEqual([1.75, 1]);
});

it('preserves per-sheet zoom edits, native limits and drafts without recalculating cells', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Small', cells: { '0,0': { f: 'RAND()' } } }, { name: 'Large' }] });
  const first = wb.sheets[0], before = wb.getValue(first.id, 0, 0);
  wb.setSheetView(first.id, { viewZoom: .1, zoomToFit: true });
  wb.setSheetView(wb.sheets[1].id, { viewZoom: 4 });
  expect(wb.dirty).toBe(true); expect(wb.canUndo()).toBe(false);
  expect(first).not.toHaveProperty('zoomToFit');
  expect(wb.getValue(first.id, 0, 0)).toBe(before);
  for (const viewZoom of [0, -.5, 4.01, NaN, Infinity]) wb.setSheetView(first.id, { viewZoom });
  expect(first.viewZoom).toBe(.1);
  const restored = new Workbook(wb.toJSON());
  expect(restored.sheets.map(s => s.viewZoom)).toEqual([.1, 4]);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(restored)).arrayBuffer()), { type: 'array' });
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  part.size = part.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'native.xlsx');
  expect(back.sheets.map(s => s.viewZoom)).toEqual([.1, 4]);
});

it('keeps current zoom when a structural edit is undone or redone', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.insertRows(id, 0, 2);
  wb.setSheetView(id, { viewZoom: 1.65 });
  wb.undo(); expect(wb.sheet(id).viewZoom).toBe(1.65);
  wb.redo(); expect(wb.sheet(id).viewZoom).toBe(1.65);
});

// The app's own settings sheet, which Excel keeps when it saves, used to win over the view's zoomScale for good: a
// sheet zoomed in Excel opened here at the zoom this app last saved. A part whose zoom is no longer what this
// app's save wrote was zoomed in Excel, whose zoom now wins; left alone, the app's exact zoom still comes back.
it('keeps a zoom changed in Excel, and the app\'s own exact zoom otherwise', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Plain' }] });
  wb.setInput(wb.sheets[0].id, 0, 0, '1');
  wb.setSheetView(wb.sheets[0].id, { viewZoom: 1.234 });
  const saved = await workbookToXlsx(wb);
  expect((await workbookFromFile(saved, 'mine.xlsx')).sheets.map(s => s.viewZoom)).toEqual([1.234, undefined]);
  const zoomed = await workbookFromFile(await editedXlsx(saved, {
    '/xl/worksheets/sheet1.xml': (xml) => xml.replace(/ zoomScale="\d+"/, ' zoomScale="150"'),
    '/xl/worksheets/sheet2.xml': (xml) => xml.replace('<sheetView ', '<sheetView zoomScale="80" '),
  }), 'mine.xlsx');
  expect(zoomed.sheets.map(s => s.viewZoom)).toEqual([1.5, .8]);
});

it('keeps a chart sheet set to zoom to fit its window in Excel', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Chart', kind: 'chart' }] });
  wb.setSheetView(wb.sheets[1].id, { zoomToFit: false, viewZoom: .5 });
  const saved = await workbookToXlsx(wb);
  expect((await workbookFromFile(saved, 'mine.xlsx')).sheets[1]).toMatchObject({ zoomToFit: false, viewZoom: .5 });
  const fitted = await workbookFromFile(await editedXlsx(saved, {
    '/xl/chartsheets/sheet2.xml': (xml) => xml.replace(/ zoomToFit="0"/, ' zoomToFit="1"'),
  }), 'mine.xlsx');
  expect(fitted.sheets[1]).toMatchObject({ zoomToFit: true, viewZoom: .5 });
});
