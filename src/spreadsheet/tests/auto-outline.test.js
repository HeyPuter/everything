// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook, outlineSettingsOf } from '../src/core/workbook.js';
import { workbookToXlsx, workbookFromFile } from '../src/core/io.js';
import * as X from '../src/vendor/xlsx.mjs';
import { autoOutlineGroups, autoOutline, clearOutline, applyOutlineStyles, summaryLines } from '../src/core/auto-outline.js';
import { readXlsxOutlineSettings, writeXlsxOutlineSettings } from '../src/core/xlsx-outline.js';
import { detailGroup } from '../src/core/outline-detail.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';

/** Two regions with subtotals and a grand total in column B; a row of quarter totals in column F. */
function ledger() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [
    ['Region', 'Sales'],
    ['North a', '1'], ['North b', '2'], ['North', '=SUBTOTAL(9,B2:B3)'],
    ['South a', '3'], ['South b', '4'], ['South c', '5'], ['South', '=SUBTOTAL(9,B5:B7)'],
    ['Total', '=SUBTOTAL(9,B2:B8)'],
  ];
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  // Columns: C:E are months, F sums them on the first data row.
  ['10', '20', '30', '=SUM(C2:E2)'].forEach((v, i) => wb.setInput(id, 1, 2 + i, v));
  wb.setInput(id, 2, 2, '=C2*2'); // not a summary: no group from it
  wb.clearHistory();
  return { wb, id };
}

describe('Auto Outline', () => {
  it('builds nested row groups from subtotals and a column group from a row total', () => {
    const { wb, id } = ledger();
    const groups = autoOutlineGroups(wb, id);
    expect(groups.rows).toEqual([{ from: 1, to: 7 }, { from: 1, to: 2 }, { from: 4, to: 6 }]);
    expect(groups.cols).toEqual([{ from: 2, to: 4 }]);
    expect(autoOutline(wb, id)).toBe(4);
    expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to, g.level])).toEqual([[1, 7, 1], [1, 2, 2], [4, 6, 2]]);
    expect(wb.undoLabels()).toEqual(['Auto Outline']);
    wb.undo();
    expect(wb.outlineGroups(id, 'row')).toEqual([]);
  });

  it('reads summary rows above their detail when the settings say so', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    ['=SUM(A2:A4)', '1', '2', '3'].forEach((v, r) => wb.setInput(id, r, 0, v));
    expect(autoOutlineGroups(wb, id).rows).toEqual([]);
    wb.setOutlineSettings(id, { summaryBelow: false });
    expect(autoOutlineGroups(wb, id).rows).toEqual([{ from: 1, to: 3 }]);
    autoOutline(wb, id);
    // The outline button and Show/Hide Detail work from the summary row above the group.
    expect([...summaryLines(wb, id, 'row').keys()]).toEqual([0]);
    expect(detailGroup(wb, id, { active: { r: 0, c: 0 } }, false)).toEqual({ axis: 'row', from: 1, to: 3 });
  });

  it('works within a selection, and leaves partial overlaps out', () => {
    const { wb, id } = ledger();
    expect(autoOutlineGroups(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }).rows).toEqual([{ from: 1, to: 2 }]);
    const w2 = new Workbook();
    const s = w2.activeSheetId;
    ['1', '2', '=SUM(A1:A2)'].forEach((v, r) => w2.setInput(s, r, 0, v));
    w2.setInput(s, 3, 1, '=SUM(B2:B3)'); // B2:B3 overlaps A1:A2's run partly
    expect(autoOutlineGroups(w2, s).rows).toEqual([{ from: 0, to: 1 }]);
  });

  it('clears the outline (all of it, or within a range), showing the rows collapsed groups hid', () => {
    const { wb, id } = ledger();
    autoOutline(wb, id);
    wb.toggleGroup(id, 'row', 1, 2);
    expect(wb.sheet(id).hiddenRows.has(1)).toBe(true);
    expect(clearOutline(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 })).toBe(true);
    expect(wb.outlineGroups(id, 'row').map((g) => [g.from, g.to])).toEqual([[4, 6]]);
    expect(wb.sheet(id).hiddenRows.has(1)).toBe(false);
    expect(clearOutline(wb, id)).toBe(true);
    expect(wb.outlineGroups(id, 'row')).toEqual([]);
    expect(wb.outlineGroups(id, 'col')).toEqual([]);
    expect(clearOutline(wb, id)).toBe(false);
  });

  it('applies bold to the summary lines, on its own or automatically on Create', () => {
    const { wb, id } = ledger();
    expect(applyOutlineStyles(wb, id)).toBe(false);
    wb.setOutlineSettings(id, { autoStyles: true });
    autoOutline(wb, id);
    expect(wb.getCell(id, 3, 1).s?.bold).toBe(true); // North's subtotal row
    expect(wb.getCell(id, 8, 0).s?.bold).toBe(true); // the grand total
    expect(wb.getCell(id, 1, 5).s?.bold).toBe(true); // the summary column F
    expect(wb.getCell(id, 4, 1).s?.bold).toBeUndefined();
  });
});

