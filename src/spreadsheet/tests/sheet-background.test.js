import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { normalizeBackground } from '../src/core/sheet-background.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// A 1 × 1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG.split(',')[1]), c => c.charCodeAt(0));
const unzip = async wb => X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
const text = (zip, path) => new TextDecoder().decode(X.CFB.find(zip, path).content);

describe('sheet background', () => {
  it('accepts only embedded bitmap pictures', () => {
    expect(normalizeBackground(PNG)).toEqual({ src: PNG });
    expect(normalizeBackground({ src: 'data:image/jpeg;base64,AAAA' })).toEqual({ src: 'data:image/jpeg;base64,AAAA' });
    expect(normalizeBackground('data:image/svg+xml;base64,AAAA')).toBeNull();
    expect(normalizeBackground('https://example.com/a.png')).toBeNull();
  });

  it('is set and deleted as undo steps and saved in the app format', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    expect(wb.setSheetBackground(id, PNG)).toBe(true);
    expect(wb.activeSheet.background).toEqual({ src: PNG });
    expect(new Workbook(wb.toJSON()).activeSheet.background).toEqual({ src: PNG });
    expect(wb.setSheetBackground(id, null)).toBe(true);
    expect(wb.activeSheet.background).toBeUndefined();
    wb.undo();
    expect(wb.activeSheet.background).toEqual({ src: PNG });
    wb.undo();
    expect(wb.activeSheet.background).toBeUndefined();
    expect(wb.setSheetBackground(id, 'not a picture')).toBe(false);
  });

  it('is written as the worksheet picture and read back', async () => {
    const wb = new Workbook({ sheets: [{ name: 'Data', cells: { '0,0': { v: 1 } } }, { name: 'Plain', cells: {} }] });
    wb.setSheetBackground(wb.sheets[0].id, PNG);
    const zip = await unzip(wb);
    const sheet = text(zip, '/xl/worksheets/sheet1.xml'), rels = text(zip, '/xl/worksheets/_rels/sheet1.xml.rels');
    expect(sheet).toMatch(/<picture r:id="puterBackground"\/>/);
    expect(sheet.indexOf('<picture')).toBeGreaterThan(sheet.indexOf('</sheetData>'));
    expect(rels).toContain('Target="../media/background1.png"');
    expect([...X.CFB.find(zip, '/xl/media/background1.png').content]).toEqual([...PNG_BYTES]);
    expect(text(zip, '/[Content_Types].xml')).toContain('/xl/media/background1.png');
    expect(text(zip, '/xl/worksheets/sheet2.xml')).not.toContain('<picture');
    const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'bg.xlsx');
    expect(back.sheets[0].background).toEqual({ src: PNG });
    expect(back.sheets[1].background).toBeUndefined();
  });

  it('reads the background another program saved', async () => {
    const bytes = otherProgramsXlsx({ sheetXml: { Data: { rows: '<row r="1"><c r="A1"><v>1</v></c></row>', tail: '<picture r:id="rId9"/>' } },
      patch: {} });
    const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
    X.CFB.utils.cfb_add(zip, '/xl/worksheets/_rels/sheet1.xml.rels', new TextEncoder().encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image7.png"/></Relationships>'));
    X.CFB.utils.cfb_add(zip, '/xl/media/image7.png', PNG_BYTES);
    const wb = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'other.xlsx');
    expect(wb.activeSheet.background).toEqual({ src: PNG });
  });
});
