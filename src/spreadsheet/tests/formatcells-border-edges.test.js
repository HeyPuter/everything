// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { borderSnapshot } from '../src/core/border-regions.js';
import { readBorderEdges } from '../src/ui/border-draft.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function open(ref = 'A1:B2', prepare = () => {}) {
  const wb = new Workbook(), id = wb.activeSheetId, range = parseRange(ref);
  wb.setInput(id, 0, 0, '3'); wb.setInput(id, 0, 1, '=A1*2');
  wb.setInput(id, 1, 0, '4'); wb.setInput(id, 1, 1, '=A2*2');
  prepare(wb, id, range); wb.clearHistory(); const before = wb.toJSON();
  const run = vi.fn((cmd, { patch, border, borders }) => {
    expect(cmd).toBe('applyFormat');
    wb.transaction('Format cells', () => {
      if (Object.keys(patch).length) wb.applyStyle(id, range, patch);
      for (const b of borders || (border ? [border] : [])) wb.applyBorders(id, range, b.kind, b);
    });
  });
  const modal = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }),
    range: () => range, style: () => wb.styleAt(id, 0, 0) || {}, grid: {}, run }, { panel: 'border' });
  const field = label => modal.panel.querySelector(`[aria-label="${label}"]`);
  const choose = (label, value) => { const node = field(label); node.value = value; node.dispatchEvent(new Event(node.type === 'color' ? 'input' : 'change', { bubbles: true })); };
  const preset = label => [...field('Border presets').querySelectorAll('button')].find(b => b.textContent === label);
  const apply = () => modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  return { wb, id, before, modal, run, field, choose, preset, apply };
}

it('keeps independent pens in the preview, repaints with a new pen, and removes with the same pen', () => {
  const { wb, before, field, choose, run, apply, id } = open();
  choose('Border color', '#ff0000'); field('Top border').click();
  choose('Line style', 'double'); choose('Border color', '#0000ff'); field('Bottom border').click();
  const preview = field('Border preview');
  expect(preview.style.borderTopStyle).toBe('solid'); expect(preview.style.borderTopColor).toBe('rgb(255, 0, 0)');
  expect(preview.style.borderBottomStyle).toBe('double'); expect(preview.style.borderBottomColor).toBe('rgb(0, 0, 255)');
  expect(wb.toJSON()).toEqual(before);
  field('Preview: Top border').click(); expect(preview.style.borderTopStyle).toBe('double');
  field('Top border').click(); expect(field('Top border').getAttribute('aria-pressed')).toBe('false');
  apply(); expect(run).toHaveBeenCalledOnce(); expect(wb.undoLabels()).toHaveLength(1);
  expect(borderSnapshot(wb.styleAt(id, 0, 0)).bt).toBe(false);
  expect(borderSnapshot(wb.styleAt(id, 1, 0))).toMatchObject({ bb: true, bbBorder: { bs: 'double', bc: '#0000ff' } });
  expect(wb.getValue(id, 1, 1)).toBe(8); wb.undo(); expect(wb.toJSON()).toEqual(before);
});

it('combines Outline and Inside without clearing unrelated formatting, then None clears only borders', () => {
  const { wb, id, before, preset, apply, choose, field } = open('A1:B2', (w, s, rg) => w.applyStyle(s, rg, { bold: true, bg: '#ddeeff' }));
  choose('Line style', 'dotted'); choose('Border color', '#123456'); preset('Outline').click();
  choose('Line style', 'double'); preset('Inside').click();
  expect(field('Border preview').style.getPropertyValue('--preview-horizontal')).toContain('double');
  expect(field('Border preview').style.borderTopStyle).toBe('dotted');
  apply();
  expect(borderSnapshot(wb.styleAt(id, 0, 0))).toMatchObject({ btBorder: { bs: 'dotted', bc: '#123456' }, bbBorder: { bs: 'double', bc: '#123456' } });
  expect(wb.styleAt(id, 0, 0)).toMatchObject({ bold: true, bg: '#ddeeff' });
  wb.undo(); expect(wb.toJSON()).toEqual(before);
  const clear = open('A1:B2', (w, s, rg) => { w.applyStyle(s, rg, { bold: true }); w.applyBorders(s, rg, 'all'); });
  clear.preset('None').click(); clear.apply();
  expect(borderSnapshot(clear.wb.styleAt(clear.id, 0, 0))).toMatchObject({ bt: false, bb: false, bl: false, br: false });
  expect(clear.wb.styleAt(clear.id, 0, 0).bold).toBe(true);
});

