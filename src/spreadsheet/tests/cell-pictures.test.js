import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { editText, formatValue } from '../src/core/format.js';
import {
  cellPicture, cellPictureAspect, cellPictureFromObject, cellPictureLabel, cellPictureObjectPosition, fitCellPicture, isCellPicture,
  objectFromCellPicture, placedPicturesIn, placedSize, setCellPictureAlt,
} from '../src/core/cell-picture.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const picture = (alt = '') => cellPicture(PNG, { alt });
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [
    { r: 0, c: 0, cell: { v: 'Name' } }, { r: 0, c: 1, cell: { v: 'Photo' } },
    { r: 1, c: 0, cell: { v: 'Pear' } }, { r: 1, c: 1, cell: { v: picture('A pear') } },
    { r: 2, c: 0, cell: { v: 'Apple' } }, { r: 2, c: 1, cell: { v: 3 } },
    { r: 3, c: 0, cell: { v: 'Fig' } }, { r: 3, c: 1, cell: { v: picture('A fig') } },
  ], 'Setup');
  return { wb, id };
}

describe('the cell picture value', () => {
  it('holds the source, a fit and trimmed alt text', () => {
    expect(cellPicture(PNG, { alt: '  Logo  ' })).toEqual({ image: PNG, fit: 'contain', alt: 'Logo' });
    expect(cellPicture(PNG)).toEqual({ image: PNG, fit: 'contain' });
    expect(cellPicture(PNG, { fit: 'nonsense' }).fit).toBe('contain');
    expect(isCellPicture(picture())).toBe(true);
    expect(isCellPicture({ error: '#VALUE!' })).toBe(false);
    expect(cellPictureLabel(picture('Logo'))).toBe('Picture: Logo');
    expect(cellPictureLabel(picture())).toBe('Picture');
  });

  it('is fitted whole into its cell against the sides its alignment names', () => {
    const box = { w: 100, h: 40 }, natural = { w: 200, h: 100 };
    expect(fitCellPicture(natural, box)).toEqual({ x: 10, y: 0, w: 80, h: 40 });
    expect(fitCellPicture(natural, box, { align: 'left' }).x).toBe(0);
    expect(fitCellPicture(natural, box, { align: 'right' }).x).toBe(20);
    expect(fitCellPicture({ w: 100, h: 10 }, box, { valign: 'bottom' })).toEqual({ x: 0, y: 30, w: 100, h: 10 });
    expect(fitCellPicture(natural, box, null, 'stretch')).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    expect(cellPictureAspect({ align: 'left', valign: 'top' })).toBe('xMinYMin meet');
    expect(cellPictureAspect(null)).toBe('xMidYMid meet');
    expect(cellPictureAspect({ align: 'right', valign: 'bottom' })).toBe('xMaxYMax meet');
    expect(cellPictureAspect({}, 'stretch')).toBe('none');
    expect(cellPictureObjectPosition({ align: 'right', valign: 'top' })).toBe('right top');
    expect(cellPictureObjectPosition(undefined)).toBe('center center');
  });

  it('shows no text and edits as empty, so an unchanged entry keeps the picture', () => {
    expect(formatValue(picture(), {})).toBe('');
    expect(editText({ v: picture() })).toBe('');
  });
});

