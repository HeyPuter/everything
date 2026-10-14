import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const zipOf = async wb => X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
const text = (zip, path) => new TextDecoder().decode(X.CFB.find(zip, path).content);
const reopen = zip => workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'arrange.xlsx');
// Drop the app's own record: the file as another program would leave it for this one.
const nativeOnly = zip => {
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  return zip;
};

const book = () => {
  const wb = new Workbook({ sheets: [{ name: 'Data', cells: { '0,0': { v: 1 } } }] });
  const id = wb.activeSheetId;
  const a = wb.addChart(id, { type: 'text', text: 'First', anchor: { r: 1, c: 1 }, dx: 4, dy: 2, w: 120, h: 60 });
  const b = wb.addChart(id, { type: 'image', src: PNG, title: 'dot.png', anchor: { r: 4, c: 3 }, dx: 0, dy: 0, w: 50, h: 50 });
  const c = wb.addChart(id, { type: 'text', text: 'Third', anchor: { r: 8, c: 2 }, dx: 0, dy: 0, w: 100, h: 40 });
  return { wb, id, a, b, c };
};

describe('xlsx arrange round trip', () => {
  it('keeps names, hidden objects, stacking order and text-box rotation', async () => {
    const { wb, id, a, b, c } = book();
    wb.renameObject(id, a, 'Intro note');
    wb.setObjectsHidden(id, [b], true);
    wb.orderObjects(id, [a], 'front');
    wb.rotateObjects(id, [c], 'right');
    const zip = await zipOf(wb);
    const drawing = text(zip, '/xl/drawings/drawing1.xml');
    expect(drawing).toMatch(/<xdr:cNvPr id="\d+" name="Intro note"/);
    expect(drawing).toMatch(/<xdr:cNvPr\b[^>]*name="dot.png"[^>]*hidden="1"/);
    expect(drawing).toMatch(/<a:xfrm rot="5400000">/);
    const back = (await reopen(zip)).activeSheet.charts;
    expect(back.map(o => o.type)).toEqual(['image', 'text', 'text']);
    expect(back[0].hidden).toBe(true);
    expect(back[2]).toMatchObject({ name: 'Intro note', text: 'First' });
    // Read as another program left it, the order and the hidden state still hold, and the name names the drawing.
    const plain = (await reopen(nativeOnly(await zipOf(wb)))).activeSheet.charts;
    expect(plain).toHaveLength(3);
    expect(plain[0].hidden).toBe(true);
    expect(plain[2].name ?? plain[2].title).toBe('Intro note');
    const own = (await reopen(await zipOf(wb))).activeSheet.charts;
    expect(own[1]).toMatchObject({ type: 'text', text: 'Third', rotation: 90 });
  });

  it('writes a group as one grpSp and reads it back as its objects, still grouped', async () => {
    const { wb, id, a, b, c } = book();
    const group = wb.groupObjects(id, [a, b]);
    const before = [a, b].map(x => wb.objectRect(id, x));
    const zip = await zipOf(wb);
    const drawing = text(zip, '/xl/drawings/drawing1.xml');
    const anchors = drawing.match(/<xdr:(?:oneCellAnchor|twoCellAnchor|absoluteAnchor)\b/g);
    expect(anchors).toHaveLength(2);
    const grp = drawing.match(/<xdr:grpSp>[\s\S]*?<\/xdr:grpSp>/)[0];
    expect(grp).toMatch(/<a:chOff x="0" y="0"\/><a:chExt/);
    expect(grp.match(/<xdr:(?:sp|pic)>/g)).toHaveLength(2);
    const back = await reopen(zip);
    const charts = back.activeSheet.charts;
    expect(charts).toHaveLength(3);
    const members = charts.filter(o => o.group);
    expect(members.map(o => o.type)).toEqual(['text', 'image']);
    expect(new Set(members.map(o => o.group)).size).toBe(1);
    expect(members[0].group).toBe(group);
    const after = members.map(o => back.objectRect(back.activeSheetId, o.id));
    after.forEach((r, i) => { expect(r.x).toBeCloseTo(before[i].x, 3); expect(r.y).toBeCloseTo(before[i].y, 3); });
    expect(charts.find(o => o.type === 'text' && !o.group).text).toBe('Third');
    // Without the app's record the group still comes back whole, as one drawing.
    const plain = await reopen(nativeOnly(await zipOf(wb)));
    expect(plain.activeSheet.charts.length).toBeGreaterThanOrEqual(2);
  });
});
