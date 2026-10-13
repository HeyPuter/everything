// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openDataAnalysis, openAnalysisTool } from '../src/ui/analysis-tools.js';
import { closeAllModals } from '../src/ui/modal.js';
import { toast } from '../src/ui/toast.js';
import * as P from '../src/lib/puter.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); toast.mockClear(); });

const panel = () => [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')].at(-1);
const field = (label) => panel().querySelector(`[aria-label="${label}"]`);
const radio = (text) => [...panel().querySelectorAll('label.check')].find((l) => l.textContent.trim() === text).querySelector('input');
const check = radio;
const submit = () => panel().querySelector('form').requestSubmit();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => { if (v != null) wb.setInput(id, r, c, String(v)); }));
  wb.clearHistory();
  const grid = { focus: vi.fn(), setSelection: vi.fn() };
  const ctx = { wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }), grid, run: vi.fn() };
  return { wb, id, ctx, grid };
}

describe('Data Analysis', () => {
  it('lists the tools and opens the one chosen', () => {
    const { ctx } = setup([['x'], [1], [2], [3]]);
    openDataAnalysis(ctx);
    const list = field('Analysis tools');
    expect(list.options.length).toBe(19);
    expect([...list.options].map((o) => o.textContent)).toContain('Regression');
    list.value = 'descriptive';
    list.dispatchEvent(new Event('change'));
    expect(panel().querySelector('.da-hint').textContent).toMatch(/Mean, spread/);
    submit();
    expect(panel().getAttribute('aria-label')).toBe('Descriptive Statistics');
    expect(field('Input range').value).toBe('$A$1:$A$4');
  });

  it('writes descriptive statistics into an output range as one step', async () => {
    const { wb, id, ctx, grid } = setup([['Score'], [4], [8], [6], [10]]);
    openAnalysisTool(ctx, 'descriptive');
    check('Labels in first row').checked = true;
    radio('Output range').checked = true;
    radio('Output range').dispatchEvent(new Event('change'));
    field('Output range').value = 'C1';
    submit();
    await settle();
    expect(wb.getValue(id, 0, 2)).toBe('Score');
    expect(wb.getValue(id, 1, 2)).toBe('Mean');
    expect(wb.getValue(id, 1, 3)).toBe(7);
    expect(wb.undoLabels()).toEqual(['Descriptive Statistics']);
    expect(grid.setSelection).toHaveBeenCalled();
    expect(document.querySelector('.modal-root:not(.closing)')).toBeNull();
  });

  it('says which cell is not a number and marks the field', () => {
    const { ctx } = setup([['a', 'b'], [1, 'x'], [2, 3]]);
    openAnalysisTool(ctx, 'anova1');
    submit();
    const input = field('Input range');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(panel().querySelector('.field-error').textContent).toMatch(/non-numeric data \(cell A1\)/);
    check('Labels in first row').checked = true;
    submit();
    expect(panel().querySelector('.field-error').textContent).toMatch(/cell B2/);
  });

  it('refuses an alpha outside 0 to 1', () => {
    const { ctx } = setup([[1, 2], [3, 4], [5, 7]]);
    openAnalysisTool(ctx, 'anova1');
    field('Alpha').value = '1.5';
    submit();
    expect(field('Alpha').getAttribute('aria-invalid')).toBe('true');
  });

  it('asks before writing over data, and leaves it when declined', async () => {
    const { wb, id, ctx } = setup([[1, 9], [2, 9], [3, 9], [5, 9]]);
    openAnalysisTool(ctx, 'moving');
    field('Input range').value = 'A1:A4';
    field('Interval').value = '2';
    radio('Output range').checked = true;
    radio('Output range').dispatchEvent(new Event('change'));
    field('Output range').value = 'B1';
    submit();
    await settle();
    expect(panel().getAttribute('aria-label')).toBe('Replace existing data?');
    [...panel().querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await settle();
    expect(wb.getValue(id, 1, 1)).toBe(9);
    submit();
    await settle();
    [...panel().querySelectorAll('button')].find((b) => b.textContent === 'Replace').click();
    await settle();
    expect(wb.getValue(id, 1, 1)).toBe(1.5);
  });

  it('writes a regression to a new sheet with its name', async () => {
    const { wb, ctx } = setup([['y', 'x'], [2, 1], [4, 2], [5, 3], [4, 4], [6, 5]]);
    openAnalysisTool(ctx, 'regression');
    field('Input Y range').value = 'A1:A6';
    field('Input X range').value = 'B1:B6';
    check('Labels').checked = true;
    check('Residuals').checked = true;
    check('Line fit plots').checked = true;
    field('New sheet name').value = 'Fit';
    submit();
    await settle();
    const sheet = wb.sheetByName('Fit');
    expect(sheet).toBeTruthy();
    expect(wb.activeSheetId).toBe(sheet.id);
    expect(wb.getValue(sheet.id, 0, 0)).toBe('Regression Summary');
    expect(sheet.charts).toHaveLength(1);
    expect(sheet.charts[0].sourceRefs[0].categories).toBe('Sheet1!$B$2:$B$6');
  });

  it('saves a new spreadsheet file and offers to open it', async () => {
    const { ctx } = setup([[1], [2], [3], [4]]);
    vi.spyOn(P, 'uniqueName').mockResolvedValue('Sampling.xlsx');
    const write = vi.spyOn(P, 'writeFile').mockResolvedValue({ name: 'Sampling.xlsx', path: 'Spreadsheets/Sampling.xlsx' });
    openAnalysisTool(ctx, 'sampling');
    field('Period').value = '2';
    radio('New spreadsheet').checked = true;
    radio('New spreadsheet').dispatchEvent(new Event('change'));
    submit();
    await vi.waitFor(() => expect(panel()?.querySelector('.field-error:not([hidden])')?.textContent ?? toast.mock.calls.length).toBe(1), { timeout: 10000 });
    expect(write.mock.calls[0][0]).toBe('Spreadsheets/Sampling.xlsx');
    expect(toast.mock.calls[0][1].action.label).toBe('Open');
  });

  it('random numbers show only the chosen distribution\'s parameters', () => {
    const { wb, ctx } = setup([[1]]);
    openAnalysisTool(ctx, 'random');
    const groups = [...panel().querySelectorAll('.da-params')];
    expect(groups.filter((g) => !g.hidden).map((g) => g.dataset.dist)).toEqual(['uniform']);
    field('Distribution').value = 'patterned';
    field('Distribution').dispatchEvent(new Event('change'));
    expect(groups.filter((g) => !g.hidden).map((g) => g.dataset.dist)).toEqual(['patterned']);
    expect(field('Number of random numbers').disabled).toBe(true);
    field('To').value = '3';
    submit();
    const sheet = wb.sheets.find((s) => s.id !== ctx.sheetId());
    expect([0, 1, 2].map((r) => wb.getValue(sheet.id, r, 0))).toEqual([1, 2, 3]);
  });
});