describe('outline settings', () => {
  it('are an undo step, saved in drafts and round tripped through .xlsx outlinePr', async () => {
    vi.stubGlobal('Blob', NodeBlob); // jsdom's Blob cannot be read back
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'x');
    expect(wb.setOutlineSettings(id, { summaryBelow: false, autoStyles: true })).toBe(true);
    expect(wb.undoLabel()).toBe('Outline settings');
    expect(new Workbook(wb.toJSON()).sheet(id).outlineSettings).toEqual({ summaryBelow: false, autoStyles: true });
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    const zip = X.CFB.read(bytes, { type: 'array' });
    const xml = new TextDecoder().decode(X.CFB.find(zip, '/xl/worksheets/sheet1.xml').content);
    expect(xml).toMatch(/<sheetPr><outlinePr applyStyles="1" summaryBelow="0"\/><\/sheetPr>/);
    const back = await workbookFromFile(bytes, 'o.xlsx');
    expect(outlineSettingsOf(back.activeSheet)).toEqual({ summaryBelow: false, summaryRight: true, autoStyles: true });
    wb.undo();
    expect(wb.sheet(id).outlineSettings).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('write outlinePr in its place among the sheet properties', () => {
    const settings = { summaryRight: false };
    expect(writeXlsxOutlineSettings('<worksheet><sheetPr><tabColor rgb="FF0000FF"/><pageSetUpPr fitToPage="1"/></sheetPr></worksheet>', settings))
      .toBe('<worksheet><sheetPr><tabColor rgb="FF0000FF"/><outlinePr summaryRight="0"/><pageSetUpPr fitToPage="1"/></sheetPr></worksheet>');
    expect(writeXlsxOutlineSettings('<worksheet><sheetPr filterMode="1"/></worksheet>', settings)).toBe('<worksheet><sheetPr filterMode="1"><outlinePr summaryRight="0"/></sheetPr></worksheet>');
    expect(writeXlsxOutlineSettings('<worksheet><sheetPr><outlinePr summaryBelow="0"/></sheetPr></worksheet>', null)).toBe('<worksheet><sheetPr></sheetPr></worksheet>');
    expect(readXlsxOutlineSettings('<worksheet><sheetPr><outlinePr summaryBelow="false" summaryRight="1"/></sheetPr></worksheet>')).toEqual({ summaryBelow: false });
    expect(readXlsxOutlineSettings('<worksheet><sheetData/></worksheet>')).toBeNull();
  });
});

describe('outline tools in the editor', () => {
  let view;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    Element.prototype.scrollIntoView = () => {};
    Element.prototype.scrollTo = () => {};
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
    document.body.innerHTML = '<div id="app"></div>';
  });
  afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
  const flush = () => vi.advanceTimersByTimeAsync(1);

  it('runs Auto Outline from the Data ribbon and Create from the Settings dialog, and draws the button above when summaries lead', async () => {
    const doc = new Doc({ name: 'Ledger' });
    const { wb, id } = ledger();
    doc.wb.replaceWith(wb.toJSON());
    view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
    document.querySelector('#app').append(view.el);
    await flush();
    const book = doc.wb;
    [...view.el.querySelectorAll('.ribbon [role="tab"]')].find((n) => n.textContent === 'Data').click();
    await flush();
    const auto = [...view.el.querySelectorAll('.ribbon-panels button')].find((b) => b.getAttribute('aria-label') === 'Auto Outline');
    auto.click();
    await flush();
    expect(book.outlineGroups(id, 'row')).toHaveLength(3);
    await view.run('clearOutline');
    expect(book.outlineGroups(id, 'row')).toHaveLength(0);

    await view.run('outlineSettings');
    const box = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute('aria-label') === 'Outline Settings');
    const below = [...box.querySelectorAll('label')].find((l) => l.textContent === 'Summary rows below detail');
    document.getElementById(below.htmlFor).click();
    [...box.querySelectorAll('button')].find((b) => b.textContent === 'Create').click();
    await flush();
    expect(outlineSettingsOf(book.sheet(id)).summaryBelow).toBe(false);
    // With summaries above, B2:B3's subtotal (on row 4, below) is not a summary of anything.
    expect(book.outlineGroups(id, 'row')).toHaveLength(0);
    expect(book.undoLabel()).toBe('Auto Outline');
    book.undo();
    expect(outlineSettingsOf(book.sheet(id)).summaryBelow).toBe(true);
  });
});
