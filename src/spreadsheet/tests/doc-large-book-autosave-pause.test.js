import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Doc, noteUserInput } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

// Encoding a large book for its autosave held the page for about a second (200,000 cells pasted, then a frame of
// nearly two seconds while scrolling). A large book's autosave now waits for a pause in what the user is doing,
// though never more than ten seconds past its time, and the encoding gives the page turns along the way.
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
let mock;
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true }); mock = installMockPuter(); });
afterEach(() => { delete globalThis.puter; vi.useRealTimers(); });

function largeBook(rows = 6000) {
  const wb = new Workbook({ sheets: [{ name: 'S' }] });
  const id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < 10; c++) entries.push({ r, c, cell: { v: r * 10 + c, f: null } });
  wb.setCells(id, entries, 'Paste');
  return { wb, id };
}
const writes = () => mock.calls.filter(([op, path]) => op === 'write' && !path.includes('/.versions/')).length;

it('saves a large book once the user pauses, and at the latest ten seconds past its time', async () => {
  const { wb, id } = largeBook();
  const doc = new Doc({ wb, name: 'Big' });
  await doc.save();
  vi.useFakeTimers();
  try {
    const before = writes();
    wb.setInput(id, 0, 0, 'edit');
    // Scrolling about: the save waits.
    for (let t = 0; t < 4000; t += 250) { noteUserInput(); await vi.advanceTimersByTimeAsync(250); }
    expect(writes()).toBe(before);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.runOnlyPendingTimersAsync();
    expect(writes()).toBe(before + 1);
    // Never pausing, the save goes ahead all the same.
    wb.setInput(id, 0, 1, 'again');
    for (let t = 0; t < 12_000; t += 250) { noteUserInput(); await vi.advanceTimersByTimeAsync(250); }
    expect(writes()).toBe(before + 2);
  } finally { doc.destroy(); }
});

it('saves an ordinary book as soon as its time comes, however busy the user is', async () => {
  const doc = Doc.blank();
  const id = doc.wb.activeSheetId;
  doc.wb.setInput(id, 0, 0, 'first');
  await doc.save();
  vi.useFakeTimers();
  try {
    const before = writes();
    doc.wb.setInput(id, 0, 0, 'edit');
    for (let t = 0; t < 2500; t += 250) { noteUserInput(); await vi.advanceTimersByTimeAsync(250); }
    expect(writes()).toBe(before + 1);
  } finally { doc.destroy(); }
});

it('encodes the book as it is when a sheet is added while the page has its turn', async () => {
  const { wb } = largeBook();
  const Real = globalThis.MessageChannel;
  let turns = 0;
  // The page's turns: the second, between writing the cells and finishing the file, adds a sheet.
  globalThis.MessageChannel = class {
    constructor() {
      this.port1 = { close() {} };
      this.port2 = { postMessage: () => setTimeout(() => { if (++turns === 2) wb.addSheet('Late'); this.port1.onmessage(); }, 0) };
    }
  };
  try {
    const back = await workbookFromFile(await (await workbookToXlsx(wb)).arrayBuffer(), 'big.xlsx');
    // A book of two sheets is finished a sheet at a time, which may give the page further turns.
    expect(turns).toBeGreaterThanOrEqual(2);
    expect(back.sheets.map((s) => s.name)).toEqual(['S', 'Late']);
    expect(back.getValue(back.sheets[0].id, 5999, 9)).toBe(59999);
  } finally { globalThis.MessageChannel = Real; }
});

describe('a large book of many sheets', () => {
  function manySheets(sheets = 12, rows = 500) {
    const wb = new Workbook({ sheets: Array.from({ length: sheets }, (_, i) => ({ name: `S${i + 1}` })) });
    for (const sheet of wb.sheets) {
      const entries = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < 10; c++) entries.push({ r, c, cell: c === 9 ? { f: `SUM(A${r + 1}:I${r + 1})` } : { v: r * 10 + c } });
      wb.setCells(sheet.id, entries, 'Paste');
    }
    return wb;
  }
  // Counts the page's turns, running `during(turn)` in each.
  function turnsWith(during = () => {}) {
    const Real = globalThis.MessageChannel;
    const state = { turns: 0, restore: () => { globalThis.MessageChannel = Real; } };
    globalThis.MessageChannel = class {
      constructor() {
        this.port1 = { close() {} };
        this.port2 = { postMessage: () => setTimeout(() => { during(++state.turns); this.port1.onmessage(); }, 0) };
      }
    };
    return state;
  }

  it('gives the page turns between its sheets, not only between the steps', async () => {
    const wb = manySheets();
    const slow = vi.spyOn(performance, 'now');
    let clock = 0;
    slow.mockImplementation(() => (clock += 40)); // every sheet takes longer than a slice
    const state = turnsWith();
    try {
      const back = await workbookFromFile(await (await workbookToXlsx(wb)).arrayBuffer(), 'many.xlsx');
      // Two steps' turns, and more between the sheets as they are built and as the file is finished.
      expect(state.turns).toBeGreaterThan(2 + 2 * (wb.sheets.length - 2));
      expect(back.sheets.map((s) => s.name)).toEqual(wb.sheets.map((s) => s.name));
      expect(back.getValue(back.sheets[11].id, 499, 9)).toBe(wb.getValue(wb.sheets[11].id, 499, 9));
    } finally { state.restore(); slow.mockRestore(); }
  });

  it('finishes the file from the book as it is when a cell or the active sheet changes on a turn', async () => {
    for (const change of [(wb) => wb.setInput(wb.sheets[11].id, 0, 0, 'late'), (wb) => wb.setActiveSheet(wb.sheets[5].id)]) {
      const wb = manySheets();
      const slow = vi.spyOn(performance, 'now');
      let clock = 0;
      slow.mockImplementation(() => (clock += 40));
      // A turn late in the run (12 while the sheets are built, 2 between the steps), while the file is being finished.
      const state = turnsWith((turn) => { if (turn === 20) change(wb); });
      try {
        const blob = await workbookToXlsx(wb);
        expect(state.turns).toBeGreaterThanOrEqual(20);
        const back = await workbookFromFile(await blob.arrayBuffer(), 'many.xlsx');
        expect(back.getValue(back.sheets[11].id, 0, 0)).toBe(wb.getValue(wb.sheets[11].id, 0, 0));
        expect(back.activeSheet.name).toBe(wb.activeSheet.name);
        // One tab selected: the old active sheet's and the new one's together open in Excel as grouped sheets.
        const X = await import('../src/vendor/xlsx.mjs');
        const zip = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
        const selected = zip.FullPaths.filter((path) => /worksheets\/sheet\d+\.xml$/.test(path)
          && /tabSelected="1"/.test(new TextDecoder().decode(X.CFB.find(zip, path).content)));
        expect(selected).toHaveLength(1);
      } finally { state.restore(); slow.mockRestore(); }
    }
  });
});
