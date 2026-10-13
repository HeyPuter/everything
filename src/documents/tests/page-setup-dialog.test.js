// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, describe } from 'vitest';
import { openPageSetup, multiplePagesOf, multiplePagesSettings } from '../src/views/page-setup.js';
import { openColumns, presetColumns, columnPreset, columnEntries } from '../src/views/columns-dialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { DEFAULT_PAGE_SETTINGS, validatePageSettings } from '../src/engine/page-settings.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} })); });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const field = label => document.querySelector(`[aria-label="${label}"]`);
const set = (label, value) => { const node = field(label); node.value = value; node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
const submit = () => document.querySelector('form').requestSubmit();

describe('Page Setup dialog', () => {
  it('applies only the settings that changed, in the chosen scope', () => {
    const apply = vi.fn(() => true);
    openPageSetup(DEFAULT_PAGE_SETTINGS, apply, { unit: 'in', scopes: [['document', 'Whole document'], ['section', 'This section']], scope: 'section' });
    set('Top margin (in)', '2');
    set('Vertical alignment', 'center');
    submit();
    expect(apply).toHaveBeenCalledWith({ top: 2880, verticalAlignment: 'center' }, { scope: 'section', stories: null });
  });
  it('closes without a change when nothing was edited, keeping imported measurements exact', () => {
    const apply = vi.fn(() => true);
    openPageSetup(validatePageSettings({ ...DEFAULT_PAGE_SETTINGS, left: 1441, width: 12241 }), apply, { unit: 'cm' });
    expect(field('Left margin (cm)').value).toBe('2.542');
    submit();
    expect(apply).not.toHaveBeenCalled();
  });
  it('names inside and outside margins for facing pages and turns the sheet for a booklet', () => {
    const apply = vi.fn(() => true);
    openPageSetup(DEFAULT_PAGE_SETTINGS, apply, { unit: 'in' });
    set('Multiple pages', 'mirror');
    expect(field('Inside margin (in)')).not.toBeNull();
    expect(field('Gutter position').disabled).toBe(true);
    set('Multiple pages', 'bookFold');
    expect(field('Page orientation').value).toBe('landscape');
    submit();
    expect(apply.mock.calls[0][0]).toMatchObject({ orientation: 'landscape', width: 15840, height: 12240, bookFoldPrinting: true });
  });
  it('reports settings that leave no room to write and keeps the dialog open', () => {
    const apply = vi.fn(() => true);
    openPageSetup(DEFAULT_PAGE_SETTINGS, apply, { unit: 'in' });
    set('Left margin (in)', '20');
    submit();
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]').textContent).toContain('writing space');
  });
  it('passes header and footer options and section start, and stores defaults', () => {
    const apply = vi.fn(() => true), setDefault = vi.fn();
    openPageSetup(DEFAULT_PAGE_SETTINGS, apply, { unit: 'in', stories: { firstPageDifferent: false, evenAndOdd: true }, setDefault });
    const checks = [...document.querySelectorAll('input[type="checkbox"]')];
    checks.find(c => c.parentElement.textContent.includes('first page')).click();
    set('Section start', 'oddPage');
    [...document.querySelectorAll('button')].find(b => b.textContent === 'Set As Default').click();
    expect(setDefault).toHaveBeenCalledWith(expect.objectContaining({ sectionType: 'oddPage' }));
    submit();
    expect(apply).toHaveBeenCalledWith({ sectionType: 'oddPage' }, { scope: 'document', stories: { firstPageDifferent: true } });
  });
  it('maps page arrangements to their settings and back', () => {
    for (const mode of ['normal', 'mirror', 'twoOnOne', 'bookFold', 'reverseBookFold']) expect(multiplePagesOf(multiplePagesSettings(mode))).toBe(mode);
  });
});

describe('Columns dialog', () => {
  const available = 9360;
  it('describes presets and recognizes them', () => {
    expect(presetColumns('one', available)).toBeNull();
    expect(columnPreset(presetColumns('two', available))).toBe('two');
    const left = presetColumns('left', available);
    expect(left.entries.map(e => e.width)).toEqual([2880, 5760]);
    expect(columnPreset(left)).toBe('left');
    expect(columnPreset(presetColumns('right', available))).toBe('right');
    expect(columnEntries({ count: 3, space: 720, equalWidth: true }, available).map(e => e.width)).toEqual([2640, 2640, 2640]);
  });
  it('applies equal columns with a line between and where chosen', () => {
    const apply = vi.fn(() => true);
    openColumns({ columns: null, available, unit: 'in', scopes: [['document', 'Whole document'], ['forward', 'This point forward']], apply });
    [...document.querySelectorAll('.ps-preset')].find(b => b.textContent === 'Three').click();
    field('Line between')?.click?.();
    document.querySelector('.ps-columns-options input[type="checkbox"]').click();
    set('Apply to', 'forward');
    submit();
    expect(apply).toHaveBeenCalledWith({ count: 3, space: 720, equalWidth: true, separator: true, entries: [] }, 'forward');
  });
  it('keeps unequal columns filling the width and refuses columns too narrow to write in', () => {
    const apply = vi.fn(() => true);
    openColumns({ columns: presetColumns('left', available), available, unit: 'in', apply });
    const first = field('Width of column 1 (in)');
    first.value = '3'; first.dispatchEvent(new Event('change', { bubbles: true }));
    expect(field('Width of column 2 (in)').value).toBe('3');
    const count = field('Number of columns');
    count.value = '12'; count.dispatchEvent(new Event('change', { bubbles: true }));
    submit();
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]').hidden).toBe(false);
  });
});
