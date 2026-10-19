// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { heightForLines } from '../src/core/textfit.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));
const css = readFileSync(new FileURL('../src/styles/grid.css', import.meta.url), 'utf8');
/** The line-height the last rule naming exactly `selector` gives. */
const lineHeightOf = (selector) => {
  const rules = [...css.matchAll(/(^|\n)([^{}\n]+)\{([^}]*)\}/g)].filter((m) => m[2].split(',').map((s) => s.trim()).includes(selector));
  return Number(rules.map((m) => /line-height:\s*([\d.]+)/.exec(m[3])?.[1]).filter(Boolean).at(-1));
};

// Every new workbook, and every file from Excel, writes in Calibri, whose cells keep a compact 1.2 line
// for single lines. Wrapped text kept it too, while its rows are fitted at 1.3 a line (heightForLines):
// six wrapped lines sat in a row almost a line too tall, and the editor typed them closer than that.
describe('wrapped text in Calibri', () => {
  it('is drawn at the line pitch its rows are fitted for, in the cell and in its editor', () => {
    const pitch = (heightForLines(10, 100) - heightForLines(0, 100)) / 1000;
    expect(pitch).toBe(1.3);
    expect(lineHeightOf('.cell.calibri')).toBe(1.2); // one line keeps its compact metrics
    expect(lineHeightOf('.cell.wrap.calibri')).toBe(pitch);
    expect(lineHeightOf('.grid-editor.wrap.calibri')).toBe(pitch);
  });

  it('grows the editor of a wrapped Calibri cell by that pitch for each line typed', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.applyStyle(id, { r1: 1, c1: 1, r2: 1, c2: 1 }, { wrap: true, font: 'calibri', size: 14.67 });
    const st = wb.styleAt(id, 1, 1);
    expect(st.font).toBe('calibri');
    const grid = createGrid({ wb, sheetId: id, announce() {} });
    document.body.replaceChildren(grid.el);
    await flush();
    grid.selectByName('B2');
    grid.beginEdit({ text: '', mode: 'type' });
    grid.setEditText('one\ntwo\nthree');
    await flush();
    const editor = grid.el.querySelector('.grid-editor');
    expect(editor.classList.contains('calibri')).toBe(true);
    expect(editor.style.height).toBe(`${Math.round(3 * st.size * 1.3 + 2 + 6)}px`);
    grid.destroy();
  });
});
