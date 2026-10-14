import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { linkedPictureFormula, linkedPictureTarget, rangePicture, rangePictureSize, svgDataUrl, RANGE_PICTURE_MAX_CELLS } from '../src/core/range-picture.js';
import { cellPicture } from '../src/core/cell-picture.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const xml = (z, p) => new TextDecoder().decode(X.CFB.find(z, p)?.content);
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Item'); wb.setInput(id, 0, 1, 'Qty');
  wb.setInput(id, 1, 0, 'Pens & <ink>'); wb.setInput(id, 1, 1, '12');
  wb.setInput(id, 2, 0, 'Total'); wb.setInput(id, 2, 1, '=B2*2');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { bold: true, bg: '#ffeeaa', bb: true });
  return { wb, id };
}
const linked = (wb, id, ref = 'Sheet1!$A$1:$B$3') => {
  const t = linkedPictureTarget(wb, id, ref), p = rangePicture(wb, t.sheetId, t.range);
  return wb.addChart(id, { type: 'image', src: svgDataUrl(p.svg), anchor: { r: 5, c: 3 }, dx: 0, dy: 0, w: p.w, h: p.h, pictureRef: ref, border: false });
};

describe('a picture of a range', () => {
  it('draws the values as formatted, fills, fonts and borders, without gridlines', () => {
    const { wb, id } = book();
    const { svg, w, h } = rangePicture(wb, id, { r1: 0, c1: 0, r2: 2, c2: 1 });
    expect({ w, h }).toEqual(rangePictureSize(wb, id, { r1: 0, c1: 0, r2: 2, c2: 1 }));
    expect(svg).toContain('>Item</tspan>');
    expect(svg).toContain('>Pens &amp; &lt;ink&gt;</tspan>');
    expect(svg).toContain('>24</tspan>');
    expect(svg).toContain('fill="#ffeeaa"');
    expect(svg).toContain('font-weight="bold"');
    expect(svg).toMatch(/<line [^>]*stroke="#000000"/);
    expect(svg.match(/<line /g)).toHaveLength(2); // the two bottom borders, and no gridlines
    expect(svg).not.toContain('foreignObject');
    // Numbers stand at the right of their cells.
    expect(svg).toMatch(/text-anchor="end"[^>]*><tspan[^>]*>12</);
  });

  it('shows pictures placed in cells, merged cells once, and leaves hidden lines out', () => {
    const { wb, id } = book();
    wb.setCells(id, [{ r: 3, c: 0, cell: { v: cellPicture(PNG, { alt: 'Logo' }) } }], 'Picture');
    wb.mergeCells(id, { r1: 4, c1: 0, r2: 4, c2: 1 });
    wb.setInput(id, 4, 0, 'Merged');
    const { svg } = rangePicture(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 });
    expect(svg).toContain(`<image href="${PNG}"`);
    expect(svg).toContain('aria-label="Logo"');
    expect(svg.match(/>Merged</g)).toHaveLength(1);
    expect(svg).toContain(`width="${wb.colWidth(id, 0) + wb.colWidth(id, 1)}"`);
    const before = rangePicture(wb, id, { r1: 0, c1: 0, r2: 2, c2: 1 });
    wb.sheet(id).hiddenRows.add(1);
    const after = rangePicture(wb, id, { r1: 0, c1: 0, r2: 2, c2: 1 });
    expect(after.h).toBe(before.h - wb.sheet(id).defaultRowHeight || before.h - 20);
    expect(after.svg).not.toContain('Pens');
  });

  it('declines a range too large to draw', () => {
    const { wb, id } = book();
    wb.ensureSize(id, 30000, 10);
    expect(rangePicture(wb, id, { r1: 0, c1: 0, r2: Math.ceil(RANGE_PICTURE_MAX_CELLS / 2) + 1, c2: 1 })).toBeNull();
  });
});

describe('a linked picture', () => {
  it('follows its cells: an edit changes what it draws', () => {
    const { wb, id } = book();
    const pid = linked(wb, id);
    const obj = wb.chartById(id, pid);
    expect(linkedPictureFormula(obj)).toBe('=Sheet1!$A$1:$B$3');
    const target = linkedPictureTarget(wb, id, obj.pictureRef);
    expect(target).toEqual({ sheetId: id, range: { r1: 0, c1: 0, r2: 2, c2: 1 } });
    expect(rangePicture(wb, id, target.range).svg).toContain('>24<');
    wb.setInput(id, 1, 1, '50');
    expect(rangePicture(wb, id, target.range).svg).toContain('>100<');
  });

  it('keeps naming the same cells when rows are inserted above them and the sheet is renamed', () => {
    const { wb, id } = book();
    const pid = linked(wb, id);
    wb.insertRows(id, 0, 2);
    expect(wb.chartById(id, pid).pictureRef).toBe('Sheet1!$A$3:$B$5');
    wb.renameSheet(id, 'Stock list');
    expect(wb.chartById(id, pid).pictureRef).toBe("'Stock list'!$A$3:$B$5");
    expect(linkedPictureTarget(wb, id, wb.chartById(id, pid).pictureRef).range).toEqual({ r1: 2, c1: 0, r2: 4, c2: 1 });
    wb.undo(); wb.undo();
    expect(wb.chartById(id, pid).pictureRef).toBe('Sheet1!$A$1:$B$3');
  });

  it('names nothing once its sheet is gone', () => {
    const { wb, id } = book();
    expect(linkedPictureTarget(wb, id, 'Nowhere!$A$1:$B$2')).toBeNull();
    expect(linkedPictureTarget(wb, id, '')).toBeNull();
  });

  it('survives saving and reopening the workbook', () => {
    const { wb, id } = book();
    linked(wb, id);
    const back = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(back.sheets[0].charts[0].pictureRef).toBe('Sheet1!$A$1:$B$3');
  });

  it('goes into .xlsx as a picture naming its cells, with the cells as they are now', async () => {
    const { wb, id } = book();
    linked(wb, id);
    wb.setInput(id, 1, 1, '7');
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    const z = X.CFB.read(bytes, { type: 'array' });
    const drawing = xml(z, '/xl/drawings/drawing1.xml');
    expect(drawing).toContain('<a14:cameraTool xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" cellRange="Sheet1!$A$1:$B$3"/>');
    expect(drawing).toMatch(/<xdr:pic>/);
    // The stored picture is the range now (B3 = 14), not the one pasted.
    const media = z.FullPaths.filter(p => /media\/image[\d_]+\.svg$/.test(p));
    expect(media).toHaveLength(1);
    expect(new TextDecoder().decode(X.CFB.find(z, media[0]).content)).toContain('>14<');
    const back = await workbookFromFile(bytes, 'linked.xlsx');
    expect(back.sheets[0].charts[0].pictureRef).toBe('Sheet1!$A$1:$B$3');
    // Read natively, without this app's record, the drawing alone keeps the link.
    X.CFB.utils.cfb_add(z, '/xl/workbook.xml', new TextEncoder().encode(xml(z, '/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
    const native = await workbookFromFile(X.CFB.write(z, { type: 'array', fileType: 'zip' }), 'native.xlsx');
    expect(native.sheets[0].charts[0].pictureRef).toBe('Sheet1!$A$1:$B$3');
  });
});
