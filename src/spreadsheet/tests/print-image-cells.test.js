// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildPrintTable } from '../src/ui/print.js';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';

// A cell holding =IMAGE(url) printed as an empty cell: its value formats to no text and nothing in the
// print table drew it, where the grid puts an <img> in the cell. A catalogue or product sheet lost its
// pictures on paper. IMAGE() cells now print their pictures.
function book(cells) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
  const cell = (a1) => {
    const { r, c } = parseCellRef(a1);
    return [...buildPrintTable(wb, id).querySelectorAll('tbody tr')][r].children[c];
  };
  return { wb, id, cell };
}

describe('IMAGE() cells in print', () => {
  it('print the picture fitted inside the cell, bounded by the row\'s height', () => {
    const { wb, id, cell } = book({ A1: '=IMAGE("https://example.com/x.png")', B1: 'x' });
    wb.setRowHeight?.(id, 0, 60);
    const td = cell('A1');
    expect(td.classList.contains('image')).toBe(true);
    expect(td.classList.contains('fit-contain')).toBe(true);
    expect(td.textContent).toBe('');
    expect(td.style.textAlign).toBe('center');
    const img = td.querySelector('img');
    expect(img.getAttribute('src')).toBe('https://example.com/x.png');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.style.width).toBe('100%');
    expect(img.style.height).toBe(`${wb.rowHeight(id, 0) - 2}px`);
    expect(img.style.objectFit).toBe('contain');
  });

  it('stretch or keep the picture\'s own size as the IMAGE mode asks', () => {
    const { wb, id, cell } = book({ A1: '=IMAGE("https://example.com/s.png", 2)', A2: '=IMAGE("https://example.com/o.png", 3)' });
    const stretched = cell('A1');
    expect(stretched.classList.contains('fit-stretch')).toBe(true);
    expect(stretched.querySelector('img').style.width).toBe('100%');
    expect(stretched.querySelector('img').style.height).toBe(`${wb.rowHeight(id, 0) - 2}px`);
    const original = cell('A2');
    expect(original.classList.contains('fit-original')).toBe(true);
    expect(original.querySelector('img').getAttribute('style')).toBeNull();
  });

  it('keep the cell\'s fill and borders around the picture, and leave sparkline cells as they were', () => {
    const { wb, id, cell } = book({ A1: '=IMAGE("https://example.com/x.png")', B1: '1', B2: '3', B3: '2', A2: '=SPARKLINE(B1:B3)' });
    wb.applyStyle(id, parseRange('A1:A1'), { bg: '#ffff00' });
    wb.applyBorders(id, parseRange('A1:A1'), 'outer');
    const td = cell('A1');
    expect(td.querySelector('img')).not.toBeNull();
    expect(td.style.backgroundColor).toBe('rgb(255, 255, 0)');
    expect(td.style.borderTop).toContain('1px solid');
    const spark = cell('A2');
    expect(spark.classList.contains('sparkline')).toBe(true);
    expect(spark.querySelector('svg')).not.toBeNull();
    expect(spark.querySelector('img')).toBeNull();
  });
});
