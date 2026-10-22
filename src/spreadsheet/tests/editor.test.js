// @vitest-environment jsdom
import { stampClipboardHtml } from './helpers/clipboard.js';
import { contentSnapshot } from './helpers/content-snapshot.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as notifications from '../src/ui/toast.js';
import * as P from '../src/lib/puter.js';
import * as IO from '../src/core/io.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  view?.destroy();
  view = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup({ recoverable = null } = {}) {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  doc.recoverable = recoverable;
  const goHome = vi.fn();
  const openPath = vi.fn();
  view = editorView({ doc, goHome, openPath, newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  return { doc, goHome, openPath };
}

async function retryStop(editor) {
  const panels = [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')];
  expect(panels).toHaveLength(1);
  expect(panels[0].getAttribute('aria-label')).toBe('Check this value');
  expect([...panels[0].querySelectorAll('button')].map(b => b.textContent)).toEqual(['', 'Cancel', 'Retry']);
  const retry = panels[0].querySelector('.btn-primary');
  expect(document.activeElement).toBe(retry);
  retry.click(); await Promise.resolve();
  expect(document.querySelector('.modal-root:not(.closing)')).toBeNull();
  expect(document.activeElement).toBe(editor);
}

it('shows a titled Stop alert without a duplicate toast and cancels the draft without writing', async () => {
  const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Good');
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: ['Good'], errorTitle: 'Category', message: 'Choose a listed category.' });
  wb.clearHistory(); await vi.advanceTimersByTimeAsync(1);
  const before = wb.toJSON(), version = wb.version, notify = vi.spyOn(notifications, 'toast');
  view.el.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const panel = document.querySelector('.modal-root:not(.closing) .modal-panel');
  expect(panel.getAttribute('aria-label')).toBe('Category'); expect(panel.querySelector('.modal-text').textContent).toBe('Choose a listed category.');
  expect(notify).not.toHaveBeenCalled();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await Promise.resolve();
  expect(editor.hidden).toBe(true); expect(wb.toJSON()).toEqual(before); expect(wb.version).toBe(version); expect(wb.canUndo()).toBe(false);
});

it('copies the saved selection on open and pastes external text into its saved active cell', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Selection', viewSelection: {
    active: { r: 3, c: 2 }, ranges: [{ r1: 2, c1: 1, r2: 3, c2: 2 }], activeRange: 0,
  }, cells: { '2,1': { v: 'Item' }, '2,2': { v: 17 }, '3,1': { v: 'Total' }, '3,2': { f: 'C3*2' } } }] });
  const doc = new Doc({ wb, name: 'Selection' });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  const viewport = view.el.querySelector('[role="grid"]');
  viewport.focus();
  let text = '';
  const copy = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { setData(type, value) { if (type === 'text/plain') text = value; } } });
  viewport.dispatchEvent(copy);
  expect(text).toBe('Item\t17\nTotal\t34');
  // A new editor has no internal clipboard, so plain text follows the external workflow.
  view.destroy();
  wb.setSheetSelection(wb.activeSheetId, { active: { r: 5, c: 4 }, ranges: [{ r1: 5, c1: 4, r2: 5, c2: 4 }] });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').replaceChildren(view.el);
  const target = view.el.querySelector('[role="grid"]'); target.focus();
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: type => type === 'text/plain' ? '23\tReady' : '', files: [] } });
  target.dispatchEvent(paste);
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(wb.activeSheetId, 5, 4)).toBe(23);
  expect(wb.getValue(wb.activeSheetId, 5, 5)).toBe('Ready');
  expect(wb.getValue(wb.activeSheetId, 3, 2)).toBe(34);
  doc.destroy();
});

it.each(['0:1', 'XFE1', 'A1048577'])('rejects invalid IMPORTRANGE reference %s before reading a file and allows correction', async (range) => {
  const read = vi.spyOn(P, 'readFile').mockResolvedValue(new TextEncoder().encode('42'));
  const { doc } = setup();
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, `=IMPORTRANGE("Source.csv","${range}")`);
  wb.getValue(id, 0, 0);
  await vi.advanceTimersByTimeAsync(20);
  expect(wb.getValue(id, 0, 0)).toEqual({ error: '#REF!' });
  expect(read).not.toHaveBeenCalled();
  wb.setInput(id, 0, 0, '=IMPORTRANGE("Source.csv","A1")');
  wb.getValue(id, 0, 0);
  await vi.advanceTimersByTimeAsync(20);
  expect(wb.getValue(id, 0, 0)).toBe(42);
  expect(read).toHaveBeenCalledOnce();
});

it('imports a CSV by its local filename and reuses it through its explicit path', async () => {
  const path = `${P.FOLDER}/Quarter 1.csv`;
  const read = vi.spyOn(P, 'readFile').mockImplementation(async (requested) => {
    if (requested !== path) throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
    return new TextEncoder().encode('Name,Amount\nSales,42\n');
  });
  const { doc } = setup();
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=IMPORTRANGE("Quarter 1.csv","A1:B2")');
  expect(wb.getValue(id, 0, 0)).toEqual({ error: '#BUSY!' });
  await vi.advanceTimersByTimeAsync(20);
  expect(read).toHaveBeenCalledWith(path);
  expect(wb.rangeValues(id, { r1: 0, c1: 0, r2: 1, c2: 1 })).toEqual([['Name', 'Amount'], ['Sales', 42]]);
  wb.setInput(id, 0, 3, `=IMPORTRANGE("${path}","B2")`);
  wb.getValue(id, 0, 3);
  await vi.advanceTimersByTimeAsync(20);
  expect(wb.getValue(id, 0, 3)).toBe(42);
  expect(read).toHaveBeenCalledOnce();
});

it.each(['number', 'currency', 'percent', 'scientific'].flatMap((fmt) =>
  [['More decimal places', 16], ['Fewer decimal places', 14]].map(([label, expected]) => ({ fmt, label, expected })),
))('adjusts $fmt precision by one using $label above ten decimal places', async ({ fmt, label, expected }) => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 0.125, s: { fmt, dec: 15, cur: 'CAD', bold: true } } }]);
  wb.clearHistory();
  await vi.advanceTimersByTimeAsync(1);
  view.el.querySelector(`[aria-label="${label}"]`).click();
  expect(wb.getCell(id, 0, 0).s).toMatchObject({ fmt, dec: expected, cur: 'CAD', bold: true });
  expect(wb.getValue(id, 0, 0)).toBe(0.125);
  wb.undo();
  expect(wb.getCell(id, 0, 0).s.dec).toBe(15);
  wb.redo();
  expect(wb.getCell(id, 0, 0).s.dec).toBe(expected);
});

it.each([[0, 'Fewer decimal places'], [20, 'More decimal places']])('keeps the %i-place precision boundary when using %s', async (dec, label) => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 0.125, s: { fmt: 'number', dec } } }]);
  wb.clearHistory();
  await vi.advanceTimersByTimeAsync(1);
  view.el.querySelector(`[aria-label="${label}"]`).click();
  expect(wb.getCell(id, 0, 0).s.dec).toBe(dec);
  expect(wb.undoLabels()).toHaveLength(0);
});

it.each([
  ['insert', 'Checkbox', 'validations', 'Checkbox inserted.'],
  ['format', 'Alternating colors', 'rules', 'Alternating colors added.'],
])('reports a blocked %s → %s action accurately and allows retry', async (menu, label, collection, success) => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setSheetProtected(id, true);
  await vi.advanceTimersByTimeAsync(1);
  const notify = vi.spyOn(notifications, 'toast');
  const act = () => {
    view.el.querySelector(`[data-menu="${menu}"]`).click();
    [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label).click();
  };
  const before = contentSnapshot(wb);
  act();
  await vi.advanceTimersByTimeAsync(1);
  expect(contentSnapshot(wb)).toEqual(before);
  expect(notify.mock.calls.some(([message]) => message.startsWith(success))).toBe(false);
  expect(notify.mock.calls.some(([message]) => /protected/i.test(message))).toBe(true);
  wb.setSheetProtected(id, false);
  act();
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.sheet(id)[collection]).toHaveLength(1);
  expect(notify.mock.calls.some(([message]) => message.startsWith(success))).toBe(true);
  if (label === 'Checkbox') expect(wb.getValue(id, 0, 0)).toBe(false);
  wb.undo();
  expect(wb.sheet(id)[collection]).toHaveLength(0);
  expect(wb.getValue(id, 0, 0)).toBeNull();
});

it('keeps the selection and formatting intact when a protected range blocks merging', async () => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Heading');
  wb.setInput(id, 0, 1, 'Protected');
  wb.protectRange(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, 'Keep this cell');
  const name = view.el.querySelector('[aria-label="Cell reference"]');
  name.value = 'A1:B1';
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const before = contentSnapshot(wb);
  const button = view.el.querySelector('.tb-btn[data-cmd="merge"]');
  expect(button.disabled).toBe(false);
  button.click();
  await vi.advanceTimersByTimeAsync(1);
  expect(contentSnapshot(wb)).toEqual(before);
  expect(name.value).toBe('A1:B1');
});

it('fits the full row selection beyond 2,001 rows in one undo step', async () => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 2200, 0, 'First\nSecond');
  wb.applyStyle(id, { r1: 2200, c1: 0, r2: 2200, c2: 0 }, { wrap: true });
  wb.setInput(id, 2499, 0, 'Last selected row');
  wb.setRowHeight(id, 2200, 100);
  wb.setRowHeight(id, 2199, 90);
  wb.setRowHeight(id, 2500, 80);
  const name = view.el.querySelector('[aria-label="Cell reference"]');
  name.value = 'A1:A2500';
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  wb.clearHistory();
  view.el.querySelector('[data-menu="format"]').click();
  const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
  item('Rows and columns').click();
  item('Fit rows to content').click();
  expect(wb.rowHeight(id, 2200)).toBe(37);
  expect(wb.rowHeight(id, 2199)).toBe(DEFAULT_ROW_HEIGHT); // an empty row fits back to the default
  expect(wb.rowHeight(id, 2500)).toBe(80);
  wb.undo();
  expect(wb.rowHeight(id, 2200)).toBe(100);
  expect(wb.rowHeight(id, 2199)).toBe(90);
  wb.redo();
  expect(wb.rowHeight(id, 2200)).toBe(37);
  expect(wb.rowHeight(id, 2199)).toBe(DEFAULT_ROW_HEIGHT); // an empty row fits back to the default
});

describe('leaving the editor', () => {
  it.each([true, false])('checks edits started while navigation is waiting for a save (valid=%s)', async (valid) => {
    const { doc, goHome } = setup();
    await vi.advanceTimersByTimeAsync(1);
    const wb = doc.wb;
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Original');
    wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: 'Original,Allowed', strict: true });
    let release;
    const savedValues = [];
    const save = vi.spyOn(doc, 'save').mockImplementationOnce(async () => {
      savedValues.push(wb.getValue(id, 0, 0));
      await new Promise((resolve) => { release = resolve; });
      wb.markClean();
      return true;
    }).mockImplementation(async () => {
      savedValues.push(wb.getValue(id, 0, 0));
      wb.markClean();
      return true;
    });
    view.el.querySelector('[aria-label="Back to all spreadsheets"]').click();
    expect(save).toHaveBeenCalledOnce();
    view.el.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
    const input = view.el.querySelector('.grid-editor');
    input.value = valid ? 'Allowed' : 'Invalid';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    release();
    await vi.advanceTimersByTimeAsync(1);
    if (valid) {
      expect(savedValues).toEqual(['Original', 'Allowed']);
      expect(wb.getValue(id, 0, 0)).toBe('Allowed');
      expect(goHome).toHaveBeenCalledOnce();
    } else {
      expect(goHome).not.toHaveBeenCalled();
      expect(savedValues).toEqual(['Original']);
      expect(input.value).toBe('Invalid');
      await retryStop(input);
      expect(document.activeElement).toBe(input);
      expect(wb.getValue(id, 0, 0)).toBe('Original');
    }
  });

  it('waits for a pending version restore and saves its result before leaving a clean editor', async () => {
    const { doc } = setup();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    vi.spyOn(doc, '_restoreVersion').mockImplementation(async () => {
      await waiting;
      doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Restored contents');
      return true;
    });
    const write = vi.spyOn(doc, '_doSave').mockImplementation(async () => {
      doc.wb.markClean();
      doc._setStatus('saved');
      return true;
    });
    const restoring = doc.restoreVersion('version.xlsx');
    let finished = false;
    const flushing = view.flush().then((result) => { finished = true; return result; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(false);
      release();
      expect(await flushing).toBe(true);
      expect(write).toHaveBeenCalledOnce();
      expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('Restored contents');
      expect(doc.wb.dirty).toBe(false);
    } finally { release(); await restoring; await flushing; }
  });

  it('warns before closing the tab while a version operation is pending', async () => {
    const { doc } = setup();
    let release;
    vi.spyOn(doc, '_restoreVersion').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const restoring = doc.restoreVersion('version.xlsx');
    const event = new Event('beforeunload', { cancelable: true });
    try {
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    } finally { release(true); await restoring; await doc._saving; }
  });

  it('keeps the document open when saving fails', async () => {
    const { doc, goHome } = setup();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Unsaved work');
    vi.spyOn(doc, 'save').mockRejectedValue(new Error('Offline'));
    view.el.querySelector('[aria-label="Back to all spreadsheets"]').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(goHome).not.toHaveBeenCalled();
    expect(doc.wb.dirty).toBe(true);
  });

  it('commits an edit before flushing the document for navigation', async () => {
    const { doc } = setup();
    const viewport = view.el.querySelector('[role="grid"]');
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
    const save = vi.spyOn(doc, 'save').mockImplementation(async () => { doc.wb.markClean(); return true; });
    await view.flush();
    expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('x');
    expect(save).toHaveBeenCalled();
  });

  it('finishes saving edits made during an earlier write before leaving', async () => {
    const { doc, goHome } = setup();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Latest edit');
    const save = vi.spyOn(doc, 'save').mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => { doc.wb.markClean(); return true; });
    view.el.querySelector('[aria-label="Back to all spreadsheets"]').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(goHome).toHaveBeenCalledOnce();
    expect(doc.wb.dirty).toBe(false);
  });

  it('writes a local draft immediately when the tab is closing', () => {
    const { doc } = setup();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Last edit');
    const draft = vi.spyOn(doc, 'writeDraft').mockReturnValue(true);
    vi.spyOn(doc, 'save').mockResolvedValue(false);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(draft).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('registers the editor save with the sign-out operation', async () => {
    const { doc } = setup();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Before sign-out');
    vi.spyOn(doc, 'save').mockResolvedValue(false);
    const pending = [];
    window.dispatchEvent(new CustomEvent('app:before-signout', { detail: { waitUntil: (p) => pending.push(p) } }));
    expect(pending).toHaveLength(1);
    expect(await pending[0]).toBe(false);
  });
});

