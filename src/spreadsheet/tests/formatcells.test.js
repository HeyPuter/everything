// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

beforeAll(() => {
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

function fakeCtx(wb) {
  const id = wb.sheets[0].id;
  const runs = [];
  return {
    wb, runs,
    sheetId: () => id,
    active: () => ({ r: 0, c: 0 }),
    range: () => parseRange('A1:A1'),
    style: () => wb.getCell(id, 0, 0)?.s || {},
    run: (cmd, arg) => runs.push([cmd, arg]),
    grid: { editing: false, focus() {}, commitEdit() {} },
  };
}

describe('format cells dialog', () => {
  it.each([
    ['number', '1234.50', '1,234.50'],
    ['currency', '$1234.50', '$1,234.50'],
    ['percent', '123450.00%', '123,450.00%'],
  ])('turns off thousands separators for %s and supports undo and re-enabling', async (fmt, plain, grouped) => {
    const { openFormatCellsDialog } = await import('../src/ui/formatcells.js');
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '1234.5');
    wb.applyStyle(id, parseRange('A1'), { fmt, dec: 2, bold: true });
    wb.clearHistory();
    const ctx = fakeCtx(wb);
    ctx.run = (cmd, { patch }) => wb.applyStyle(id, parseRange('A1'), patch);
    const modal = openFormatCellsDialog(ctx);
    try {
      const group = [...modal.panel.querySelectorAll('label')].find((label) => label.textContent.trim() === 'Thousands separator').querySelector('input');
      group.click();
      expect(modal.panel.textContent).toContain(`Preview: ${plain}`);
      modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
      expect(wb.getDisplay(id, 0, 0)).toBe(plain);
      expect(wb.getCell(id, 0, 0).s).toMatchObject({ group: false, bold: true });
      expect(wb.undoLabels()).toHaveLength(1);
      wb.undo();
      expect(wb.getDisplay(id, 0, 0)).toBe(grouped);
      wb.redo();
      expect(wb.getDisplay(id, 0, 0)).toBe(plain);
      wb.applyStyle(id, parseRange('A1'), { group: null, bold: false });
      expect(wb.getDisplay(id, 0, 0)).toBe(grouped);
      expect(wb.getCell(id, 0, 0).s).not.toHaveProperty('bold');
    } finally { modal.close(); modal.panel.closest('.modal-root')?.remove(); }
  });

  it('keeps plain negative numbers plain when changing decimal places in an imported custom format', async () => {
    const { openFormatCellsDialog } = await import('../src/ui/formatcells.js');
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '-12.5');
    wb.applyStyle(id, parseRange('A1'), { fmt: 'custom', code: '0.00;-0.00' });
    const ctx = fakeCtx(wb);
    const modal = openFormatCellsDialog(ctx);
    try {
      const decimals = modal.panel.querySelector('[aria-label="Decimal places"]');
      decimals.value = '1';
      decimals.dispatchEvent(new Event('input'));
      modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
      expect(ctx.runs[0][1].patch).toMatchObject({ fmt: 'number', dec: 1, code: null });
    } finally { modal.close(); modal.panel.closest('.modal-root')?.remove(); }
  });

  it('turns category choices into number-format patches', async () => {
    const { numberPatch } = await import('../src/ui/formatcells.js');
    expect(numberPatch({ category: 'general' })).toMatchObject({ fmt: null, dec: null });
    expect(numberPatch({ category: 'currency', dec: 0, group: true, cur: 'EUR' })).toMatchObject({ fmt: 'currency', dec: 0, cur: 'EUR', group: null });
    expect(numberPatch({ category: 'number', dec: 3, group: false })).toMatchObject({ fmt: 'number', dec: 3, group: false });
    expect(numberPatch({ category: 'date', dateStyle: 'long' })).toMatchObject({ fmt: 'date', dateStyle: 'long' });
    expect(numberPatch({ category: 'accounting' }).code).toContain('_(');
    expect(numberPatch({ category: 'custom', code: '0.0"x"' })).toMatchObject({ fmt: 'custom', code: '0.0"x"' });
  });

  it('applies only the fields that changed, as one applyFormat command', async () => {
    const { openFormatCellsDialog } = await import('../src/ui/formatcells.js');
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setInput(id, 0, 0, '1234.5');
    wb.applyStyle(id, parseRange('A1:A1'), { bold: true, fmt: 'number', dec: 2 });
    const ctx = fakeCtx(wb);
    const modal = openFormatCellsDialog(ctx);
    expect(document.body.textContent).toContain('Preview: 1,234.50');
    // Switch to percent with one decimal, italic on, an outline border.
    const category = [...document.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === 'Category');
    category.value = 'percent';
    category.dispatchEvent(new Event('change'));
    const dec = document.querySelector('input[aria-label="Decimal places"]');
    dec.value = '1';
    dec.dispatchEvent(new Event('input'));
    expect(document.body.textContent).toContain('Preview: 123,450.0%');
    const italic = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === 'Italic').querySelector('input');
    italic.click();
    [...document.querySelectorAll('[aria-label="Border presets"] button')].find((b) => b.textContent === 'Outline').click();
    document.querySelector('form.fc-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(ctx.runs).toHaveLength(1);
    const [cmd, arg] = ctx.runs[0];
    expect(cmd).toBe('applyFormat');
    expect(arg.patch).toMatchObject({ fmt: 'percent', dec: 1, italic: true });
    expect('bold' in arg.patch).toBe(false); // unchanged fields are left alone
    expect(arg.borders.map((b) => b.kind)).toEqual(['top', 'bottom', 'left', 'right']);
    expect(arg.borders[0]).toMatchObject({ style: 'thin', color: null });
    modal.close?.();
  });
});

describe('negative number styles', () => {
  it('builds the format code and reads it back', async () => {
    const { negativeCode, negativeStyleFor, numberPatch } = await import('../src/ui/formatcells.js');
    expect(negativeCode({ category: 'number', dec: 2, group: true, neg: 'red' })).toBe('#,##0.00;[Red]-#,##0.00');
    expect(negativeCode({ category: 'number', dec: 0, group: false, neg: 'paren' })).toBe('0;(0)');
    expect(negativeCode({ category: 'currency', dec: 2, group: true, cur: 'EUR', neg: 'redparen' })).toBe('"€"#,##0.00;[Red]("€"#,##0.00)');
    expect(negativeStyleFor('#,##0.00;[Red]-#,##0.00')).toEqual({ category: 'number', dec: 2, group: true, cur: 'USD', neg: 'red' });
    expect(negativeStyleFor('"€"#,##0.00;[Red]("€"#,##0.00)')).toEqual({ category: 'currency', dec: 2, group: true, cur: 'EUR', neg: 'redparen' });
    expect(negativeStyleFor('0;(0)')).toEqual({ category: 'number', dec: 0, group: false, cur: 'USD', neg: 'paren' });
    expect(negativeStyleFor('0.0%')).toBeNull();
    expect(negativeStyleFor('#,##0;[Red](0)')).toBeNull();
    const patch = numberPatch({ category: 'currency', dec: 2, group: true, cur: 'USD', neg: 'paren' });
    expect(patch).toMatchObject({ fmt: 'custom', code: '"$"#,##0.00;("$"#,##0.00)' });
    expect(numberPatch({ category: 'number', dec: 2, group: true, neg: 'minus' }).fmt).toBe('number');
  });
});
