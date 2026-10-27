import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { runTool, describeCall, callTarget } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: [['Docs', 1000, '=B1*2']] });
  wb.clearHistory();
  return { wb, id, env, run, describe: (name, args) => describeCall(wb, name, args, env) };
}

describe('set_link', () => {
  it('links a cell to a web address, keeping what it shows, in one undo step', () => {
    const { wb, id, run } = setup();
    const res = run('set_link', { cell: 'A1', url: 'https://example.com/help' });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content)).toEqual({ linked: 'Sheet1!A1', to: 'https://example.com/help', shows: 'Docs' });
    expect(wb.linkAt(id, 0, 0)).toEqual({ url: 'https://example.com/help', label: 'Docs' });
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect(wb.linkAt(id, 0, 0)).toBeNull();
  });

  it('keeps a number a number and a formula a formula', () => {
    const { wb, id, run } = setup();
    run('set_link', { cell: 'B1', url: 'www.example.com' });
    expect(wb.getCell(id, 0, 1)).toMatchObject({ v: 1000, hyperlink: 'https://www.example.com' });
    run('set_link', { cell: 'C1', url: 'name@example.com' });
    expect(wb.getCell(id, 0, 2).f).toBe('B1*2');
    expect(wb.linkAt(id, 0, 2).url).toBe('mailto:name@example.com');
  });

  it('shows the given text, or the address in an empty cell', () => {
    const { wb, id, run } = setup();
    run('set_link', { cell: 'D1', url: 'https://example.com', text: 'Example' });
    expect(wb.getValue(id, 0, 3)).toBe('Example');
    run('set_link', { cell: 'E1', url: 'https://example.org' });
    expect(wb.getValue(id, 0, 4)).toBe('https://example.org');
  });

  it('links to a place in the workbook or a named range, which the link follows', () => {
    const { wb, id, run } = setup();
    wb.addSheet('Q1 Data');
    run('set_link', { cell: 'D2', location: "'Q1 Data'!B3:C4" });
    expect(wb.linkAt(id, 1, 3).url).toBe("#'Q1 Data'!B3:C4");
    expect(wb.getValue(id, 1, 3)).toBe('Q1 Data!B3:C4');
    expect(wb.resolveLink(wb.linkAt(id, 1, 3).url, id).range).toEqual({ r1: 2, c1: 1, r2: 3, c2: 2 });
    wb.defineName('Totals', 'Sheet1!$B$1');
    run('set_link', { cell: 'D3', location: 'totals', text: 'Go to totals' });
    expect(wb.linkAt(id, 2, 3).url).toBe('#Totals');
    run('set_link', { cell: 'D4', location: 'A9' });
    expect(wb.linkAt(id, 3, 3).url).toBe('#Sheet1!A9');
  });

  it('refuses addresses that are not web pages, email or places in the workbook', () => {
    const { wb, id, run } = setup();
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com/x', 'vbscript:x', 'just words']) {
      const res = run('set_link', { cell: 'A1', url });
      expect(res.ok, url).toBe(false);
      expect(res.content).toMatch(/not a web address/);
    }
    expect(wb.linkAt(id, 0, 0)).toBeNull();
    expect(run('set_link', { cell: 'A1' }).content).toMatch(/Give the url/);
    expect(run('set_link', { cell: 'A1', url: 'https://a.com', location: 'A2' }).content).toMatch(/not both/);
  });

  it('removes a link, keeping what the cell shows', () => {
    const { wb, id, run } = setup();
    run('set_link', { cell: 'B1', url: 'https://example.com' });
    const res = run('set_link', { cell: 'B1', remove: true });
    expect(JSON.parse(res.content)).toEqual({ link_removed: 'Sheet1!B1', shows: '1000' });
    expect(wb.getCell(id, 0, 1)).toMatchObject({ v: 1000 });
    expect(wb.linkAt(id, 0, 1)).toBeNull();
    expect(run('set_link', { cell: 'B1', remove: true }).content).toMatch(/has no link/);
  });

  it('asks before replacing or removing a link, or replacing what a cell holds', () => {
    const { run, describe } = setup();
    expect(describe('set_link', { cell: 'A1', url: 'https://example.com' })).toEqual({ label: 'Link Sheet1!A1 to https://example.com', destructive: false, detail: null });
    expect(describe('set_link', { cell: 'C1', url: 'https://example.com', text: 'Double' })).toMatchObject({ destructive: true, detail: 'Replaces what the cell holds (a formula) with "Double".' });
    run('set_link', { cell: 'A1', url: 'https://example.com' });
    expect(describe('set_link', { cell: 'A1', url: 'https://example.com', text: 'Docs' }).destructive).toBe(false);
    expect(describe('set_link', { cell: 'A1', url: 'https://other.com' })).toMatchObject({ destructive: true, detail: 'Replaces its link to https://example.com.' });
    expect(describe('set_link', { cell: 'A1:B2', remove: true })).toMatchObject({ label: 'Remove the link from Sheet1!A1', destructive: true });
  });

  it('refuses a table header, a protected cell and a cell inside a merge', () => {
    const { wb, id, run } = setup();
    run('write_cells', { start_cell: 'A5', values: [['Name', 'Qty'], ['x', 1]] });
    wb.addTable(id, { r1: 4, c1: 0, r2: 5, c2: 1 });
    expect(run('set_link', { cell: 'A5', url: 'https://example.com' }).content).toMatch(/table's header/);
    wb.mergeCells(id, { r1: 8, c1: 0, r2: 8, c2: 2 });
    expect(run('set_link', { cell: 'B9', url: 'https://example.com' }).content).toMatch(/inside the merged cell A9:C9/);
    wb.setSheetProtected(id, true);
    expect(run('set_link', { cell: 'A1', url: 'https://example.com' }).content).toMatch(/protected/);
    expect(wb.linkAt(id, 0, 0)).toBeNull();
  });

  it('points the chat at its one cell', () => {
    const { wb, env } = setup();
    expect(callTarget(wb, 'set_link', { cell: 'B2:C9', url: 'https://example.com' }, env).range).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 });
  });

  it('keeps web and workbook links through a save as .xlsx', async () => {
    const { wb, run } = setup();
    wb.addSheet('Notes');
    run('set_link', { cell: 'A1', url: 'https://example.com' });
    run('set_link', { cell: 'A2', location: 'Notes!B2', text: 'See notes' });
    const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'saved.xlsx');
    const s = back.sheets[0].id;
    expect(back.linkAt(s, 0, 0)).toEqual({ url: 'https://example.com', label: 'Docs' });
    expect(back.linkAt(s, 1, 0)).toEqual({ url: '#Notes!B2', label: 'See notes' });
  });
});