it('retains existing mixed pens when editing a different edge', () => {
  const { wb, id, field, choose, apply } = open('A1:B2', (w, s) => {
    w.applyStyle(s, parseRange('A1'), { bl: true, blBorder: { bs: 'dotted', bc: '#ff0000' } });
    w.applyStyle(s, parseRange('A2'), { bl: true, blBorder: { bs: 'double', bc: '#0000ff' } });
  });
  expect(field('Left border').getAttribute('aria-pressed')).toBe('mixed');
  choose('Line style', 'thick'); field('Right border').click(); apply();
  expect(borderSnapshot(wb.styleAt(id, 0, 0)).blBorder).toEqual({ bs: 'dotted', bc: '#ff0000' });
  expect(borderSnapshot(wb.styleAt(id, 1, 0)).blBorder).toEqual({ bs: 'double', bc: '#0000ff' });
});

it('previews the existing range perimeter and inside pens without applying an edit', () => {
  const { field, wb, before, apply, run } = open('A1:B2', (w, s, rg) => {
    w.applyBorders(s, rg, 'top', { perSide: true, style: 'thin', color: '#ff0000' });
    w.applyBorders(s, rg, 'bottom', { perSide: true, style: 'double', color: '#0000ff' });
    w.applyBorders(s, rg, 'vertical', { perSide: true, style: 'dotted', color: '#123456' });
  });
  const preview = field('Border preview');
  expect(preview.style.borderTopColor).toBe('rgb(255, 0, 0)');
  expect(preview.style.borderBottomStyle).toBe('double');
  expect(preview.style.borderBottomColor).toBe('rgb(0, 0, 255)');
  expect(preview.classList.contains('fc-preview-inside-cols')).toBe(true);
  expect(preview.classList.contains('fc-preview-inside-rows')).toBe(false);
  expect(preview.style.getPropertyValue('--preview-vertical')).toContain('#123456');
  apply(); expect(run).not.toHaveBeenCalled(); expect(wb.toJSON()).toEqual(before);
});

it.each([['A1', true, true], ['A1:B1', true, false], ['A1:A2', false, true]])
  ('disables unavailable inside edges for %s and clearly disables diagonal borders', (ref, horizontal, vertical) => {
    const { field, modal, preset } = open(ref);
    expect(field('Inside horizontal border').disabled).toBe(horizontal);
    expect(field('Inside vertical border').disabled).toBe(vertical);
    expect(preset('Inside').disabled).toBe(horizontal && vertical);
    const diagonal = [...modal.panel.querySelectorAll('button')].filter(b => b.getAttribute('aria-label')?.startsWith('Diagonal'));
    expect(diagonal).toHaveLength(2); expect(diagonal.every(b => b.disabled && b.title.includes('not supported'))).toBe(true);
  });

it('cancels edge drafts and ignores pen-only edits when no edge or preset was selected', () => {
  const { wb, before, field, modal, run } = open();
  field('Bottom border').click(); modal.close(); expect(run).not.toHaveBeenCalled(); expect(wb.toJSON()).toEqual(before);
  const untouched = open(); untouched.choose('Line style', 'double'); untouched.apply();
  expect(untouched.run).not.toHaveBeenCalled(); expect(untouched.wb.toJSON()).toEqual(untouched.before);
});

