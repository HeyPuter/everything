// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createAutomate } from '../src/ui/automate.js';

globalThis.matchMedia ??= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

function setup() {
  const wb = new Workbook();
  const grid = { el: document.createElement('div'), focus() {}, editing: false };
  const automate = createAutomate({ wb, grid, sheetId: () => wb.activeSheetId, active: () => ({ r: 0, c: 0 }) }, { library: null });
  document.body.append(automate.pane, grid.el);
  return automate;
}
const press = (node, key, times = 1) => { for (let i = 0; i < times; i++) node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); };

describe('Code Editor pane resizing', () => {
  it('turns back at once after the pane is widened to its limit', () => {
    const pane = setup().pane;
    const handle = pane.querySelector('.sp-resize');
    press(handle, 'ArrowLeft', 40); // far past 70% of the window
    const widest = parseFloat(pane.style.width);
    expect(widest).toBeCloseTo(window.innerWidth * 0.7, 0);
    press(handle, 'ArrowRight');
    expect(parseFloat(pane.style.width)).toBe(Math.round(widest) - 24);
  });

  it('turns back at once after the output is shrunk to its limit', () => {
    const pane = setup().pane;
    const split = pane.querySelector('.sp-split');
    const box = pane.querySelector('.sp-output-box');
    press(split, 'ArrowDown', 30);
    expect(box.style.height).toBe('60px');
    press(split, 'ArrowUp');
    expect(box.style.height).toBe('80px');
    expect(localStorage.getItem('spreadsheet:scripts-output-height')).toBe('80');
  });

  it('tells assistive technology the size each handle stands at', () => {
    const pane = setup().pane;
    const handle = pane.querySelector('.sp-resize');
    const split = pane.querySelector('.sp-split');
    expect(handle.getAttribute('aria-valuenow')).toBe('440');
    expect(handle.getAttribute('aria-valuemin')).toBe('320');
    expect(Number(handle.getAttribute('aria-valuemax'))).toBe(Math.round(window.innerWidth * 0.7));
    expect(split.getAttribute('aria-valuenow')).toBe('150');
    press(handle, 'ArrowLeft');
    press(split, 'ArrowUp');
    expect(handle.getAttribute('aria-valuenow')).toBe('464');
    expect(split.getAttribute('aria-valuenow')).toBe('170');
  });
});
