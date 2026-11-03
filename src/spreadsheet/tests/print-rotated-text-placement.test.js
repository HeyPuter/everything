// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPrintTable } from '../src/ui/print.js';
import { stylesheet } from './helpers/css.js';

// Turned text prints where the grid puts it. Print turned the text about its centre where it would sit
// level, so "Heading" at 45°, set at the top of a 70px row, printed half outside the cell's top edge and
// was cut there, and text up or down the cell sat a line's leading away from its top or bottom.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText(text) {
    return { width: [...text].length * 7 * Number(/([\d.]+)px/.exec(this.font)?.[1] || 13) / 13 };
  } });
  const css = document.createElement('style'); css.textContent = stylesheet('editor.css'); document.head.append(css);
});
afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function printed(style) {
  const wb = new Workbook({ sheets: [{ colWidths: { 0: 100 }, rowHeights: { 0: 70 }, cells: { '0,0': { v: 'Heading', s: { size: 13, ...style } } } }] });
  const table = buildPrintTable(wb, wb.activeSheetId, { fit: 'actual' });
  document.body.append(table);
  return table.querySelector('td');
}

it.each([45, -45, 30])('aligns the box of text turned %s° in the cell, the text turned about its centre inside it', rot => {
  const td = printed({ rot, valign: 'top' });
  const bounds = td.querySelector('.rot-bounds'), text = bounds.querySelector('.rot-text');
  const rad = Math.abs(rot) * Math.PI / 180, width = 7 * 7, height = 13 * 1.2;
  // The box the cell aligns is as big as the turned text, so text at the top starts at the top.
  expect(parseFloat(bounds.style.width)).toBeCloseTo(width * Math.cos(rad) + height * Math.sin(rad), 1);
  expect(parseFloat(bounds.style.height)).toBeCloseTo(width * Math.sin(rad) + height * Math.cos(rad), 1);
  expect(parseFloat(bounds.style.height)).toBeLessThan(70 - 6);
  expect(text.style.transform).toBe(`translate(-50%, -50%) rotate(${-rot}deg)`);
  expect(getComputedStyle(bounds).display).toBe('inline-block');
  expect(getComputedStyle(bounds).position).toBe('relative');
  expect(getComputedStyle(text).position).toBe('absolute');
  expect(td.querySelector('.print-cell').style.alignContent).toBe('start');
});

it.each([[90, 'up'], [-90, 'down']])('stacks text turned %s° down its cell from the edge it is set at', (rot, way) => {
  const td = printed({ rot, valign: 'bottom' });
  const text = td.querySelector('.rot-text');
  expect(text.classList.contains(way)).toBe(true);
  expect(getComputedStyle(text).writingMode).toBe('vertical-rl');
  // No line's leading below or above it: the line holds the turned text alone, 3px in from the edge as on the grid.
  const cell = td.querySelector('.print-cell');
  expect(getComputedStyle(cell).lineHeight).toBe('0');
  expect(getComputedStyle(text).verticalAlign).toBe('top');
  expect(cell.style.paddingBottom).toBe('3px');
  expect(cell.style.alignContent).toBe('unsafe end');
});

it('lays level text out as before', () => {
  const td = printed({ valign: 'top' });
  expect(td.querySelector('.rot-text, .rot-bounds')).toBeNull();
  expect(td.classList.contains('rot')).toBe(false);
});
