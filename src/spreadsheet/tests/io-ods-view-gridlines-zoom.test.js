import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const settings = (bytes) => new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'settings.xml').content);

// LibreOffice keeps each sheet's gridlines and zoom with its frozen panes and tab colour in its view settings
// (ShowGrid, ZoomValue). Only the panes and colour were read and written, so a sheet with its gridlines hidden,
// or zoomed out to show a wide report, came back with gridlines at 100% in LibreOffice and here.
it('writes and reads a sheet\'s hidden gridlines and zoom in LibreOffice\'s view settings', async () => {
  const wb = new Workbook();
  wb.setInput(wb.activeSheetId, 0, 0, 'a');
  wb.addSheet('Report');
  const report = wb.sheets[1];
  wb.setInput(report.id, 0, 0, 'b');
  report.gridlines = false;
  report.viewZoom = 0.75;
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  const xml = settings(bytes);
  expect(xml).toMatch(/config:name="Report">[^]*config:name="ShowGrid" config:type="boolean">false</);
  expect(xml).toMatch(/config:name="Report">[^]*config:name="ZoomValue" config:type="int">75</);
  const back = await workbookFromFile(bytes, 'report.ods');
  expect(back.sheets.map((s) => [s.name, s.gridlines, s.viewZoom ?? 1])).toEqual([['Sheet1', true, 1], ['Report', false, 0.75]]);
});

it('leaves a sheet fitted to its page width (ZoomType 1) at its own zoom', async () => {
  const wb = new Workbook();
  wb.setInput(wb.activeSheetId, 0, 0, 'a');
  wb.activeSheet.viewZoom = 1.5;
  const zip = X.CFB.read(new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer()), { type: 'array' });
  const entry = X.CFB.find(zip, 'settings.xml');
  entry.content = new TextEncoder().encode(new TextDecoder().decode(entry.content).replace('config:name="ZoomType" config:type="short">0<', 'config:name="ZoomType" config:type="short">1<'));
  entry.size = entry.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'fit.ods');
  expect(back.activeSheet.viewZoom ?? 1).toBe(1);
});
