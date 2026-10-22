import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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
    expect(turns).toBe(2);
    expect(back.sheets.map((s) => s.name)).toEqual(['S', 'Late']);
    expect(back.getValue(back.sheets[0].id, 5999, 9)).toBe(59999);
  } finally { globalThis.MessageChannel = Real; }
});
