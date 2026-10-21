// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findAll, findAllSheets } from '../src/core/search.js';
import { createFindBar } from '../src/ui/findbar.js';
import { Workbook } from '../src/core/workbook.js';

// While the Find panel was open with a query, every edit searched the whole book again before the next frame: some
// 200 ms on each Enter on a sheet of 300,000 cells. After cells are written and nothing else, only what a write can
// change is looked at again (the cells written, every formula and every spilled value), with the same answer.

let seed = 11;
const rand = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
const inputs = ['apple', 'pineapple', '12', '1200', '=A1&"pie"', '=SEQUENCE(2,1,11)', '', '=LEN(B2)', 'Apple pie', '0.12', '=ROW()*6'];

describe('looking again after cells are written', () => {
  it('finds what a search afresh finds, on one sheet and on every sheet', () => {
    const wb = new Workbook();
    const ids = [wb.activeSheetId, wb.addSheet('Two').id];
    for (const id of ids) for (let r = 0; r < 12; r++) for (let c = 0; c < 5; c++) if (rand(3)) wb.setInput(id, r, c, inputs[rand(inputs.length)]);
    wb.setNumberFormat?.(ids[0], { r1: 0, c1: 0, r2: 3, c2: 4 }, '0.0%');
    for (const needle of ['apple', '12', 'pie', '2']) {
      for (let round = 0; round < 25; round++) {
        const opts = { formulas: round % 2 === 0, matchCase: round % 5 === 0 };
        const before = wb.version;
        const one = findAll(wb, ids[0], needle, opts).map((m) => ({ ...m, sheetId: ids[0] }));
        const every = findAllSheets(wb, needle, opts, ids[0]);
        for (let k = 1 + rand(3); k > 0; k--) {
          const id = ids[rand(2)];
          const r = rand(14), c = rand(6);
          if (rand(4)) wb.setInput(id, r, c, inputs[rand(inputs.length)]);
          else wb.transaction('Paste', () => { for (let i = 0; i < 3; i++) wb.setInput(id, r + i, c, inputs[rand(inputs.length)]); });
        }
        const changes = wb.changesSince(before);
        expect(changes.every((ch) => ch.type === 'cells' && ch.box)).toBe(true);
        const boxes = changes.map((ch) => ({ sheetId: ch.sheetId, ...ch.box }));
        expect(findAll(wb, ids[0], needle, { ...opts, written: { previous: one, boxes } })).toEqual(findAll(wb, ids[0], needle, opts));
        expect(findAllSheets(wb, needle, { ...opts, written: { previous: every, boxes } }, ids[0])).toEqual(findAllSheets(wb, needle, opts, ids[0]));
      }
    }
  });
});

describe('the Find panel on a large sheet', () => {
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

  it('keeps its matches up to date after an edit without reading every cell again', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 3000; r++) for (let c = 0; c < 4; c++) wb.setInput(id, r, c, c === 3 ? `=A${r + 1}*2` : c === 1 ? `item ${r}` : String(r * (c + 1)));
    let notify = null;
    const grid = { active: { r: 0, c: 0 }, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, setHighlights: vi.fn(), setSelection: vi.fn((s) => { grid.active = s.active; }), focus: vi.fn() };
    const bar = createFindBar({ wb, grid, sheetId: () => id, activeCell: () => null, announce: vi.fn(), subscribe: (fn) => { notify = fn; return () => {}; } });
    document.body.append(bar.el);
    bar.open();
    const query = bar.el.querySelector('[aria-label="Find"]');
    query.value = '24';
    query.dispatchEvent(new Event('input'));
    query.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const count = () => bar.el.querySelector('.find-count').textContent;
    const total = () => findAll(wb, id, '24').length;
    expect(count()).toMatch(new RegExp(` of ${total()}$`));
    // The values written are looked at again, and the formulas, which a write can change: 3,000 cells of 12,000.
    const reads = vi.spyOn(wb, 'getValue');
    wb.setInput(id, 5000, 0, '24');
    notify();
    wb.setInput(id, 2, 0, '12'); // its formula in D3 now shows 24
    notify();
    expect(reads.mock.calls.length).toBeLessThan(2 * (3000 + 10));
    reads.mockRestore();
    expect(count()).toMatch(new RegExp(` of ${total()}$`));
    expect(findAll(wb, id, '24').some((m) => m.r === 2 && m.c === 3)).toBe(true);
    bar.destroy();
  });
});