describe('a picture in a cell behaves as the cell does', () => {
  it('is shown by a formula referring to it and answers the IS functions sensibly', () => {
    const { wb, id } = book();
    wb.setInput(id, 0, 3, '=B2');
    wb.setInput(id, 1, 3, '=ISNUMBER(B2)');
    wb.setInput(id, 2, 3, '=ISTEXT(B2)');
    wb.setInput(id, 3, 3, '=ISERROR(B2)');
    wb.setInput(id, 4, 3, '=TYPE(B2)');
    wb.setInput(id, 5, 3, '=ISBLANK(B2)');
    wb.setInput(id, 6, 3, '=COUNTA(B2:B4)');
    expect(wb.getValue(id, 0, 3)).toEqual(picture('A pear'));
    expect(wb.getValue(id, 1, 3)).toBe(false);
    expect(wb.getValue(id, 2, 3)).toBe(false);
    expect(wb.getValue(id, 3, 3)).toBe(false);
    expect(wb.getValue(id, 4, 3)).toBe(128);
    expect(wb.getValue(id, 5, 3)).toBe(false);
    expect(wb.getValue(id, 6, 3)).toBe(3);
  });

  it('moves with its row when sorted, after the values in either direction', () => {
    const { wb, id } = book();
    wb.sortRange(id, { r1: 1, c1: 0, r2: 3, c2: 1 }, 0, true);
    expect([1, 2, 3].map(r => wb.getValue(id, r, 0))).toEqual(['Apple', 'Fig', 'Pear']);
    expect(wb.getValue(id, 2, 1)).toEqual(picture('A fig'));
    expect(wb.getValue(id, 3, 1)).toEqual(picture('A pear'));
    wb.undo();
    expect(wb.getValue(id, 1, 1)).toEqual(picture('A pear'));
    // Sorted by the picture column: the number first, the pictures after it, ascending or descending.
    for (const ascending of [true, false]) {
      wb.sortRange(id, { r1: 1, c1: 0, r2: 3, c2: 1 }, 1, ascending);
      expect(wb.getValue(id, 1, 1)).toBe(3);
      expect(isCellPicture(wb.getValue(id, 2, 1)) && isCellPicture(wb.getValue(id, 3, 1))).toBe(true);
    }
  });

  it('is copied and pasted with its cell, alt text and all', () => {
    const { wb, id } = book();
    const cells = wb.copyRange(id, { r1: 1, c1: 0, r2: 1, c2: 1 });
    wb.pasteCells(id, cells, 8, 0, { r: 1, c: 0 });
    expect(wb.getValue(id, 8, 1)).toEqual(picture('A pear'));
  });

  it('is hidden with its row by a filter and kept as it was', () => {
    const { wb, id } = book();
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 1 });
    wb.setFilterCriteria(id, 0, { values: ['Apple', 'Fig'] });
    expect([1, 2, 3].map(r => wb.isRowHidden(id, r))).toEqual([true, false, false]);
    expect(wb.getValue(id, 1, 1)).toEqual(picture('A pear'));
    expect(wb.getValue(id, 3, 1)).toEqual(picture('A fig'));
  });

  it('survives saving the workbook and opening it again', () => {
    const { wb, id } = book();
    const back = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(back.getValue(back.activeSheetId, 3, 1)).toEqual(picture('A fig'));
    expect(placedPicturesIn(back, back.activeSheetId, { r1: 0, c1: 0, r2: 9, c2: 9 }).map(p => [p.r, p.c])).toEqual([[1, 1], [3, 1]]);
    expect(id).toBeTruthy();
  });

  it('has alt text set and cleared as one undoable edit', () => {
    const { wb, id } = book();
    expect(setCellPictureAlt(wb, id, 1, 1, 'A ripe pear')).toBe(true);
    expect(wb.getValue(id, 1, 1).alt).toBe('A ripe pear');
    expect(setCellPictureAlt(wb, id, 1, 1, '')).toBe(true);
    expect(wb.getValue(id, 1, 1)).toEqual({ image: PNG, fit: 'contain' });
    wb.undo();
    expect(wb.getValue(id, 1, 1).alt).toBe('A ripe pear');
    expect(setCellPictureAlt(wb, id, 2, 1, 'not a picture')).toBe(false);
  });
});

describe('IMAGE with alt text', () => {
  it('reads alt text second and the sizing third', () => {
    const wb = new Workbook(), id = wb.activeSheetId;
    wb.setInput(id, 0, 0, `=IMAGE("${PNG}", "Company logo")`);
    wb.setInput(id, 1, 0, `=IMAGE("${PNG}", "Logo", 1)`);
    wb.setInput(id, 2, 0, `=IMAGE("${PNG}", , 2)`);
    wb.setInput(id, 3, 0, `=IMAGE("${PNG}", 2)`);
    expect(wb.getValue(id, 0, 0)).toEqual({ image: PNG, fit: 'contain', alt: 'Company logo' });
    expect(wb.getValue(id, 1, 0)).toEqual({ image: PNG, fit: 'stretch', alt: 'Logo' });
    expect(wb.getValue(id, 2, 0)).toEqual({ image: PNG, fit: 'original' });
    expect(wb.getValue(id, 3, 0)).toEqual({ image: PNG, fit: 'stretch' });
  });
});

describe('floating and cell pictures convert into each other', () => {
  it('makes a floating picture over the cell, sized as an inserted one', () => {
    const obj = objectFromCellPicture(picture('Logo'), { r: 2, c: 3 }, { w: 960, h: 480 });
    expect(obj).toMatchObject({ type: 'image', src: PNG, title: 'Logo', description: 'Logo', anchor: { r: 2, c: 3 }, dx: 0, dy: 0, w: 480, h: 240 });
    expect(placedSize({ w: 100, h: 50 })).toEqual({ w: 100, h: 50 });
    expect(objectFromCellPicture({ image: 'https://example.com/a.png', fit: 'contain' }, { r: 0, c: 0 })).toBeNull();
  });

  it('makes a cell picture of a floating one, its alt text from the description', () => {
    expect(cellPictureFromObject({ type: 'image', src: PNG, description: 'Chart of sales' })).toEqual({ image: PNG, fit: 'contain', alt: 'Chart of sales' });
    expect(cellPictureFromObject({ type: 'image', src: PNG, description: 'x', decorative: true })).toEqual({ image: PNG, fit: 'contain' });
    expect(cellPictureFromObject({ type: 'text', text: 'x' })).toBeNull();
  });
});

describe('the accessibility check', () => {
  it('lists cell pictures without alt text, and not those described', async () => {
    const { checkAccessibility } = await import('../src/core/accessibility-check.js');
    const { wb, id } = book();
    wb.setCells(id, [{ r: 5, c: 1, cell: { v: cellPicture(PNG) } }], 'No alt');
    const found = checkAccessibility(wb).filter(f => f.rule === 'altText');
    expect(found.map(f => f.label)).toEqual(['Picture in B6 (Sheet1)']);
    expect(found[0].target).toEqual({ range: { r1: 5, c1: 1, r2: 5, c2: 1 } });
  });
});
