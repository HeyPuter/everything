import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

const zipOf = async (wb) => X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
const text = (zip, path) => new TextDecoder().decode(X.CFB.find(zip, path).content);
const reopen = (zip) => workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'smartart.xlsx');

describe('SmartArt in .xlsx', () => {
  it('writes a group of shapes and reopens as an editable diagram', async () => {
    const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
    const id = wb.activeSheetId;
    const d = wb.addChart(id, { type: 'smartart', layout: 'chevronProcess', items: [{ text: 'Discover', level: 0 }, { text: 'Interviews', level: 1 }, { text: 'Define', level: 0 }, { text: 'Deliver', level: 0 }],
      colors: 'colorful1', style: 'moderate', anchor: { r: 2, c: 1 }, dx: 4, dy: 3, w: 420, h: 240 });
    wb.renameObject(id, d, 'Roadmap');
    const zip = await zipOf(wb);
    const drawing = text(zip, '/xl/drawings/drawing1.xml');
    expect(drawing).toMatch(/<xdr:grpSp>/);
    expect(drawing).toMatch(/name="Roadmap"/);
    expect(drawing).toContain('<a:t>Discover</a:t>');
    expect(drawing).toContain('<a:t>Interviews</a:t>');
    expect(drawing).toMatch(/<a:custGeom>/);
    expect(drawing).toMatch(/<a:gradFill/);
    const back = await reopen(zip);
    const obj = back.activeSheet.charts[0];
    expect(obj).toMatchObject({ type: 'smartart', layout: 'chevronProcess', colors: 'colorful1', style: 'moderate', name: 'Roadmap', w: 420, h: 240, dx: 4, dy: 3, anchor: { r: 2, c: 1 } });
    expect(obj.items.map((it) => it.text)).toEqual(['Discover', 'Interviews', 'Define', 'Deliver']);
  });
});

describe('SmartArt from other programs', async () => {
  const { foreignDiagramXlsx } = await import('./helpers/xlsx-smartart-fixture.js');
  it('reads the outline and shows the shapes that program drew', async () => {
    const wb = await workbookFromFile(foreignDiagramXlsx(), 'theirs.xlsx');
    const [obj] = wb.activeSheet.charts;
    expect(obj).toMatchObject({ type: 'smartart', layout: 'basicProcess', description: 'How we ship', anchor: { r: 2, c: 1 } });
    expect(obj.items).toEqual([{ text: 'Design', level: 0 }, { text: 'Sketches', level: 1 }, { text: 'Build', level: 0 }, { text: 'Ship', level: 0 }]);
    expect(obj.fallback.src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(atob(obj.fallback.src.split(',')[1])).toContain('Build');
    expect(obj.fallback.nativeDrawing.node.name).toBe('grpSp');
  });

  it('keeps that drawing when saved unchanged, and its own layout once edited', async () => {
    const wb = await workbookFromFile(foreignDiagramXlsx(), 'theirs.xlsx');
    const id = wb.activeSheetId, obj = wb.activeSheet.charts[0];
    let drawing = text(await zipOf(wb), '/xl/drawings/drawing1.xml');
    expect(drawing).toContain('<a:t>Build</a:t>');
    expect(drawing).toMatch(/<a:prstGeom prst="roundRect">/);
    const again = await reopen(await zipOf(wb));
    expect(again.activeSheet.charts[0]).toMatchObject({ type: 'smartart', items: obj.items });
    expect(again.activeSheet.charts[0].fallback).toBeTruthy();
    wb.updateSmartArt(id, obj.id, { items: [...obj.items, { text: 'Learn', level: 0 }] });
    expect(wb.chartById(id, obj.id).fallback).toBeUndefined();
    drawing = text(await zipOf(wb), '/xl/drawings/drawing1.xml');
    expect(drawing).toContain('<a:t>Learn</a:t>');
    wb.undo();
    expect(wb.chartById(id, obj.id).fallback).toBeTruthy();
  });

  it('reads a diagram without drawn shapes as an editable diagram', async () => {
    const wb = await workbookFromFile(foreignDiagramXlsx({ drawn: false, layout: 'urn:microsoft.com/office/officeart/2005/8/layout/orgChart1' }), 'bare.xlsx');
    const [obj] = wb.activeSheet.charts;
    expect(obj).toMatchObject({ type: 'smartart', layout: 'orgChart' });
    expect(obj.fallback).toBeUndefined();
    expect(obj.items.map((it) => it.text)).toEqual(['Design', 'Sketches', 'Build', 'Ship']);
  });
});
