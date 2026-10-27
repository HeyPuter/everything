// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });
const flush = () => new Promise((r) => setTimeout(r, 5));

// Scrolling past the last row grows the sheet, which moved the version on without recording the change:
// changesSince then answered "anything may have changed" for every span reaching across the growth, and
// everything built from the book — every chart on the sheet shown — was rebuilt from a full range walk.

const ROWS = 2000;
const N = 8;
const BAND = ROWS / N;

/** Four columns over 2,000 rows and eight line charts, each over a band; each band's last cell is left blank. */
function dashboard() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.ensureSize(id, ROWS + 100, 26);
  const entries = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < 4; c++) if (!(c === 3 && (r + 1) % BAND === 0)) entries.push({ r, c, cell: { v: (r * 7 + c) % 100, f: null } });
  wb.setCells(id, entries, 'fill');
  for (let i = 0; i < N; i++) wb.addChart(id, { type: 'line', range: { r1: i * BAND, c1: 0, r2: (i + 1) * BAND - 1, c2: 3 }, anchor: { r: 2 + i * 12, c: 12 }, w: 300, h: 200 });
  return { wb, id };
}

/** Which charts read their range: each band's one blank cell is looked up for a spill only when its range is read. */
function watchReads(wb) {
  const bands = new Set();
  const spillAt = wb.spillAt.bind(wb);
  wb.spillAt = (sheetId, r, c) => {
    if (c === 3 && r < ROWS && (r + 1) % BAND === 0) bands.add((r + 1) / BAND - 1);
    return spillAt(sheetId, r, c);
  };
  return { bands, reset: () => bands.clear() };
}

describe('growing a sheet records the change it announces', () => {
  it('reports the growth to changesSince instead of leaving a hole in the record', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const before = wb.version;
    expect(wb.ensureSize(id, 400, 26)).toBe(true);
    expect(wb.changesSince(before)).toEqual([{ version: wb.version, type: 'layout', sheetId: id, box: null, formula: false, grow: true }]);
    // And the record still reaches back across it: a write after a growth is still reported with its box.
    const across = wb.version;
    wb.setInput(id, 300, 2, 'x');
    const changes = wb.changesSince(before);
    expect(changes).toHaveLength(2);
    expect(changes[0].type).toBe('layout');
    expect(changes[1]).toMatchObject({ type: 'cells', sheetId: id, box: { r1: 300, c1: 2, r2: 300, c2: 2 } });
    expect(wb.changesSince(across)).toEqual([changes[1]]);
    // Growth is still no edit of the document, and still no step to undo.
    expect(wb.undoLabels()).toHaveLength(1);
  });

  it('keeps the record bounded however far the sheet is scrolled', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (let i = 0; i < 600; i++) wb.ensureSize(id, 200 + i * 100, 26);
    expect(wb._changeLog.length).toBeLessThanOrEqual(512);
    expect(wb.changesSince(wb.version - 1)).toHaveLength(1);
  });

  it('does not send the charts of the sheet shown over their ranges when another sheet grows', { timeout: 60000 }, async () => {
    const { wb, id } = dashboard();
    const other = wb.addSheet('Other').id;
    const grid = createGrid({ wb, sheetId: id });
    document.body.replaceChildren(grid.el);
    await flush();
    const boxes = [...grid.el.querySelectorAll('.chart-box')];
    expect(boxes).toHaveLength(N);
    const pictures = () => boxes.map((b) => b.querySelector('svg'));
    const drawn = pictures();
    const reads = watchReads(wb);

    // Scrolling past the last row of a sheet that is not on show: every chart here used to be rebuilt.
    wb.ensureSize(other, 600, 26);
    await flush();
    expect([...reads.bands]).toEqual([]);
    expect(pictures()).toEqual(drawn);

    // A change that really reaches a chart is still seen after that growth: the record must not go stale.
    reads.reset();
    wb.setInput(id, 3 * BAND + 5, 1, '4242');
    await flush();
    expect([...reads.bands]).toEqual([3]);
    expect(pictures().map((svg, i) => svg === drawn[i])).toEqual(Array.from({ length: N }, (_, i) => i !== 3));

    // And inside one transaction with a growth of the sheet shown, which reaches every chart on it.
    const kept = pictures();
    reads.reset();
    wb.transaction('Grow and write', () => {
      wb.ensureSize(id, wb.sheet(id).rows + 100, 26);
      wb.setInput(id, 5 * BAND + 5, 1, '777');
    });
    await flush();
    expect(reads.bands.has(5)).toBe(true);
    expect(pictures()[5]).not.toBe(kept[5]);
    grid.destroy();
  });
});