describe('save conflicts', () => {
  it.each(['conflict', 'new edits', 'complete'])('reports Saved only when a manual save is complete (%s)', async (outcome) => {
    const { doc } = setup();
    const notify = vi.spyOn(notifications, 'toast');
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Local edit');
    const save = vi.spyOn(doc, 'save').mockImplementation(async () => {
      if (outcome === 'complete') doc.wb.markClean();
      return outcome !== 'conflict';
    });
    const grid = view.el.querySelector('[role="grid"]');
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    const saved = notify.mock.calls.some(([message]) => message === 'Saved');
    expect(saved).toBe(outcome === 'complete');
  });

  it.each(['Escape', 'Close'])('keeps local edits when the conflict dialog is dismissed with %s', async (action) => {
    const { doc, openPath } = setup();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Local edit');
    const destroy = vi.spyOn(doc, 'destroy');
    doc.dispatchEvent(new CustomEvent('conflict'));
    if (action === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else document.querySelector('.modal-panel [aria-label="Close"]').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(doc.wb.dirty).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('requests a fresh copy of the current file only when Reload theirs is chosen', async () => {
    const { doc, openPath } = setup();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Local edit');
    doc.dispatchEvent(new CustomEvent('conflict'));
    [...document.querySelectorAll('.modal-panel button')].find((b) => b.textContent === 'Reload theirs').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(openPath).toHaveBeenCalledWith(doc.path, { reload: true });
  });
});

describe('insert link dialog', () => {
  it('does not create a workbook name after a refused local-name jump', () => {
    const { doc } = setup(), wb = doc.wb;
    wb.defineName('LocalFar', 'Sheet1!A20001', 'Sheet1'); const names = structuredClone(wb.names);
    const box = view.el.querySelector('.name-box'); box.value = 'LocalFar';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(wb.names).toEqual(names);
  });

  it('goes to any typed address on the full grid, as far as XFD1048576', async () => {
    const { doc } = setup(); const toast = vi.spyOn(notifications, 'toast');
    const box = view.el.querySelector('.name-box');
    for (const address of ['A20001', 'K250000', 'XFD1048576']) {
      box.value = address;
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
      expect(view.el.querySelector('.name-box').value).toBe(address);
    }
    expect(toast).not.toHaveBeenCalledWith('That range is beyond this sheet’s available size', expect.anything());
    expect(doc.wb.sheets[0].rows).toBe(1048576); expect(doc.wb.sheets[0].cols).toBe(16384);
  });

  it.each(['link', 'named link', 'name box', 'qualified name box'])(
    'grows the destination sheet before selecting a far range through %s', async (mode) => {
      const { doc } = setup(), wb = doc.wb;
      const sourceId = wb.activeSheetId, target = wb.addSheet('Two');
      wb.defineName('Far', 'Two!$A$500:$AB$510');
      wb.setActiveSheet(sourceId); await vi.advanceTimersByTimeAsync(1);
      if (mode === 'link') expect(view.goTo('Two!A500:AB510')).toBe(true);
      else if (mode === 'named link') expect(view.goTo('Far')).toBe(true);
      else {
        const box = view.el.querySelector('.name-box');
        box.value = mode === 'name box' ? 'Far' : 'Two!A500:AB510';
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(wb.activeSheetId).toBe(target.id);
      expect(target.rows).toBeGreaterThanOrEqual(510); expect(target.cols).toBeGreaterThanOrEqual(28);
      expect(view.el.querySelector('.name-box').value).toBe('Far');
      expect(view.el.querySelector('[role="grid"]').getAttribute('aria-activedescendant')).toBe('gc-499-0');
    },
  );

  it.each(['link', 'named link', 'qualified name box'])(
    'refuses an unavailable destination through %s without switching sheets or partially growing it', async (mode) => {
      const { doc } = setup(), wb = doc.wb, sourceId = wb.activeSheetId;
      const target = wb.addSheet('Two'); wb.defineName('TooFar', 'Two!A20001');
      wb.setActiveSheet(sourceId); wb.setSheetHidden(target.id, true); await vi.advanceTimersByTimeAsync(1);
      const size = [target.rows, target.cols];
      if (mode === 'link') expect(view.goTo('Two!A20001')).toBe(false);
      else if (mode === 'named link') expect(view.goTo('TooFar')).toBe(false);
      else {
        const box = view.el.querySelector('.name-box'); box.value = 'Two!A20001';
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(wb.activeSheetId).toBe(sourceId); expect(target.hidden).toBe(true);
      expect([target.rows, target.cols]).toEqual(size);
    },
  );

  it('selects a range exactly at the edges of the grid', async () => {
    const { doc } = setup(), wb = doc.wb;
    expect(view.goTo('A1048576:XFD1048576')).toBe(true); await vi.advanceTimersByTimeAsync(1);
    expect(view.el.querySelector('.name-box').value).toBe('1048576:1048576');
    expect(wb.sheets[0].rows).toBe(1048576); // the whole last row: its row comes into view, its columns are all there
  });

  it('navigates within an imported sheet larger than the interactive growth limits', async () => {
    const { doc } = setup(), wb = doc.wb;
    wb.replaceWith({ sheets: [{ name: 'Large', rows: 21000, cols: 800 }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(view.goTo('AAA20001:AAB20002')).toBe(true); await vi.advanceTimersByTimeAsync(1);
    expect(view.el.querySelector('.name-box').value).toBe('AAA20001:AAB20002');
    expect(wb.sheets[0].rows).toBe(21000); expect(wb.sheets[0].cols).toBe(800);
  });

  it.each(['XFE1', 'A1048577', 'A1:XFE2', 'B1048577:A1'])(
    'keeps the current link and allows correction after invalid destination %s', async (address) => {
      const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
      wb.setLink(id, 0, 0, '#Sheet1!B2', 'Place');
      view.el.querySelector('[aria-label="Insert link"]').click();
      const range = document.querySelector('input[aria-label="Cell or range"]');
      range.value = address; range.closest('form').requestSubmit();
      expect(wb.linkAt(id, 0, 0)).toEqual({ url: '#Sheet1!B2', label: 'Place' });
      expect(document.activeElement).toBe(range);
      range.value = 'C3:D4'; range.closest('form').requestSubmit(); await vi.advanceTimersByTimeAsync(1);
      expect(wb.linkAt(id, 0, 0).url).toBe('#Sheet1!C3:D4');
      wb.undo(); expect(wb.linkAt(id, 0, 0).url).toBe('#Sheet1!B2');
    },
  );

  it('does not create a new link with an out-of-bounds endpoint', () => {
    const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
    view.el.querySelector('[aria-label="Insert link"]').click();
    const kind = document.querySelector('[aria-label="Link to"]');
    kind.value = `sheet:${id}`; kind.dispatchEvent(new Event('change'));
    const range = document.querySelector('input[aria-label="Cell or range"]');
    range.value = 'A1048577'; range.closest('form').requestSubmit();
    expect(wb.linkAt(id, 0, 0)).toBeNull();
    expect(document.activeElement).toBe(range);
  });

  it.each(['#Sheet1!B2#', "#'Sheet1'!$B$2#", "#Sheet1:'Two Data'!B2:C3", "#'Sheet1:Two Data'!B2:C3"])(
    'preserves special reference %s when only its label changes', async (url) => {
      const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
      wb.addSheet('Two Data'); wb.setActiveSheet(id); await vi.advanceTimersByTimeAsync(1);
      wb.setInput(id, 1, 1, '=SEQUENCE(3,2)'); wb.setLink(id, 0, 0, url, 'Old');
      view.el.querySelector('[aria-label="Insert link"]').click();
      const text = document.querySelector('input[aria-label="Text"]'); text.value = 'New';
      text.closest('form').requestSubmit(); await vi.advanceTimersByTimeAsync(1);
      expect(wb.linkAt(id, 0, 0)).toEqual({ url, label: 'New' });
      wb.undo(); expect(wb.linkAt(id, 0, 0)).toEqual({ url, label: 'Old' });
    },
  );

  it('shows and edits a spill address in the sheet destination controls', async () => {
    const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 1, 1, '=SEQUENCE(3,2)'); wb.setInput(id, 5, 3, '=SEQUENCE(2,3)');
    wb.setLink(id, 0, 0, '#Sheet1!B2#', 'Results');
    view.el.querySelector('[aria-label="Insert link"]').click();
    expect(document.querySelector('[aria-label="Link to"]').value).toBe(`sheet:${id}`);
    const range = document.querySelector('input[aria-label="Cell or range"]');
    expect(range.value).toBe('B2#');
    range.value = 'D6#'; range.closest('form').requestSubmit(); await vi.advanceTimersByTimeAsync(1);
    expect(wb.linkAt(id, 0, 0).url).toBe('#Sheet1!D6#');
    expect(wb.resolveLink(wb.linkAt(id, 0, 0).url)?.range).toEqual({ r1: 5, c1: 3, r2: 6, c2: 5 });
  });

  it.each(['B2:C3#', 'XFE1#', 'B2##'])('rejects invalid spill address %s without replacing the link', (address) => {
    const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
    wb.setLink(id, 0, 0, '#Sheet1!B2#', 'Results');
    view.el.querySelector('[aria-label="Insert link"]').click();
    const range = document.querySelector('input[aria-label="Cell or range"]');
    range.value = address; range.closest('form').requestSubmit();
    expect(document.querySelector('.modal-panel')).not.toBeNull();
    expect(wb.linkAt(id, 0, 0).url).toBe('#Sheet1!B2#');
  });

  it('keeps both sheet endpoints visible when editing a span link', () => {
    const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
    wb.addSheet('Two'); wb.setActiveSheet(id); wb.setLink(id, 0, 0, '#Sheet1:Two!B2:C3', 'Across');
    view.el.querySelector('[aria-label="Insert link"]').click();
    expect(document.querySelector('[aria-label="Link to"]').value).toBe('web');
    expect(document.querySelector('input[aria-label="Link"]').value).toBe('#Sheet1:Two!B2:C3');
  });

  it('omits named spans with a missing endpoint from link destinations', () => {
    const { doc } = setup(), wb = doc.wb;
    wb.addSheet('Two'); wb.defineName('ValidSpan', 'Sheet1:Two!B2:C3');
    wb.defineName('BrokenSpan', 'Sheet1:Missing!B2:C3');
    view.el.querySelector('[aria-label="Insert link"]').click();
    const options = [...document.querySelectorAll('[aria-label="Link to"] optgroup[label="Named ranges"] option')];
    expect(options.map((o) => o.textContent)).toEqual(['ValidSpan']);
  });

  it.each(['#BrokenSpan', '#Sheet1:Missing!B2:C3', '#Missing!B2'])(
    'retains invalid endpoint address %s when editing its label', async (url) => {
      const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
      wb.defineName('BrokenSpan', 'Sheet1:Missing!B2:C3'); wb.setLink(id, 0, 0, url, 'Old');
      view.el.querySelector('[aria-label="Insert link"]').click();
      expect(document.querySelector('[aria-label="Link to"]').value).toBe('web');
      const text = document.querySelector('input[aria-label="Text"]'); text.value = 'New';
      text.closest('form').requestSubmit(); await vi.advanceTimersByTimeAsync(1);
      expect(wb.linkAt(id, 0, 0)).toEqual({ url, label: 'New' });
    },
  );

  it('refuses to navigate to a name whose span endpoint is missing', async () => {
    const { doc } = setup(), wb = doc.wb;
    wb.defineName('BrokenSpan', 'Sheet1:Missing!B2:C3');
    expect(view.goTo('BrokenSpan')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.el.querySelector('.name-box').value).toBe('A1');
  });

  it.each(['Results', 'Sheet1!B2#', 'B2#'])('selects the spill area from name-box input %s', async (name) => {
    const { doc } = setup(), wb = doc.wb;
    wb.setInput(wb.activeSheetId, 1, 1, '=SEQUENCE(3,2)');
    wb.defineName('Results', 'Sheet1!$B$2#');
    const box = view.el.querySelector('.name-box');
    box.value = name; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(box.value).toBe('B2:C4');
  });

  it('navigates to a formula name using the selected cell as its origin', async () => {
    const { doc } = setup(), wb = doc.wb;
    const other = wb.addSheet('Two');
    wb.defineName('RelativePlace', 'OFFSET(Two!A1,ROW()-1,COLUMN()-1)');
    wb.setActiveSheet(wb.sheets[0].id); await vi.advanceTimersByTimeAsync(1);
    expect(view.goTo('D7')).toBe(true);
    expect(view.goTo('RelativePlace')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.activeSheetId).toBe(other.id);
    expect(view.el.querySelector('.name-box').value).toBe('D7');
  });

  it('selects an alias entered in the name box', async () => {
    const { doc } = setup(), wb = doc.wb;
    wb.defineName('BasePlace', 'Sheet1!$C$4:$D$5');
    wb.defineName('AliasPlace', 'BasePlace');
    const box = view.el.querySelector('.name-box');
    box.value = 'AliasPlace'; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(box.value).toBe('BasePlace');
  });

  it('offers only named definitions that identify existing worksheet locations', () => {
    const { doc } = setup(), wb = doc.wb;
    wb.defineName('Place', 'Sheet1!$B$2:$C$3');
    wb.defineName('LocalPlace', 'Sheet1!$D$4', 'Sheet1');
    wb.defineName('Rate', '0.2');
    wb.defineName('Double', 'LAMBDA(x,x*2)');
    wb.defineName('Calculation', 'SUM(1,2)');
    wb.defineName('MissingPlace', 'Missing!$A$1');
    view.el.querySelector('[aria-label="Insert link"]').click();
    const options = [...document.querySelectorAll('[aria-label="Link to"] optgroup[label="Named ranges"] option')];
    expect(options.map((option) => option.textContent).sort()).toEqual(['Place', 'Sheet1!LocalPlace']);
    for (const option of options) expect(wb.resolveLink(`#${option.value.slice(5)}`)).not.toBeNull();
  });

  it('omits the named-range group when all names are calculations', () => {
    const { doc } = setup();
    doc.wb.defineName('Rate', '0.2');
    view.el.querySelector('[aria-label="Insert link"]').click();
    expect(document.querySelector('[aria-label="Link to"] optgroup[label="Named ranges"]')).toBeNull();
  });

  it('retains an existing non-location link when editing its display text', async () => {
    const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
    wb.defineName('Rate', '0.2'); wb.setLink(id, 0, 0, '#Rate', 'Old label');
    view.el.querySelector('[aria-label="Insert link"]').click();
    const kind = document.querySelector('[aria-label="Link to"]');
    expect(kind.value).toBe('web');
    expect(document.querySelector('input[aria-label="Link"]').value).toBe('#Rate');
    document.querySelector('input[aria-label="Text"]').value = 'New label';
    kind.closest('form').requestSubmit(); await vi.advanceTimersByTimeAsync(1);
    expect(wb.linkAt(id, 0, 0)).toEqual({ url: '#Rate', label: 'New label' });
    wb.undo(); expect(wb.linkAt(id, 0, 0)?.label).toBe('Old label');
  });

  it('creates a qualified local-name link that navigates to the selected range', async () => {
    const { doc } = setup(), wb = doc.wb, id = wb.activeSheetId;
    const other = wb.addSheet('Two Data');
    wb.defineName('Target', 'Sheet1!$A$1');
    wb.defineName('Target', "'Two Data'!$C$3:$D$4", other.name);
    wb.setActiveSheet(id); await vi.advanceTimersByTimeAsync(1);
    view.el.querySelector('[aria-label="Insert link"]').click();
    const choice = document.querySelector('[aria-label="Link to"]');
    choice.value = "name:'Two Data'!Target"; choice.dispatchEvent(new Event('change'));
    choice.closest('form').requestSubmit(); await vi.advanceTimersByTimeAsync(1);
    const link = wb.linkAt(id, 0, 0);
    expect(link.url).toBe("#'Two Data'!Target");
    expect(view.goTo(link.url.slice(1))).toBe(true);
    expect(wb.activeSheetId).toBe(other.id);
    expect(view.el.querySelector('.name-box').value).toBe('Target');
  });

  it.each([['me@example.com', 'mailto:me@example.com'], ['puter.com/docs', 'https://puter.com/docs']])('accepts %s as advertised', async (input, url) => {
    const { doc } = setup();
    view.el.querySelector('[aria-label="Insert link"]').click();
    const field = document.querySelector('input[aria-label="Link"]');
    field.value = input;
    expect(field.checkValidity()).toBe(true);
    field.closest('form').requestSubmit();
    await vi.advanceTimersByTimeAsync(1);
    expect(doc.wb.linkAt(doc.wb.activeSheetId, 0, 0)?.url).toBe(url);
  });
});

describe('pending image insertion', () => {
  it.each([false, true])('does not report success when protection rejects an image write (replacement=%s)', async (replacement) => {
    const readers = [];
    vi.stubGlobal('FileReader', class { readAsDataURL() { readers.push(this); } });
    vi.stubGlobal('Image', class {
      naturalWidth = 100;
      naturalHeight = 60;
      set src(value) { this.onload?.(); }
    });
    const { doc } = setup();
    const wb = doc.wb;
    const sheetId = wb.activeSheetId;
    const id = replacement ? wb.addChart(sheetId, { type: 'image', title: 'Original', src: 'data:image/png;base64,b2xk', anchor: { r: 0, c: 0 } }) : null;
    await vi.advanceTimersByTimeAsync(1);
    const original = wb.sheet(sheetId).charts;
    const input = view.el.querySelector('input[type="file"][accept^="image/"]');
    Object.defineProperty(input, 'files', { value: [new File(['image'], 'New.png', { type: 'image/png' })] });
    const start = () => {
      if (replacement) {
        view.el.querySelector(`[data-chart="${id}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === 'Replace image…').click();
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const finish = async () => {
      readers.at(-1).result = 'data:image/png;base64,bmV3';
      readers.at(-1).onload();
      await vi.advanceTimersByTimeAsync(1);
    };
    const notify = vi.spyOn(notifications, 'toast');
    start();
    wb.setSheetProtected(sheetId, true);
    await finish();
    expect(wb.sheet(sheetId).charts).toEqual(original);
    expect(notify.mock.calls.some(([message]) => /^Image (inserted|replaced)/.test(message))).toBe(false);
    expect(notify.mock.calls.some(([message]) => /protected/i.test(message))).toBe(true);
    wb.setSheetProtected(sheetId, false);
    start();
    await finish();
    expect(wb.sheet(sheetId).charts).toHaveLength(1);
    expect(wb.sheet(sheetId).charts[0]).toMatchObject({ title: 'New.png', src: 'data:image/png;base64,bmV3' });
    if (replacement) expect(wb.sheet(sheetId).charts[0].id).toBe(id);
    expect(notify.mock.calls.some(([message]) => /^Image (inserted|replaced)/.test(message))).toBe(true);
    wb.undo();
    expect(wb.sheet(sheetId).charts).toEqual(original);
  });

  it.each(['file', 'url'].flatMap((source) => ['cell', 'sheet', 'closed', 'deleted', 'unchanged'].map((change) => [source, change])))('preserves the %s image destination when the editor changes (%s)', async (source, change) => {
    const readers = [];
    vi.stubGlobal('FileReader', class {
      readAsDataURL() { readers.push(this); }
    });
    vi.stubGlobal('Image', class {
      naturalWidth = 100;
      naturalHeight = 60;
      set src(value) { this.onload?.(); }
    });
    const { doc } = setup();
    await vi.advanceTimersByTimeAsync(1);
    const wb = doc.wb;
    const id = wb.activeSheetId;
    const other = wb.addSheet('Other');
    wb.setActiveSheet(id);
    let releaseFetch;
    if (source === 'file') {
      const input = view.el.querySelector('input[type="file"][accept^="image/"]');
      Object.defineProperty(input, 'files', { value: [new File(['image'], 'Picture.png', { type: 'image/png' })] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      expect(readers).toHaveLength(1);
    } else {
      vi.spyOn(P, 'fetchBytes').mockImplementation(() => new Promise((resolve) => { releaseFetch = resolve; }));
      view.el.querySelector('[data-menu="insert"]').click();
      const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
      item('Image').click();
      item('From a URL…').click();
      const input = document.querySelector('.modal-panel input');
      input.value = 'https://example.com/Picture.png';
      input.closest('form').requestSubmit();
      await vi.advanceTimersByTimeAsync(1);
      expect(releaseFetch).toBeTypeOf('function');
    }
    if (change === 'cell') {
      const name = view.el.querySelector('[aria-label="Cell reference"]');
      name.value = 'D5';
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    } else if (change === 'sheet') wb.setActiveSheet(other.id);
    else if (change === 'closed') { view.destroy(); view = null; }
    else if (change === 'deleted') wb.deleteSheet(id);
    if (releaseFetch) {
      releaseFetch(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      await vi.advanceTimersByTimeAsync(1);
    }
    if (readers.length) {
      readers[0].result = 'data:image/png;base64,aW1hZ2U=';
      readers[0].onload();
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.sheet(other.id).charts).toHaveLength(0);
    if (change === 'closed') expect(wb.sheet(id).charts).toHaveLength(0);
    else if (change !== 'deleted') {
      expect(wb.sheet(id).charts).toHaveLength(1);
      expect(wb.sheet(id).charts[0]).toMatchObject({ type: 'image', title: 'Picture.png', anchor: { r: 0, c: 0 } });
      wb.undo();
      expect(wb.sheet(id).charts).toHaveLength(0);
      wb.redo();
      expect(wb.sheet(id).charts).toHaveLength(1);
    }
  });
});

it('keeps the selected object when protection rejects Duplicate', async () => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  const boxId = wb.addChart(id, { type: 'text', text: 'Caption', anchor: { r: 0, c: 0 } });
  wb.setSheetProtected(id, true);
  await vi.advanceTimersByTimeAsync(1);
  const notify = vi.spyOn(notifications, 'toast');
  const duplicate = () => {
    view.el.querySelector(`[data-chart="${boxId}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === 'Duplicate').click();
  };
  duplicate();
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.sheet(id).charts).toHaveLength(1);
  expect(notify.mock.calls.some(([message]) => message.startsWith('Duplicated.'))).toBe(false);
  expect(view.el.querySelector(`[data-chart="${boxId}"]`).classList.contains('selected')).toBe(true);
  wb.setSheetProtected(id, false);
  duplicate();
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.sheet(id).charts).toHaveLength(2);
  expect(notify.mock.calls.some(([message]) => message.startsWith('Duplicated.'))).toBe(true);
  wb.undo();
  expect(wb.sheet(id).charts).toHaveLength(1);
});

it.each([['column', 'Chart'], ['image', 'Image'], ['text', 'Text box']])('does not report deletion of a protected %s object', async (type, label) => {
  const { doc } = setup();
  const wb = doc.wb;
  const sheetId = wb.activeSheetId;
  const id = wb.addChart(sheetId, {
    type, text: 'Caption', src: 'data:image/png;base64,b2xk',
    range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 0, c: 0 },
  });
  wb.setSheetProtected(sheetId, true);
  await vi.advanceTimersByTimeAsync(1);
  const notify = vi.spyOn(notifications, 'toast');
  const remove = () => {
    view.el.querySelector(`[data-chart="${id}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === `Delete ${label.toLowerCase()}`).click();
  };
  remove();
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.chartById(sheetId, id)).not.toBeNull();
  expect(notify.mock.calls.some(([message]) => message === `${label} deleted`)).toBe(false);
  wb.setSheetProtected(sheetId, false);
  remove();
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.chartById(sheetId, id)).toBeNull();
  expect(notify.mock.calls.some(([message]) => message === `${label} deleted`)).toBe(true);
  wb.undo();
  expect(wb.chartById(sheetId, id)).not.toBeNull();
});

describe('file imports during cell edits', () => {
  it.each(['file', 'url'].flatMap((source) => [false, true].map((failed) => [source, failed])))('ignores a %s import that finishes after leaving the editor (failed=%s)', async (source, failed) => {
    const { doc } = setup();
    await vi.advanceTimersByTimeAsync(1);
    let resolve, reject;
    vi.spyOn(IO, 'workbookFromFile').mockReturnValue(new Promise((done, fail) => { resolve = done; reject = fail; }));
    vi.spyOn(P, 'fetchBytes').mockResolvedValue(new Uint8Array([80, 75, 3, 4]));
    const notify = vi.spyOn(notifications, 'toast');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    if (source === 'file') {
      const input = view.el.querySelectorAll('input[type="file"][accept^=".xlsx"]')[1];
      Object.defineProperty(input, 'files', { value: [{ name: 'Import.xlsx', arrayBuffer: async () => new ArrayBuffer(0) }] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      view.el.querySelector('[data-menu="file"]').click();
      const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
      item('Import').click();
      item('From a URL…').click();
      const input = document.querySelector('.modal-panel input');
      input.value = 'https://example.com/Import.xlsx';
      input.closest('form').requestSubmit();
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(IO.workbookFromFile).toHaveBeenCalledOnce();
    const before = contentSnapshot(doc.wb);
    view.destroy();
    view = null;
    notify.mockClear();
    if (failed) reject(new Error('Unreadable file'));
    else resolve(new Workbook());
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('.modal-panel')).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(contentSnapshot(doc.wb)).toEqual(before);
  });

  it.each(['before reading', 'during reading', 'valid'])('respects cell validation when importing sheets (%s)', async (timing) => {
    const { doc } = setup();
    await vi.advanceTimersByTimeAsync(1);
    const wb = doc.wb;
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Original');
    wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: 'Original,Allowed', strict: true });
    let release;
    const arrayBuffer = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    vi.spyOn(IO, 'workbookFromFile').mockResolvedValue(new Workbook());
    const input = view.el.querySelectorAll('input[type="file"][accept^=".xlsx"]')[1];
    Object.defineProperty(input, 'files', { value: [{ name: 'Import.xlsx', arrayBuffer }] });
    const startEdit = () => {
      view.el.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
      view.el.querySelector('.grid-editor').value = timing === 'valid' ? 'Allowed' : 'Invalid';
      view.el.querySelector('.grid-editor').dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (timing !== 'during reading') startEdit();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    if (timing === 'during reading') startEdit();
    if (release) release(new ArrayBuffer(0));
    await vi.advanceTimersByTimeAsync(1);
    if (timing === 'valid') {
      expect(wb.getValue(id, 0, 0)).toBe('Allowed');
      expect(document.querySelector('.modal-panel')).not.toBeNull();
    } else {
      await retryStop(view.el.querySelector('.grid-editor'));
      expect(wb.getValue(id, 0, 0)).toBe('Original');
      expect(document.activeElement).toBe(view.el.querySelector('.grid-editor'));
      expect(view.el.querySelector('.grid-editor').value).toBe('Invalid');
      if (timing === 'before reading') expect(arrayBuffer).not.toHaveBeenCalled();
    }
  });

  it('keeps a rejected edit active when an image is dropped on the sheet', async () => {
    const read = vi.fn();
    vi.stubGlobal('FileReader', class { readAsDataURL = read; });
    const { doc } = setup();
    await vi.advanceTimersByTimeAsync(1);
    const wb = doc.wb;
    const id = wb.activeSheetId;
    wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: 'Allowed', strict: true });
    view.el.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
    view.acceptDrop(new File(['image'], 'Picture.png', { type: 'image/png' }));
    await vi.advanceTimersByTimeAsync(1);
    expect(read).not.toHaveBeenCalled();
    await retryStop(view.el.querySelector('.grid-editor'));
    expect(document.activeElement).toBe(view.el.querySelector('.grid-editor'));
    expect(view.el.querySelector('.grid-editor').value).toBe('x');
  });
});

describe('pending clipboard writes', () => {
  it('cuts visible cells without repeatedly scanning the whole sheet', async () => {
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId, count = 400;
    wb.setCells(id, Array.from({ length: count }, (_, r) => ({ r, c: 0, cell: { v: r + 1, s: { bold: true } } })));
    wb.setHidden(id, 'row', [1], true);
    wb.protectRange(id, { r1: 1, c1: 0, r2: 1, c2: 0 });
    const name = view.el.querySelector('.name-box'), viewport = view.el.querySelector('[role="grid"]');
    name.value = `A1:A${count}`; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    viewport.focus();
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    const before = contentSnapshot(wb), cells = wb.sheet(id).cells, iterate = cells[Symbol.iterator].bind(cells);
    let visited = 0;
    // Bound real cell traversals instead of relying on machine-dependent
    // timing: per-cell clearRange calls repeatedly walk the shrinking sheet.
    cells[Symbol.iterator] = function* () { for (const entry of iterate()) { visited++; yield entry; } };
    let text = '';
    const event = new Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type, value) => { if (type === 'text/plain') text = value; } } });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '', files: [] } });
    try {
      viewport.dispatchEvent(event);
      expect(text.split('\n')).toHaveLength(count - 1);
      // Nothing moves until the paste: the cells stay, and there is nothing to undo.
      expect(wb.sheet(id).cells.size).toBe(count);
      expect(wb.canUndo()).toBe(false);
      name.value = 'C1'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      viewport.focus();
      viewport.dispatchEvent(paste);
    } finally { delete cells[Symbol.iterator]; }
    expect(visited).toBeLessThanOrEqual(count * 6);
    // The visible cells moved as one step; the hidden, protected one stayed.
    expect(wb.getCell(id, 1, 0)).toMatchObject({ v: 2, s: { bold: true } });
    expect(wb.getCell(id, 0, 0)).toBeFalsy();
    expect(wb.getCell(id, 0, 2)).toMatchObject({ v: 1, s: { bold: true } });
    expect(wb.getValue(id, count - 2, 2)).toBe(count);
    expect(wb.sheet(id).cells.size).toBe(count);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo(); expect(contentSnapshot(wb)).toEqual(before);
    wb.redo(); expect(wb.getCell(id, 0, 0)).toBeFalsy();
  });

  it.each(['row', 'col'])('allows visible cut while preserving a protected hidden %s', async (axis) => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { onLine: true, clipboard: { writeText } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setCells(id, Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (_, c) => ({ r, c, cell: { v: r * 3 + c + 1, s: { bold: true } } }))).flat());
    wb.setHidden(id, axis, [1], true);
    wb.protectRange(id, axis === 'row' ? { r1: 1, c1: 0, r2: 1, c2: 2 } : { r1: 0, c1: 1, r2: 2, c2: 1 });
    const name = view.el.querySelector('.name-box');
    name.value = 'A1:C3'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    const before = contentSnapshot(wb);
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Cut').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeText).toHaveBeenCalledWith(axis === 'row' ? '1\t2\t3\n7\t8\t9' : '1\t3\n4\t6\n7\t9');
    // The cut alone changes nothing; the paste moves the visible cells and leaves the hidden, protected ones.
    expect(contentSnapshot(wb)).toEqual(before);
    expect(wb.canUndo()).toBe(false);
    name.value = 'E1'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Paste').click();
    await vi.advanceTimersByTimeAsync(1500);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const hidden = axis === 'row' ? r === 1 : c === 1;
      expect(wb.getValue(id, r, c)).toBe(hidden ? r * 3 + c + 1 : null);
      expect(wb.getCell(id, r, c)?.s?.bold).toBe(hidden ? true : undefined);
    }
    expect(wb.rangeValues(id, axis === 'row' ? { r1: 0, c1: 4, r2: 1, c2: 6 } : { r1: 0, c1: 4, r2: 2, c2: 5 }))
      .toEqual(axis === 'row' ? [[1, 2, 3], [7, 8, 9]] : [[1, 3], [4, 6], [7, 9]]);
    expect(wb.getCell(id, 0, 4).s.bold).toBe(true);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo(); expect(contentSnapshot(wb)).toEqual(before);
    wb.redo(); expect(wb.getValue(id, 0, 0)).toBeNull();
  });

  it.each(['rows', 'columns', 'contiguous'].flatMap((layout) => ['range', 'sheet'].flatMap((protection) =>
    ['event', 'menu'].map((trigger) => ({ layout, protection, trigger })))))(
    'refuses $trigger cut atomically for $protection protection with $layout selection', async ({ layout, protection, trigger }) => {
      const writeText = vi.fn();
      vi.stubGlobal('navigator', { onLine: true, clipboard: { writeText, readText: async () => '' } });
      const { doc } = setup();
      const wb = doc.wb, id = wb.activeSheetId;
      wb.setCells(id, Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (_, c) => ({ r, c, cell: { v: `${r}:${c}`, s: { bold: true } } }))).flat());
      wb.setInput(id, 4, 4, 'Earlier copy');
      if (layout === 'rows') wb.setHidden(id, 'row', [1], true);
      if (layout === 'columns') wb.setHidden(id, 'col', [1], true);
      if (protection === 'sheet') wb.setSheetProtected(id, true);
      else wb.protectRange(id, { r1: 2, c1: 2, r2: 2, c2: 2 });
      const name = view.el.querySelector('.name-box'), viewport = view.el.querySelector('[role="grid"]');
      const select = (range) => { name.value = range; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); viewport.focus(); };
      select('E5');
      const copy = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copy, 'clipboardData', { value: { setData: vi.fn() } });
      viewport.dispatchEvent(copy);
      select('A1:C3');
      await vi.advanceTimersByTimeAsync(1);
      wb.clearHistory();
      const before = contentSnapshot(wb), notify = vi.spyOn(notifications, 'toast'), setData = vi.fn();
      if (trigger === 'event') {
        const cut = new Event('cut', { bubbles: true, cancelable: true });
        Object.defineProperty(cut, 'clipboardData', { value: { setData } });
        viewport.dispatchEvent(cut);
      } else {
        view.el.querySelector('[data-menu="edit"]').click();
        [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Cut').click();
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(contentSnapshot(wb)).toEqual(before);
      expect(wb.canUndo()).toBe(false);
      expect(setData).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
      expect(notify.mock.calls.some(([message]) => /^Cut\b/.test(message))).toBe(false);
      expect(notify.mock.calls.some(([message]) => /protected/i.test(message))).toBe(true);
      if (protection === 'sheet') wb.setSheetProtected(id, false);
      select('H5');
      view.el.querySelector('[data-menu="edit"]').click();
      [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Paste').click();
      await vi.advanceTimersByTimeAsync(1);
      expect(wb.getValue(id, 4, 7)).toBe('Earlier copy');
    });

  it.each(['Copy', 'Cut'].flatMap((action) => [false, true].map((failed) => [action, failed])))('keeps a newer cell edit focused after %s finishes (failed=%s)', async (action, failed) => {
    let resolve, reject;
    const writeText = vi.fn(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    vi.stubGlobal('navigator', { onLine: true, clipboard: { writeText } });
    const { doc } = setup();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Original');
    await vi.advanceTimersByTimeAsync(1);
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === action).click();
    expect(writeText).toHaveBeenCalledWith('Original');
    view.el.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
    const input = view.el.querySelector('.grid-editor');
    expect(document.activeElement).toBe(input);
    if (failed) reject(new Error('Permission denied'));
    else resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('x');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('x');
  });
});

describe('pasting external HTML', () => {
  it.each(['row', 'column'].flatMap((orientation) => [
    { input: '00123', expected: 123, expectedStyle: { bold: true }, style: { fmt: 'text', bg: '#00ff00' }, decoyStyle: { fmt: 'number', dec: 2 } },
    { input: '12%', expected: 0.12, expectedStyle: { bold: true, fmt: 'percent', dec: 0 }, style: { fmt: 'percent', dec: 3, bg: '#00ff00' }, decoyStyle: { fmt: 'text' } },
    { input: '', expected: null, expectedStyle: { bold: true }, style: { fmt: 'currency', dec: 4, bg: '#00ff00' }, decoyStyle: { fmt: 'text' } },
  ].map((test) => ({ orientation, ...test }))))(
    'uses source formatting for transposed HTML $orientation input "$input"', async ({ orientation, input, expected, expectedStyle, style, decoyStyle }) => {
      const second = `<td style="font-weight:bold">${input}</td>`;
      const html = orientation === 'row' ? `<table><tr><td>Heading</td>${second}</tr></table>` : `<table><tr><td>Heading</td></tr><tr>${second}</tr></table>`;
      vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
      const { doc } = setup();
      const wb = doc.wb, id = wb.activeSheetId;
      const destination = orientation === 'row' ? { r: 3, c: 2 } : { r: 2, c: 3 };
      const decoy = orientation === 'row' ? { r: 2, c: 3 } : { r: 3, c: 2 };
      wb.setCells(id, [
        { ...destination, cell: { v: 'Replace', s: style } },
        { ...decoy, cell: { v: 'Untouched', s: decoyStyle } },
      ]);
      const name = view.el.querySelector('.name-box');
      name.value = 'C3'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
      wb.clearHistory();
      const before = contentSnapshot(wb);
      view.el.querySelector('[data-menu="edit"]').click();
      const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
      item('Paste special').click(); item('Transposed').click();
      await vi.advanceTimersByTimeAsync(1);
      expect(wb.getValue(id, destination.r, destination.c)).toBe(expected);
      expect(wb.getCell(id, destination.r, destination.c).s).toEqual(expectedStyle);
      expect(wb.getCell(id, decoy.r, decoy.c)).toMatchObject({ v: 'Untouched', s: decoyStyle });
      expect(name.value).toBe(orientation === 'row' ? 'C3:C4' : 'C3:D3');
      expect(wb.undoLabels()).toHaveLength(1);
      wb.undo(); expect(contentSnapshot(wb)).toEqual(before);
      wb.redo(); expect(wb.getValue(id, destination.r, destination.c)).toBe(expected);
    });

  it.each(['HTML', 'cells'].flatMap((format) => [false, true].map((tiled) => ({ format, tiled }))))(
    'pastes $format formatting with tiling $tiled without adding data to a table', async ({ format, tiled }) => {
      const html = format === 'HTML' ? '<table><tr><td style="font-weight:bold">5</td></tr><tr><td style="font-style:italic">7</td></tr></table>'
        : stampClipboardHtml('<table data-spreadsheet-cells=\'[[{"v":5,"s":{"bold":true}}],[{"v":7,"s":{"italic":true}}]]\'></table>');
      vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
      const { doc } = setup();
      const wb = doc.wb, id = wb.activeSheetId;
      wb.setInput(id, 0, 0, 'Amount'); wb.setInput(id, 1, 0, '1');
      wb.setInput(id, 0, 1, 'Double');
      [10, 20, 30, 40].forEach((v, i) => wb.setInput(id, i + 2, 0, String(v)));
      const table = wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 1 }, { name: 'Sales' });
      wb.setInput(id, 1, 1, '=[@Amount]*2');
      wb.setInput(id, 0, 3, '=SUM(Sales[Amount])');
      const name = view.el.querySelector('.name-box');
      name.value = tiled ? 'A3:A6' : 'A3'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
      wb.clearHistory();
      const before = contentSnapshot(wb);
      view.el.querySelector('[data-menu="edit"]').click();
      const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
      item('Paste special').click(); item('Formatting only').click();
      await vi.advanceTimersByTimeAsync(1);
      expect(wb.getValue(id, 0, 3)).toBe(1);
      expect(wb.tableById(id, table).range.r2).toBe(1);
      expect(wb.sheet(id).filter.range.r2).toBe(1);
      expect([2, 3, 4, 5].map((r) => wb.getValue(id, r, 0))).toEqual([10, 20, 30, 40]);
      expect([2, 3, 4, 5].map((r) => wb.getValue(id, r, 1))).toEqual([null, null, null, null]);
      for (let r = 2; r <= (tiled ? 5 : 3); r++) expect(wb.getCell(id, r, 0).s[r % 2 ? 'italic' : 'bold']).toBe(true);
      expect(name.value).toBe(tiled ? 'A3:A6' : 'A3:A4');
      const after = contentSnapshot(wb);
      expect(wb.undoLabels()).toHaveLength(1);
      wb.undo(); expect(contentSnapshot(wb)).toEqual(before);
      wb.redo(); expect(contentSnapshot(wb)).toEqual(after);
    });

  it.each([
    ['empty cell', '<tr><td style="font-weight:bold">5</td></tr><tr><td></td></tr><tr><td>7</td></tr>'],
    ['styled whitespace', '<tr><td style="font-weight:bold">5</td></tr><tr><td style="background:red">&nbsp; </td></tr><tr><td>7</td></tr>'],
    ['empty row', '<tr><td style="font-weight:bold">5</td></tr><tr></tr><tr><td>7</td></tr>'],
    ['row-span placeholder', '<tr><td rowspan="2" style="font-weight:bold">5</td></tr><tr></tr><tr><td>7</td></tr>'],
  ].flatMap(([blank, rows]) => [false, true].map((protectedBlank) => ({ blank, rows, protectedBlank }))))(
    'handles HTML $blank with protection $protectedBlank in skip-blanks paste', async ({ blank, rows, protectedBlank }) => {
      const html = `<table>${rows}</table>`;
      vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
      const { doc } = setup();
      const wb = doc.wb, id = wb.activeSheetId;
      wb.setCells(id, [10, 20, 30].map((v, r) => ({ r, c: 0, cell: { v, s: { bg: '#00ff00', fmt: 'number', dec: 2 } } })));
      if (protectedBlank) wb.protectRange(id, { r1: 1, c1: 0, r2: 1, c2: 0 });
      await vi.advanceTimersByTimeAsync(1);
      wb.clearHistory();
      const before = contentSnapshot(wb), untouched = { ...wb.getCell(id, 1, 0), s: { ...wb.getCell(id, 1, 0).s } };
      view.el.querySelector('[data-menu="edit"]').click();
      const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
      item('Paste special').click(); item('Skip blanks').click();
      await vi.advanceTimersByTimeAsync(1);
      // A span represents one merged cell, not an independent blank. Its body
      // cannot retain a hidden value or bypass protection when being merged.
      const merged = blank === 'row-span placeholder';
      if (merged && protectedBlank) {
        expect(contentSnapshot(wb)).toEqual(before);
        expect(wb.undoLabels()).toHaveLength(0);
        return;
      }
      expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual([5, merged ? null : 20, 7]);
      if (merged) expect(wb.activeSheet.merges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 0 }]);
      else expect(wb.getCell(id, 1, 0)).toEqual(untouched);
      expect(wb.getCell(id, 0, 0).s.bold).toBe(true);
      expect(view.el.querySelector('.name-box').value).toBe('A1:A3');
      expect(wb.undoLabels()).toHaveLength(1);
      wb.undo(); expect(contentSnapshot(wb)).toEqual(before);
      wb.redo(); expect(wb.getValue(id, 2, 0)).toBe(7);
    });

  it('keeps zero, false, and formulas returning empty text in HTML skip-blanks paste', async () => {
    const html = '<table><tr><td>0</td><td>FALSE</td><td>=""</td><td></td></tr></table>';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    [0, 1, 2, 3].forEach((c) => wb.setInput(id, 0, c, '42'));
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click(); item('Skip blanks').click();
    await vi.advanceTimersByTimeAsync(1);
    expect([0, 1, 2, 3].map((c) => wb.getValue(id, 0, c))).toEqual([0, false, '', 42]);
    expect(wb.getCell(id, 0, 2).f).toBe('""');
  });

  it.each(['text', 'cells'])('allows %s skip-blanks paste across an untouched protected cell', async (format) => {
    const type = format === 'text' ? 'text/plain' : 'text/html';
    const contents = format === 'text' ? '5\n\n7' : stampClipboardHtml('<table data-spreadsheet-cells=\'[[{"v":5}],[null],[{"v":7}]]\'></table>');
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: [type], getType: async () => ({ text: async () => contents }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    [10, 20, 30].forEach((v, r) => wb.setInput(id, r, 0, String(v)));
    wb.protectRange(id, { r1: 1, c1: 0, r2: 1, c2: 0 });
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click(); item('Skip blanks').click();
    await vi.advanceTimersByTimeAsync(1);
    expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual([5, 20, 7]);
    expect(view.el.querySelector('.name-box').value).toBe('A1:A3');
    expect(wb.undoLabels()).toHaveLength(1);
  });

  it('selects an unchanged ordinary paste without creating history', async () => {
    vi.stubGlobal('navigator', { onLine: true, clipboard: { readText: async () => '5\n7' } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '5'); wb.setInput(id, 1, 0, '7');
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Paste').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(view.el.querySelector('.name-box').value).toBe('A1:A2');
    expect(wb.canUndo()).toBe(false);
  });

  it('refuses a protected tile outside the first copied block and permits a later retry', async () => {
    const html = stampClipboardHtml('<table data-spreadsheet-cells=\'[[{"v":5}],[{"v":7}]]\'></table>');
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Amount'); wb.setInput(id, 1, 0, '1');
    const table = wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { name: 'Sales' });
    const protection = wb.protectRange(id, { r1: 5, c1: 0, r2: 5, c2: 0 });
    const name = view.el.querySelector('.name-box');
    name.value = 'A3:A6'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    const before = contentSnapshot(wb);
    const paste = async () => {
      view.el.querySelector('[data-menu="edit"]').click();
      [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Paste').click();
      await vi.advanceTimersByTimeAsync(1);
    };
    await paste();
    expect(contentSnapshot(wb)).toEqual(before);
    expect(wb.canUndo()).toBe(false);
    expect(name.value).toBe('A3:A6');
    wb.unprotectRange(id, protection);
    wb.clearHistory();
    await paste();
    expect([2, 3, 4, 5].map((r) => wb.getValue(id, r, 0))).toEqual([5, 7, 5, 7]);
    expect(wb.tableById(id, table).range.r2).toBe(5);
    expect(wb.undoLabels()).toHaveLength(1);
  });

  it.each([
    ['text', 'Paste'], ['text', 'Values only'], ['text', 'Transposed'], ['text', 'Skip blanks'],
    ['HTML', 'Paste'], ['HTML', 'Values only'], ['HTML', 'Transposed'], ['HTML', 'Formatting only'],
    ['cells', 'Paste'], ['cells', 'Formulas only (keep formatting)'], ['cells', 'Formatting only'],
    ['cells', 'Transposed'], ['cells', 'Skip blanks'],
  ].flatMap(([format, label]) => ['range', 'sheet'].map((protection) => ({ format, label, protection }))))(
    'retains workbook and selection when $protection protection refuses $format $label', async ({ format, label, protection }) => {
      const transpose = label === 'Transposed';
      const type = format === 'text' ? 'text/plain' : 'text/html';
      const cells = transpose ? [[{ v: 5, s: { bold: true } }, { v: 7 }]] : [[{ v: 5, s: { bold: true } }], [{ v: 7 }]];
      const contents = format === 'text' ? (transpose ? '5\t7' : '5\n7') : format === 'cells'
        ? stampClipboardHtml(`<table data-spreadsheet-cells='${JSON.stringify(cells)}'></table>`)
        : transpose ? '<table><tr><td>5</td><td>7</td></tr></table>' : '<table><tr><td style="font-weight:bold">5</td></tr><tr><td>7</td></tr></table>';
      vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: [type], getType: async () => ({ text: async () => contents }) }] } });
      const { doc } = setup();
      const wb = doc.wb, id = wb.activeSheetId;
      wb.setCells(id, [['Amount', 'Double'], [1, null], [10, null], [20, null]].flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
      wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 1 }, { name: 'Sales' });
      wb.setInput(id, 1, 1, '=[@Amount]*2');
      if (protection === 'sheet') wb.setSheetProtected(id, true);
      else wb.protectRange(id, { r1: 3, c1: 0, r2: 3, c2: 0 });
      const name = view.el.querySelector('.name-box');
      name.value = 'A3'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
      wb.clearHistory();
      const before = contentSnapshot(wb), notify = vi.spyOn(notifications, 'toast');
      view.el.querySelector('[data-menu="edit"]').click();
      const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
      if (label !== 'Paste') item('Paste special').click();
      item(label).click();
      await vi.advanceTimersByTimeAsync(1);
      expect(contentSnapshot(wb)).toEqual(before);
      expect(wb.canUndo()).toBe(false);
      expect(name.value).toBe('A3');
      expect(notify.mock.calls.some(([message]) => /protected/i.test(message))).toBe(true);
    });

  it.each([
    ['text', 'Paste'], ['HTML', 'Paste'], ['cells', 'Paste'], ['cells', 'Values only'],
    ['text', 'Transposed'], ['text', 'Add'], ['text', 'Insert copied cells, shifting down'],
  ])('undoes %s %s together with automatic table expansion', async (format, label) => {
    const type = format === 'text' ? 'text/plain' : 'text/html';
    const contents = format === 'text' ? (label === 'Transposed' ? '5\t7' : '5\n7')
      : format === 'HTML' ? '<table><tr><td>5</td></tr><tr><td>7</td></tr></table>'
        : stampClipboardHtml('<table data-spreadsheet-cells=\'[[{"v":5}],[{"v":7}]]\' data-spreadsheet-values=\'[[5],[7]]\'></table>');
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: [type], getType: async () => ({ text: async () => contents }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setCells(id, [['Amount', 'Double'], [1, null]].flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
    const table = wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 1 }, { name: 'Sales' });
    wb.setInput(id, 1, 1, '=[@Amount]*2');
    wb.setNote(id, 5, 0, 'Keep this note');
    const name = view.el.querySelector('.name-box');
    name.value = 'A3'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    const before = contentSnapshot(wb);
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    if (label !== 'Paste') item('Paste special').click();
    item(label).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.tableById(id, table).range.r2).toBe(3);
    expect([2, 3].map((r) => wb.getValue(id, r, 1))).toEqual([10, 14]);
    const after = contentSnapshot(wb);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo(); expect(contentSnapshot(wb)).toEqual(before);
    wb.redo(); expect(contentSnapshot(wb)).toEqual(after);
  });

  it.each(['internal', 'another tab', 'hidden anchor'])('pastes visible spill results from %s when the copied block omits its formula', async (source) => {
    let text = '', html = '';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/plain', 'text/html'], getType: async (type) => ({ text: async () => type === 'text/html' ? html : text }) }] } });
    let { doc } = setup();
    let wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '=SEQUENCE(3,1,1.23456,1)');
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'number', dec: 2 });
    if (source === 'hidden anchor') wb.setHidden(id, 'row', [0], true);
    const name = view.el.querySelector('.name-box');
    name.value = source === 'hidden anchor' ? 'A1:A3' : 'A2:A3';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const viewport = view.el.querySelector('[role="grid"]');
    viewport.focus();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type, value) => { if (type === 'text/html') html = value; else if (type === 'text/plain') text = value; } } });
    viewport.dispatchEvent(event);
    expect(text).toBe('2.23\n3.23');
    if (source === 'another tab') {
      view.destroy(); view = null;
      ({ doc } = setup()); wb = doc.wb; id = wb.activeSheetId;
    }
    wb.setInput(id, 1, 2, 'Keep'); wb.setInput(id, 2, 2, 'Keep');
    const destination = view.el.querySelector('.name-box');
    destination.value = 'C2'; destination.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Paste').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, 1, 2)).toBe(2.23456);
    expect(wb.getValue(id, 2, 2)).toBe(3.23456);
    expect(wb.getDisplay(id, 1, 2)).toBe('2.23');
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo(); expect(wb.getValue(id, 1, 2)).toBe('Keep');
    wb.redo(); expect(wb.getValue(id, 2, 2)).toBe(3.23456);
  });

  it('keeps a protected linked paste atomic and retains the selection and table', async () => {
    let text = '';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { readText: async () => text } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Amount'); wb.setInput(id, 1, 0, '3');
    wb.setInput(id, 2, 0, '10'); wb.setInput(id, 3, 0, '20');
    wb.setInput(id, 0, 2, '5'); wb.setInput(id, 1, 2, '7');
    wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { name: 'Sales' });
    wb.protectRange(id, { r1: 3, c1: 0, r2: 3, c2: 0 });
    const name = view.el.querySelector('.name-box');
    name.value = 'C1:C2'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const viewport = view.el.querySelector('[role="grid"]');
    viewport.focus();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type, value) => { if (type === 'text/plain') text = value; } } });
    viewport.dispatchEvent(event);
    name.value = 'A3'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    const before = contentSnapshot(wb), notify = vi.spyOn(notifications, 'toast');
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click(); item('Links to the copied cells').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(contentSnapshot(wb)).toEqual(before);
    expect(wb.canUndo()).toBe(false);
    expect(name.value).toBe('A3');
    expect(notify.mock.calls.some(([message]) => /^Pasted \d+ links?/.test(message))).toBe(false);
    expect(notify.mock.calls.some(([message]) => /protected/i.test(message))).toBe(true);
  });

  it.each([
    ['text/html', 'Paste'], ['text/html', 'Values only'], ['text/html', 'Transposed'],
    ['text/html', 'Skip blanks'], ['text/plain', 'Skip blanks'],
  ])('updates table references when %s %s changes headers', async (type, label) => {
    const html = label === 'Transposed' ? '<table><tr><td>Second</td></tr><tr><td>First</td></tr></table>' : '<table><tr><td>Second</td><td>First</td></tr></table>';
    const contents = type === 'text/html' ? html : 'Second\tFirst';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: [type], getType: async () => ({ text: async () => contents }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setCells(id, [['First', 'Second'], [10, 20]].flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
    wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 1 }, { name: 'Sales' });
    wb.setInput(id, 0, 3, '=SUM(Sales[First])+10*SUM(Sales[Second])');
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    if (label !== 'Paste') item('Paste special').click();
    item(label).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getCell(id, 0, 3).f).toBe('SUM(Sales[Second])+10*SUM(Sales[First])');
    expect(wb.getValue(id, 0, 3)).toBe(210);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo(); expect(wb.getValue(id, 0, 0)).toBe('First');
    wb.redo(); expect(wb.getValue(id, 0, 3)).toBe(210);
  });

  it.each(['range', 'sheet', 'unchanged'])('does not extend tables or claim arithmetic changes for %s refusal', async (reason) => {
    const text = reason === 'unchanged' ? '0\n0' : '1\n2';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { readText: async () => text } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Amount'); wb.setInput(id, 1, 0, '5');
    wb.setInput(id, 2, 0, '10'); wb.setInput(id, 3, 0, '20');
    wb.addTable(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { name: 'Sales' });
    if (reason === 'sheet') wb.setSheetProtected(id, true);
    else if (reason === 'range') wb.protectRange(id, { r1: 3, c1: 0, r2: 3, c2: 0 });
    const name = view.el.querySelector('.name-box');
    name.value = 'A3'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    const before = contentSnapshot(wb), notify = vi.spyOn(notifications, 'toast');
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click(); item('Add').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(contentSnapshot(wb)).toEqual(before);
    expect(wb.canUndo()).toBe(false);
    expect(name.value).toBe('A3');
    expect(notify.mock.calls.some(([message]) => message.startsWith('Added to'))).toBe(false);
    if (reason !== 'unchanged') expect(notify.mock.calls.some(([message]) => /protected/i.test(message))).toBe(true);
  });

  it.each(['text/plain', 'text/html'])('still reads external arithmetic operands from %s', async (type) => {
    const contents = type === 'text/plain' ? '$1.25\t50%' : '<table><tr><td>$1.25</td><td>50%</td></tr></table>';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: [type], getType: async () => ({ text: async () => contents }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '10'); wb.setInput(id, 0, 1, '10');
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click(); item('Add').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, 0, 0)).toBe(11.25);
    expect(wb.getValue(id, 0, 1)).toBe(10.5);
  });

  it.each(['internal', 'another tab'].flatMap((source) => [
    { label: 'Add', expected: [13.58016, 14.81472] },
    { label: 'Subtract', expected: [11.11104, 9.87648] },
    { label: 'Multiply', expected: [15.241383936, 30.482767872] },
    { label: 'Divide', expected: [10, 5] },
  ].map((operation) => ({ source, ...operation }))))('uses copied numbers for $label from $source', async ({ source, label, expected }) => {
    let text = '', html = '';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
    let { doc } = setup();
    let wb = doc.wb, id = wb.activeSheetId;
    wb.setCells(id, [
      { r: 0, c: 0, cell: { v: 1.23456, s: { fmt: 'currency', dec: 2 } } },
      { r: 1, c: 0, cell: { f: 'A1*2', s: { fmt: 'percent', dec: 1 } } },
      { r: 2, c: 0, cell: { v: '123' } },
      { r: 3, c: 0, cell: { v: true } },
      { r: 4, c: 0, cell: { f: 'NA()' } },
    ]);
    const name = view.el.querySelector('.name-box');
    name.value = 'A1:A6'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const viewport = view.el.querySelector('[role="grid"]');
    viewport.focus();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type, value) => { if (type === 'text/html') html = value; else if (type === 'text/plain') text = value; } } });
    viewport.dispatchEvent(event);
    expect(text).toContain('246.9%');
    wb.setInput(id, 0, 0, '99');
    if (source === 'another tab') {
      view.destroy(); view = null;
      ({ doc } = setup()); wb = doc.wb; id = wb.activeSheetId;
    }
    wb.setCells(id, Array.from({ length: 6 }, (_, r) => ({ r, c: 2, cell: { v: 12.3456, s: { bg: '#00ff00' } } })));
    const destination = view.el.querySelector('.name-box');
    destination.value = 'C1'; destination.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click(); item(label).click();
    await vi.advanceTimersByTimeAsync(1);
    // Text, a logical and an error leave the number alone; a blank counts as 0 (12.3456 × 0, 12.3456 ÷ 0).
    const blank = { Multiply: 0, Divide: { error: '#DIV/0!' } }[label] ?? 12.3456;
    for (const [r, value] of [...expected, 12.3456, 12.3456, 12.3456, blank].entries()) {
      expect(wb.getValue(id, r, 2), `row ${r + 1}`).toEqual(value);
      expect(wb.getCell(id, r, 2).s).toEqual({ bg: '#00ff00' });
    }
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo(); expect(wb.getValue(id, 0, 2)).toBe(12.3456);
    wb.redo(); expect(wb.getValue(id, 0, 2)).toBe(expected[0]);
  });

  it.each([false, true])('handles an unchanged value snapshot paste with protection: %s', async (protectedRange) => {
    const html = stampClipboardHtml('<table data-spreadsheet-cells=\'[[{"v":1}],[{"v":2}]]\' data-spreadsheet-values=\'[[1],[2]]\'></table>');
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 2, '1'); wb.setInput(id, 1, 2, '2');
    if (protectedRange) wb.protectRange(id, { r1: 1, c1: 2, r2: 1, c2: 2 });
    const name = view.el.querySelector('.name-box');
    name.value = 'C1'; name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click(); item('Values only').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(name.value).toBe(protectedRange ? 'C1' : 'C1:C2');
    expect(wb.canUndo()).toBe(false);
  });

  it.each(['internal', 'another tab'])('pastes exact copied values from %s without reparsing formatted display text', async (source) => {
    let text = '', html = '';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/plain', 'text/html'], getType: async (type) => ({ text: async () => type === 'text/html' ? html : text }) }] } });
    let { doc } = setup();
    let wb = doc.wb, id = wb.activeSheetId;
    wb.setCells(id, [
      { r: 0, c: 0, cell: { v: 1.23456, s: { fmt: 'currency', dec: 2 } } },
      { r: 1, c: 0, cell: { f: 'A1/2', s: { fmt: 'percent', dec: 1 } } },
      { r: 2, c: 0, cell: { v: '00123' } },
      { r: 3, c: 0, cell: { v: '=1+2' } },
      { r: 4, c: 0, cell: { f: 'NA()' } },
      { r: 5, c: 0, cell: { v: true } },
      { r: 7, c: 0, cell: { f: 'SEQUENCE(2)' } },
    ]);
    const name = view.el.querySelector('.name-box');
    name.value = 'A1:A9';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const viewport = view.el.querySelector('[role="grid"]');
    viewport.focus();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type, value) => { if (type === 'text/html') html = value; else if (type === 'text/plain') text = value; } } });
    viewport.dispatchEvent(event);
    // Copy is a snapshot: later source edits must not change pasted values.
    wb.setInput(id, 0, 0, '99');
    if (source === 'another tab') {
      view.destroy(); view = null;
      ({ doc } = setup()); wb = doc.wb; id = wb.activeSheetId;
    }
    wb.applyStyle(id, { r1: 0, c1: 2, r2: 8, c2: 2 }, { bg: '#00ff00', fmt: 'number', dec: 5 });
    const destination = view.el.querySelector('.name-box');
    destination.value = 'C1';
    destination.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click(); item('Values only').click();
    await vi.advanceTimersByTimeAsync(1);
    const expected = [1.23456, 0.61728, '00123', '=1+2', { error: '#N/A' }, true, null, 1, 2];
    for (const [r, value] of expected.entries()) {
      expect(wb.getValue(id, r, 2), `row ${r + 1}`).toEqual(value);
      expect(wb.getCell(id, r, 2)?.f).toBeNull();
      expect(wb.getCell(id, r, 2).s).toEqual({ bg: '#00ff00', fmt: 'number', dec: 5 });
    }
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo(); expect(wb.getValue(id, 0, 2)).toBeNull();
    wb.redo(); expect(wb.getValue(id, 0, 2)).toBe(1.23456);
  });

  it.each(['text', 'HTML'].flatMap((format) => ['down', 'right'].map((direction) => ({ format, direction }))))(
    'inserts external $format cells while shifting $direction', async ({ format, direction }) => {
      const html = '<table><tr><td style="font-weight:bold">First</td><td>12%</td></tr><tr><td>Last</td></tr></table>';
      vi.stubGlobal('navigator', { onLine: true, clipboard: format === 'text'
        ? { readText: async () => 'First\t12%\nLast' }
        : { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
      const { doc } = setup();
      const wb = doc.wb, id = wb.activeSheetId;
      wb.setInput(id, 2, 2, 'Keep');
      wb.setNote(id, 2, 2, 'Keep note');
      wb.setInput(id, 0, 0, '=C3');
      const nameBox = view.el.querySelector('.name-box');
      nameBox.value = 'C3';
      nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
      wb.clearHistory();
      view.el.querySelector('[data-menu="edit"]').click();
      const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
      item('Paste special').click();
      item(`Insert copied cells, shifting ${direction}`).click();
      await vi.advanceTimersByTimeAsync(1);
      const r = direction === 'down' ? 4 : 2, c = direction === 'right' ? 4 : 2;
      expect(wb.getValue(id, r, c)).toBe('Keep');
      expect(wb.getNote(id, r, c)).toBe('Keep note');
      expect(wb.getValue(id, 0, 0)).toBe('Keep');
      expect(wb.getValue(id, 2, 2)).toBe('First');
      expect(wb.getValue(id, 2, 3)).toBe(0.12);
      expect(wb.getCell(id, 2, 3).s.fmt).toBe('percent');
      expect(wb.getValue(id, 3, 2)).toBe('Last');
      expect(wb.getValue(id, 3, 3)).toBeNull();
      if (format === 'HTML') expect(wb.getCell(id, 2, 2).s.bold).toBe(true);
      expect(nameBox.value).toBe('C3:D4');
      expect(wb.undoLabels()).toEqual(['Insert copied cells']);
      wb.undo(); expect(wb.getValue(id, 2, 2)).toBe('Keep');
      wb.redo(); expect(wb.getValue(id, r, c)).toBe('Keep');
    },
  );

  it('retains formula shifting for the app’s own HTML-only copy with empty display text', async () => {
    let html = '';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 0, '=IF(B1=0,"",B1)');
    const viewport = view.el.querySelector('[role="grid"]');
    viewport.focus();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type, value) => { if (type === 'text/html') html = value; } } });
    viewport.dispatchEvent(event);
    const nameBox = view.el.querySelector('.name-box');
    nameBox.value = 'A2';
    nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Paste').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getCell(id, 1, 0).f).toBe('IF(B2=0,"",B2)');
  });

  it.each([false, true])('pastes an HTML-only system clipboard with an existing internal copy: %s', async (copied) => {
    const html = '<table><tr><td>New value</td><td>42</td></tr></table>';
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html'], getType: async () => ({ text: async () => html }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Old copy');
    if (copied) {
      const viewport = view.el.querySelector('[role="grid"]');
      viewport.focus();
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData: vi.fn() } });
      viewport.dispatchEvent(event);
    }
    wb.setInput(id, 0, 0, 'Destination');
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Paste').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, 0, 0)).toBe('New value');
    expect(wb.getValue(id, 0, 1)).toBe(42);
    wb.undo(); expect(wb.getValue(id, 0, 0)).toBe('Destination');
  });

  it.each(['embedded', 'text', 'HTML'].flatMap((format) => ['down', 'right'].flatMap((direction) =>
    ['expands', 'straddles', 'moves aside'].map((kind) => ({ format, direction, kind })))))(
    'handles $format inserted paste protection that $kind when shifting $direction', async ({ format, direction, kind }) => {
      const cells = direction === 'down' ? [[{ v: 'First' }], [{ v: 'Last' }]] : [[{ v: 'First' }, { v: 'Last' }]];
      const text = cells.map((row) => row.map((cell) => cell.v).join('\t')).join('\n');
      const html = format === 'embedded' ? stampClipboardHtml(`<table data-spreadsheet-cells='${JSON.stringify(cells)}'></table>`)
        : `<table>${cells.map((row) => `<tr>${row.map((cell) => `<td>${cell.v}</td>`).join('')}</tr>`).join('')}</table>`;
      vi.stubGlobal('navigator', { onLine: true, clipboard: format === 'text' ? { readText: async () => text }
        : { read: async () => [{ types: ['text/html', 'text/plain'], getType: async (type) => ({ text: async () => type === 'text/html' ? html : text }) }] } });
      const { doc } = setup();
      const wb = doc.wb, id = wb.activeSheetId;
      wb.setInput(id, 2, 2, 'Keep');
      wb.setNote(id, 2, 2, 'Keep note');
      wb.setInput(id, 0, 0, '=C3');
      const range = { r1: 2, c1: 2, r2: 2, c2: 2 };
      if (kind === 'expands') { range[direction === 'down' ? 'r1' : 'c1'] = 1; range[direction === 'down' ? 'r2' : 'c2'] = 3; }
      if (kind === 'straddles') { range[direction === 'down' ? 'c1' : 'r1'] = 1; range[direction === 'down' ? 'c2' : 'r2'] = 3; }
      wb.protectRange(id, range, 'Keep this data');
      const nameBox = view.el.querySelector('.name-box');
      nameBox.value = 'C3';
      nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
      wb.clearHistory();
      const before = contentSnapshot(wb);
      view.el.querySelector('[data-menu="edit"]').click();
      const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
      item('Paste special').click();
      item(`Insert copied cells, shifting ${direction}`).click();
      await vi.advanceTimersByTimeAsync(1);
      if (kind === 'moves aside') {
        const r = direction === 'down' ? 4 : 2, c = direction === 'right' ? 4 : 2;
        expect(wb.getValue(id, 2, 2)).toBe('First');
        expect(wb.getValue(id, r, c)).toBe('Keep');
        expect(wb.getNote(id, r, c)).toBe('Keep note');
        expect(wb.protectedRangeAt(id, r, c)).not.toBeNull();
        wb.undo(); expect(contentSnapshot(wb)).toEqual(before);
      } else {
        expect(contentSnapshot(wb)).toEqual(before);
        expect(wb.canUndo()).toBe(false);
        expect(nameBox.value).toBe('C3');
      }
    },
  );

  it.each(['down', 'right'])('refuses an inserted paste beyond the %s paste limit before shifting cells', async (direction) => {
    const cells = direction === 'down' ? [[{ v: 'First' }], [{ v: 'Last' }]] : [[{ v: 'First' }, { v: 'Last' }]];
    const html = stampClipboardHtml(`<table data-spreadsheet-cells='${JSON.stringify(cells)}'></table>`);
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html', 'text/plain'], getType: async (type) => ({ text: async () => type === 'text/html' ? html : 'First\nLast' }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    const r = direction === 'down' ? 1048575 : 0, c = direction === 'right' ? 16383 : 0;
    wb.setInput(id, r, c, 'Keep');
    const nameBox = view.el.querySelector('.name-box');
    nameBox.value = direction === 'down' ? 'A1048576' : 'XFD1';
    nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    const before = contentSnapshot(wb);
    const notify = vi.spyOn(notifications, 'toast');
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click();
    item(`Insert copied cells, shifting ${direction}`).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(contentSnapshot(wb)).toEqual(before);
    expect(wb.canUndo()).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('paste limit'), expect.any(Object));
  });

  it.each(['down', 'right'])('inserts enough space for copied cells past the current %s edge', async (direction) => {
    const size = direction === 'down' ? 1000 : 100;
    const values = Array.from({ length: size }, (_, i) => ({ v: i === 0 ? 'First' : i === size - 1 ? 'Last' : 'Middle' }));
    const cells = direction === 'down' ? values.map((cell) => [cell]) : [values];
    const html = stampClipboardHtml(`<table data-spreadsheet-cells='${JSON.stringify(cells)}'></table>`);
    vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: ['text/html', 'text/plain'], getType: async (type) => ({ text: async () => type === 'text/html' ? html : 'First\nSecond' }) }] } });
    const { doc } = setup();
    const wb = doc.wb, id = wb.activeSheetId;
    const r = direction === 'down' ? 99 : 0, c = direction === 'right' ? 25 : 0;
    wb.setInput(id, r, c, 'Keep');
    wb.setNote(id, r, c, 'Keep note');
    wb.setInput(id, 1, 1, direction === 'down' ? '=A100' : '=Z1');
    const nameBox = view.el.querySelector('.name-box');
    nameBox.value = direction === 'down' ? 'A100' : 'Z1';
    nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    wb.clearHistory();
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click();
    item(`Insert copied cells, shifting ${direction}`).click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, r, c)).toBe('First');
    expect(wb.getValue(id, r + (direction === 'down' ? size - 1 : 0), c + (direction === 'right' ? size - 1 : 0))).toBe('Last');
    const rr = r + (direction === 'down' ? size : 0), cc = c + (direction === 'right' ? size : 0);
    expect(wb.getValue(id, rr, cc)).toBe('Keep');
    expect(wb.getNote(id, rr, cc)).toBe('Keep note');
    expect(wb.getValue(id, 1, 1)).toBe('Keep');
    expect(wb.undoLabels()).toEqual(['Insert copied cells']);
    wb.undo(); expect(wb.getValue(id, r, c)).toBe('Keep');
    wb.redo(); expect(wb.getValue(id, rr, cc)).toBe('Keep');
  });

  it.each([
    ['uneven rows', 'A\nB\tC\tD', [['A', 'B'], [null, 'C'], [null, 'D']]],
    ['rectangular rows', 'A\tB\nC\tD', [['A', 'C'], ['B', 'D']]],
  ])('keeps every cell when transposing %s from plain text', async (_, text, expected) => {
    vi.stubGlobal('navigator', { onLine: true, clipboard: { readText: vi.fn().mockResolvedValue(text) } });
    const { doc } = setup();
    const wb = doc.wb;
    const id = wb.activeSheetId;
    view.el.querySelector('[data-menu="edit"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label);
    item('Paste special').click();
    item('Transposed').click();
    await vi.advanceTimersByTimeAsync(1);
    for (let r = 0; r < expected.length; r++) {
      for (let c = 0; c < expected[r].length; c++) expect(wb.getValue(id, r, c)).toBe(expected[r][c]);
    }
    expect(view.el.querySelector('.name-box').value).toBe(`A1:B${expected.length}`);
    wb.undo();
    expect(wb.getValue(id, 0, 0)).toBeNull();
    expect(wb.getValue(id, expected.length - 1, 1)).toBeNull();
    wb.redo();
    expect(wb.getValue(id, expected.length - 1, 1)).toBe('D');
  });

  it('finishes a large plain-text paste without overflowing the argument stack', async () => {
    const { doc } = setup();
    const wb = doc.wb;
    const id = wb.activeSheetId;
    const viewport = view.el.querySelector('[role="grid"]');
    viewport.focus();
    const count = 150000;
    const text = '1\t3\n'.repeat(count - 1) + '2\t3';
    const errors = [];
    const onError = (e) => { errors.push(e.error); e.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: (type) => type === 'text/plain' ? text : '' } });
      viewport.dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(1);
      expect(errors).toEqual([]);
      // Every row lands: the grid has all 1,048,576 rows.
      expect(wb.getValue(id, count - 1, 0)).toBe(2);
      expect(wb.getValue(id, count - 1, 1)).toBe(3);
      expect(view.el.querySelector('.name-box').value).toBe(`A1:B${count}`);
      wb.undo();
      expect(wb.getValue(id, 0, 0)).toBeNull();
      expect(wb.getValue(id, count - 1, 1)).toBeNull();
      wb.redo();
      expect(wb.getValue(id, count - 1, 1)).toBe(3);
    } finally {
      window.removeEventListener('error', onError);
    }
  });

  it.each(['same target', 'selection', 'sheet', 'edit', 'closed'])('handles delayed clipboard reads safely after %s', async (change) => {
    let resolve;
    const readText = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal('navigator', { onLine: true, clipboard: { readText } });
    const { doc } = setup();
    const wb = doc.wb;
    const originalSheet = wb.activeSheetId;
    view.el.querySelector('[data-menu="edit"]').click();
    [...document.querySelectorAll('.menu-item')].find((button) => button.querySelector('.menu-label')?.textContent === 'Paste').click();
    expect(readText).toHaveBeenCalledOnce();
    if (change === 'selection') view.goTo('B2');
    if (change === 'sheet') wb.addSheet('Another');
    if (change === 'edit') wb.setInput(originalSheet, 0, 0, 'Newer edit');
    if (change === 'closed') { view.destroy(); view = null; }
    resolve('Clipboard value');
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(originalSheet, 0, 0)).toBe(change === 'same target' ? 'Clipboard value' : change === 'edit' ? 'Newer edit' : null);
    expect(wb.getValue(wb.activeSheetId, 1, 1)).toBeNull();
    if (change === 'sheet') expect(wb.getValue(wb.activeSheetId, 0, 0)).toBeNull();
    if (change === 'same target') { wb.undo(); expect(wb.getValue(originalSheet, 0, 0)).toBeNull(); }
  });

  it('pastes visible text when embedded spreadsheet metadata has an invalid row', () => {
    const { doc } = setup();
    const viewport = view.el.querySelector('[role="grid"]');
    viewport.focus();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    const html = stampClipboardHtml(`<table data-spreadsheet-cells='[[{"v":"Wrong value"}],null]'><tr><td>Visible value</td></tr></table>`);
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type) => type === 'text/html' ? html : 'Visible value' } });
    viewport.dispatchEvent(event);
    expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('Visible value');
    doc.wb.undo();
    expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBeNull();
  });
});

it.each(['spans', 'embedded cells'])('refuses oversized HTML %s without edits and permits a smaller retry', async (source) => {
  const { doc } = setup();
  const wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 1, 1, 'Keep this');
  view.goTo('B2');
  await vi.advanceTimersByTimeAsync(1);
  wb.clearHistory();
  const before = contentSnapshot(wb);
  const notify = vi.spyOn(notifications, 'toast');
  const viewport = view.el.querySelector('[role="grid"]');
  viewport.focus();
  const paste = (html) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type) => type === 'text/html' ? html : 'Fallback text' } });
    viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  const html = source === 'spans'
    ? `<table><tr><td colspan="1000" rowspan="0">Value</td></tr>${'<tr></tr>'.repeat(200)}</table>`
    : stampClipboardHtml(`<table data-spreadsheet-cells='${JSON.stringify(Array.from({ length: 201 }, () => Array(1000).fill(null)))}'><tr><td>Fallback text</td></tr></table>`);
  paste(html);
  expect(contentSnapshot(wb)).toEqual(before);
  expect(wb.canUndo()).toBe(false);
  expect(view.el.querySelector('.name-box').value).toBe('B2');
  expect(notify.mock.calls.some(([message]) => /too large.*200,000/i.test(message))).toBe(true);
  paste('<table><tr><td>Accepted</td></tr></table>');
  expect(wb.getValue(id, 1, 1)).toBe('Accepted');
  wb.undo();
  expect(wb.getValue(id, 1, 1)).toBe('Keep this');
});

describe('draft recovery dialog', () => {
  it('keeps recovery available when the dialog is dismissed', async () => {
    const { doc } = setup({ recoverable: { savedAt: Date.now(), workbook: {} } });
    const discard = vi.spyOn(doc, 'discardDraft');
    await vi.advanceTimersByTimeAsync(250);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(discard).not.toHaveBeenCalled();
    expect(doc.recoverable).toBeTruthy();
  });

  it('does not open a recovery prompt after the editor is destroyed', async () => {
    setup({ recoverable: { savedAt: Date.now(), workbook: {} } });
    view.destroy();
    view = null;
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector('.modal-root')).toBeNull();
  });
});

describe('moving between editor regions', () => {
  const press = (key, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return event;
  };

  it('lets F6 leave the grid and Shift+F6 return without moving the selected cell', () => {
    setup();
    const grid = view.el.querySelector('[role="grid"]');
    grid.focus();
    expect(press('F6').defaultPrevented).toBe(true);
    expect(document.activeElement.closest('.sheet-tabs')).not.toBeNull();
    press('F6', true);
    expect(document.activeElement).toBe(grid);
    press('F6', true);
    expect(document.activeElement).toBe(view.el.querySelector('.name-box'));
    expect(view.el.querySelector('.name-box').value).toBe('A1');
  });

  it('cycles through enabled controls and skips hidden regions', () => {
    setup();
    view.el.querySelector('.toolbar').hidden = true;
    const title = view.el.querySelector('.menubar [tabindex="0"]');
    title.focus();
    press('F6');
    expect(document.activeElement).toBe(view.el.querySelector('.name-box'));
  });
});

it.each(['g', 'k', 'f', 'h', 'PageDown'])('returns a rejected edit through Stop instead of running %s', async (key) => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.addSheet('Other');
  wb.setActiveSheet(id);
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: 'Yes,No', strict: true });
  const grid = view.el.querySelector('[role="grid"]');
  grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
  await retryStop(editor);
  expect(document.activeElement).toBe(editor);
  expect(editor.hidden).toBe(false);
  expect(wb.activeSheetId).toBe(id);
  expect(wb.getValue(id, 0, 0)).toBeNull();
});

it.each(['=1+1', "'Quarter 1"])(
  'inserts dropdown label %s as text without evaluating it or removing its apostrophe', async (label) => {
    const { doc } = setup();
    const wb = doc.wb;
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Previous');
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    wb.setCells(id, [
      { r: 0, c: 2, cell: { v: label, f: null } },
      { r: 1, c: 2, cell: { v: 42, f: null } },
    ]);
    wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, source: 'C1:C2', strict: true });
    wb.clearHistory();
    const pick = async (text) => {
      const grid = view.el.querySelector('[role="grid"]');
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(1);
      const option = [...document.querySelectorAll('[aria-label="Choose a value"] button')]
        .find((button) => button.querySelector('.menu-label')?.textContent === text);
      expect(option).toBeTruthy();
      option.click();
      await vi.advanceTimersByTimeAsync(1);
    };
    await pick(label);
    expect(wb.getCell(id, 0, 0)).toMatchObject({ v: label, f: null, s: { bold: true } });
    expect(wb.getValue(id, 0, 0)).toBe(label);
    expect(wb.validateCell(id, 0, 0).ok).toBe(true);
    wb.undo();
    expect(wb.getValue(id, 0, 0)).toBe('Previous');
    wb.redo();
    expect(wb.getValue(id, 0, 0)).toBe(label);
    await pick('42');
    expect(wb.getValue(id, 0, 0)).toBe(42);
    expect(wb.getCell(id, 0, 0).s).toEqual({ bold: true });
  },
);

it.each([
  ['00123', 'en-US'], ['1/2', 'en-US'], ['FALSE', 'en-US'],
  [1.25, 'de-DE'], [false, 'en-US'], [' 12 ', 'en-US'],
].flatMap(([value, locale]) => [[value, locale, 'range'], [value, locale, 'literal']]))('preserves the source value %s when choosing a dropdown in %s from %s options', async (value, locale, sourceType) => {
  const { setLocale } = await import('../src/core/format.js');
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 2, cell: { v: value, f: null } }]);
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, source: sourceType === 'range' ? 'C1:C1' : [value], strict: true });
  setLocale(locale);
  try {
    const grid = view.el.querySelector('[role="grid"]');
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
    document.querySelector('[aria-label="Choose a value"] button').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(wb.getValue(id, 0, 0)).toBe(value);
    expect(wb.getCell(id, 0, 0).f).toBeNull();
    expect(wb.validateCell(id, 0, 0).ok).toBe(true);
    wb.undo();
    expect(wb.getValue(id, 0, 0)).toBeNull();
    wb.redo();
    expect(wb.getValue(id, 0, 0)).toBe(value);
  } finally { setLocale('en-US'); }
});

it.each([
  ['1/2', 'en-US', '1/2'],
  ['10%', 'en-US', '10%'],
  ['10%', 'en-US', '10%', '0.1'],
  ['12:30', 'en-US', '12:30'],
  ['1.25', 'de-DE', '1.25'],
  ['42', 'en-US', 42],
  ['FALSE', 'en-US', false],
])('keeps manually listed option %s valid when selected in %s', async (label, locale, expected, another = 'Other') => {
  const { setLocale } = await import('../src/core/format.js');
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, source: `${label},${another}`, strict: true });
  setLocale(locale);
  try {
    const grid = view.el.querySelector('[role="grid"]');
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
    const option = [...document.querySelectorAll('[aria-label="Choose a value"] button')]
      .find((button) => button.querySelector('.menu-label')?.textContent === label);
    option.click();
    expect(wb.validateCell(id, 0, 0).ok).toBe(true);
    expect(wb.getValue(id, 0, 0)).toBe(expected);
    wb.undo();
    expect(wb.getValue(id, 0, 0)).toBeNull();
    wb.redo();
    expect(wb.getValue(id, 0, 0)).toBe(expected);
  } finally { setLocale('en-US'); }
});

it.each([
  ['42', 42, { fmt: 'currency' }, false],
  ['0.5', 0.5, { fmt: 'percent' }, false],
  ['42.0', 42, { fmt: 'number', dec: 2 }, false],
  ['42', 42, { fmt: 'custom', code: ';;;' }, false],
  ['42', 42, { fmt: 'custom', code: ';;;' }, true],
])('marks and clears stored dropdown option %s regardless of its formatting (%j, %j, typed=%s)', async (label, value, style, typed) => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: value, f: null, s: style } }]);
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, source: typed ? [value, 'Other'] : `${label},Other` });
  const grid = view.el.querySelector('[role="grid"]');
  grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const menu = document.querySelector('[aria-label="Choose a value"]');
  const checked = [...menu.querySelectorAll('[aria-checked="true"]')];
  expect(checked).toHaveLength(1);
  expect(checked[0].querySelector('.menu-label').textContent).toBe(label);
  const clear = [...menu.querySelectorAll('button')].find((button) => button.querySelector('.menu-label')?.textContent === 'Clear');
  expect(clear).toBeTruthy();
  clear.click();
  expect(wb.getValue(id, 0, 0)).toBeNull();
  wb.undo();
  expect(wb.getValue(id, 0, 0)).toBe(value);
  expect(wb.getCell(id, 0, 0).s).toEqual(style);
});

it.each([
  ['', null], ['=1/0', null], ['Unlisted', null], ['42', '42'], ["'42.0", '42.0'],
])('marks only the matching dropdown option for input %s', async (input, expected) => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, input);
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, source: '42.0,42,Other' });
  view.el.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const checked = [...document.querySelectorAll('[aria-label="Choose a value"] [aria-checked="true"]')];
  expect(checked.map((node) => node.querySelector('.menu-label').textContent)).toEqual(expected ? [expected] : []);
});

it('finds and selects dropdown values beyond the first 200 options', async () => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, source: Array.from({ length: 405 }, (_, i) => `Option ${i}`) });
  const grid = view.el.querySelector('[role="grid"]');
  grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const menu = document.querySelector('[aria-label="Choose a value"]');
  const search = menu.querySelector('[aria-label="Search list options"]');
  expect(search).toBeTruthy();
  expect(menu.querySelectorAll('[role="menuitemcheckbox"]').length).toBeLessThanOrEqual(200);
  search.value = 'Option 404';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  const result = menu.querySelector('[role="menuitemcheckbox"]');
  expect(result.textContent).toBe('Option 404');
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(result);
  result.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(search);
  result.click();
  expect(wb.getValue(id, 0, 0)).toBe('Option 404');
  expect(document.querySelector('[aria-label="Choose a value"]')).toBeNull();
  expect(document.activeElement).toBe(grid);
  wb.undo();
  expect(wb.getValue(id, 0, 0)).toBeNull();
});

it.each([0, 201])('makes text and typed dropdown options independently selectable with %s extra items', async (extra) => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  const choices = [5, '5', true, 'TRUE', false, 'FALSE'];
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, source: [...choices, ...Array.from({ length: extra }, (_, i) => `Item ${i}`)] });
  const grid = view.el.querySelector('[role="grid"]');
  for (const value of choices) {
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
    const menu = document.querySelector('[aria-label="Choose a value"]');
    const options = [...menu.querySelectorAll('[role="menuitemcheckbox"]')];
    expect(options.length).toBeGreaterThanOrEqual(choices.length);
    const checked = options.filter((node) => node.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(value === choices[0] ? 0 : 1);
    const label = typeof value === 'boolean' ? String(value).toUpperCase() : String(value);
    const type = { string: 'Text', number: 'Number', boolean: 'Boolean' }[typeof value];
    const option = options.find((node) => node.getAttribute('aria-label') === `${label} (${type})`);
    expect(option).toBeTruthy();
    expect(option.querySelector('.menu-shortcut').textContent).toBe(type);
    option.click();
    expect(wb.getValue(id, 0, 0)).toBe(value);
  }
  wb.undo();
  expect(wb.getValue(id, 0, 0)).toBe(false);
});

it('lets long dropdowns be browsed in bounded pages and keeps empty searches usable', async () => {
  const { doc } = setup();
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.addValidation(id, { type: 'list', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, source: Array.from({ length: 405 }, (_, i) => `Item ${i}`) });
  const grid = view.el.querySelector('[role="grid"]');
  grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  const menu = document.querySelector('[aria-label="Choose a value"]');
  const button = (label) => [...menu.querySelectorAll('button')].find((node) => node.textContent === label);
  expect(button('Next options')).toBeTruthy();
  button('Next options').click();
  expect(menu.querySelector('[role="menuitemcheckbox"]').textContent).toBe('Item 200');
  button('Next options').click();
  expect(menu.querySelector('[role="menuitemcheckbox"]').textContent).toBe('Item 400');
  expect(menu.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(5);
  button('Previous options').click();
  expect(menu.querySelector('[role="menuitemcheckbox"]').textContent).toBe('Item 200');
  const search = menu.querySelector('[aria-label="Search list options"]');
  search.value = 'no match';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(menu.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(0);
  expect(menu.textContent).toContain('No matching options');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(menu.querySelector('[role="menuitemcheckbox"]').textContent).toBe('Item 0');
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(document.querySelector('[aria-label="Choose a value"]')).toBeNull();
});

describe('keys pressed away from the cell during an edit', () => {
  const beginTyping = () => {
    view.el.querySelector('[role="grid"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
    const editor = view.el.querySelector('.grid-editor');
    expect(document.activeElement).toBe(editor);
    return editor;
  };

  it('sends typing from a focused toolbar button into the cell and lets Escape cancel from there', () => {
    const { doc } = setup();
    const editor = beginTyping();
    const button = view.el.querySelector('.topbar button');
    button.focus();
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(editor);
    button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(editor.hidden).toBe(true);
    expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBeNull();
  });

  it('recovers keys that reach the page itself after the menu opener was re-rendered away', () => {
    const { doc } = setup();
    const editor = beginTyping();
    editor.blur();
    expect(document.activeElement).toBe(document.body);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(editor);
    editor.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(editor.hidden).toBe(true);
    expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBeNull();
  });

  it('stops listening for stray keys once the editor is gone', () => {
    setup();
    beginTyping();
    const editor = view.el.querySelector('.grid-editor');
    editor.blur();
    view.destroy();
    view = null;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(document.body);
  });
});