it('applies a preset with the pen chosen when it is clicked, and leaves edges alone without a click', () => {
  const normal = open(); normal.choose('Line style', 'dashed'); normal.preset('Outline').click(); normal.apply();
  expect(normal.run).toHaveBeenCalledWith('applyFormat', { patch: {}, border: null, borders: ['top', 'bottom', 'left', 'right'].map(kind => ({ kind, style: 'dashed', color: null, perSide: true })) });
  const untouched = open(); untouched.choose('Line style', 'double'); untouched.apply();
  expect(untouched.run).not.toHaveBeenCalled(); expect(untouched.wb.toJSON()).toEqual(untouched.before);
});

it('draws the line styles as a single-choice group walked with the arrow keys', () => {
  const { field, preset, apply, run } = open();
  const group = field('Line style');
  expect(group.getAttribute('role')).toBe('radiogroup');
  const radios = [...group.querySelectorAll('[role="radio"]')];
  expect(radios.map(r => r.dataset.value)).toEqual(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double']);
  expect(radios.every(r => r.querySelector('svg'))).toBe(true);
  expect(radios.filter(r => r.tabIndex === 0)).toHaveLength(1);
  radios[0].focus();
  radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  expect(group.value).toBe('medium'); expect(document.activeElement).toBe(radios[1]);
  group.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  expect(group.value).toBe('double'); expect(radios[5].getAttribute('aria-checked')).toBe('true');
  radios[2].click(); expect(group.value).toBe('thick');
  preset('Inside').click(); apply();
  expect(run.mock.calls[0][1].borders).toEqual([{ kind: 'horizontal', style: 'thick', color: null, perSide: true }, { kind: 'vertical', style: 'thick', color: null, perSide: true }]);
});

it('draws a sample per cell of the selection shape and puts every edge button beside the diagram', () => {
  const { field, modal } = open('A1:B2');
  expect(field('Border preview').querySelectorAll('.fc-border-sample')).toHaveLength(4);
  for (const label of ['Top', 'Bottom', 'Left', 'Right', 'Inside horizontal', 'Inside vertical']) {
    const button = field(`${label} border`);
    expect(button.closest('.fc-diagram')).not.toBeNull(); expect(button.querySelector('svg')).not.toBeNull();
  }
  expect(modal.panel.querySelector('[aria-label="Borders"]')).toBeNull();
  expect(open('A1').field('Border preview').querySelectorAll('.fc-border-sample')).toHaveLength(1);
  expect(open('A1:C1').field('Border preview').querySelectorAll('.fc-border-sample')).toHaveLength(2);
});

it('bounds inspection of a million-row selection and leaves unknown edges mixed', () => {
  const styleAt = vi.fn(() => ({}));
  const edges = readBorderEdges({ styleAt }, 'sheet', { r1: 0, r2: 1048575, c1: 0, c2: 2 });
  expect(styleAt.mock.calls.length).toBeLessThan(20);
  expect(edges.get('left').on).toBe('mixed'); expect(edges.get('horizontal').on).toBe('mixed');
});

it('disables nonexistent line caps and inside edges of one merged cell', () => {
  const wb = new Workbook(), id = wb.activeSheetId, range = parseRange('A1:B2');
  const columns = readBorderEdges(wb, id, { ...range, scope: 'columns' });
  expect(columns.get('top').disabled).toBe(true); expect(columns.get('bottom').disabled).toBe(true);
  expect(columns.get('left').disabled).toBe(false);
  const rows = readBorderEdges(wb, id, { ...range, scope: 'rows' });
  expect(rows.get('left').disabled).toBe(true); expect(rows.get('right').disabled).toBe(true);
  wb.sheet(id).merges.push(range);
  const merged = readBorderEdges(wb, id, range);
  expect(merged.get('horizontal').disabled).toBe(true); expect(merged.get('vertical').disabled).toBe(true);
});
