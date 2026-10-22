// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import { heightForLines } from '../src/core/textfit.js';

/** The height a row fitted to one line of 13px text takes (never less than the default row). */
const ONE_LINE = heightForLines(1, 13, DEFAULT_ROW_HEIGHT);

// jsdom has no layout: give the viewport a size and a no-op canvas.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});

const flush = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, 'Name');
  wb.setInput(id, 0, 1, 'Qty');
  wb.setInput(id, 1, 0, 'Apples');
  wb.setInput(id, 1, 1, '3');
  wb.setInput(id, 2, 1, '=B2*2');
  const announced = [];
  const commands = [];
  const grid = createGrid({ wb, sheetId: id, announce: (t) => announced.push(t), onCommand: (c) => commands.push(c) });
  document.body.replaceChildren(grid.el);
  return { wb, id, grid, announced, commands };
}

const key = (target, key, init = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));

describe('grid', () => {
  it('draws sheet alignment defaults without requiring a Normal font or line style', async () => {
    const { wb, id, grid } = setup();
    try {
      wb.sheet(id).defaultVAlign = 'top';
      wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Inherited alignment' } }]);
      await flush();
      expect(grid.el.querySelector('#gc-0-0').classList.contains('vt')).toBe(true);
      expect(grid.el.querySelector('#gc-3-0').classList.contains('vt')).toBe(true);
    } finally { grid.destroy(); }
  });

  it.each(['A1048577', 'XFE1', 'A1:XFE20001', 'XFD1048577'])(
    'rejects navigation to %s without partial growth or selection', (address) => {
      const { grid, wb, id } = setup();
      try {
        grid.selectByName('C3:D4');
        const size = [wb.sheet(id).rows, wb.sheet(id).cols], range = grid.range;
        expect(grid.selectByName(address)).toBe(false);
        expect([wb.sheet(id).rows, wb.sheet(id).cols]).toEqual(size);
        expect(grid.range).toEqual(range);
      } finally { grid.destroy(); }
    },
  );

  it.each(['<img src=x onerror=alert(1)>', true, false])('renders custom text labels and their section color as plain text for %s', async (raw) => {
    const { wb, id, grid } = setup();
    try {
      wb.setInput(id, 0, 0, raw);
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'custom', code: '[Blue]0;0;0;[Red]"Label: "@', color: '#123456' });
      await flush();
      const cell = grid.el.querySelector('#gc-0-0');
      expect(cell.textContent).toBe(`Label: ${typeof raw === 'boolean' ? String(raw).toUpperCase() : raw}`);
      expect(cell.style.color).toBe('rgb(255, 0, 0)');
      expect(cell.querySelector('img')).toBeNull();
      grid.beginEdit();
      expect(grid.el.querySelector('.grid-editor').value).toBe(typeof raw === 'boolean' ? String(raw).toUpperCase() : raw);
    } finally { grid.destroy(); }
  });

  it('preserves the chosen font color when a custom format contains a quoted color name', async () => {
    const { wb, id, grid } = setup();
    try {
      wb.setInput(id, 0, 0, '5');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'custom', code: '"[Red] "0', color: '#123456' });
      await flush();
      const cell = grid.el.querySelector('#gc-0-0');
      expect(cell.textContent).toBe('[Red] 5');
      expect(cell.style.color).toBe('rgb(18, 52, 86)');
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { code: '[Blue]"[Red] "0' });
      await flush();
      expect(grid.el.querySelector('#gc-0-0').style.color).toBe('rgb(0, 0, 255)');
    } finally { grid.destroy(); }
  });

  it('opens and commits imported multiline text beyond the engine argument limit', () => {
    const { wb, id, grid } = setup();
    const value = `${'x\n'.repeat(149999)}Last line`;
    const json = wb.toJSON();
    json.sheets[0].cells['0,0'] = { v: value };
    wb.replaceWith(json); // loaded from a file: longer than any entry may be
    try {
      expect(() => grid.beginEdit()).not.toThrow();
      const editor = grid.el.querySelector('.grid-editor');
      expect(editor.value).toBe(value);
      expect(Number.parseFloat(editor.style.width)).toBeGreaterThan(0);
      expect(Number.parseFloat(editor.style.width)).toBeLessThanOrEqual(800);
      grid.commitEdit();
      expect(wb.getValue(id, 0, 0)).toBe(value);
      expect(grid.editing).toBe(false);
    } finally { grid.destroy(); }
  });

  it('renders large merged ranges without allocating an entry for every covered cell', () => {
    const wb = new Workbook({ sheets: [{ name: 'Large merge', rows: 20000, cols: 702,
      cells: { '0,0': { v: 'Merged title', f: null } },
      merges: [{ r1: 0, c1: 0, r2: 19999, c2: 701 }],
    }] });
    const frames = [];
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    let entries = 0;
    const originalSet = Map.prototype.set;
    const set = vi.spyOn(Map.prototype, 'set').mockImplementation(function (key, value) {
      if (typeof key === 'string' && /^\d+,\d+$/.test(key) && ++entries > 2000) throw new Error('Enumerated offscreen merged cells');
      return originalSet.call(this, key, value);
    });
    let grid;
    try {
      grid = createGrid({ wb, sheetId: wb.activeSheetId });
      document.body.replaceChildren(grid.el);
      while (frames.length) frames.shift()();
      expect(grid.el.querySelector('#gc-0-0').textContent).toBe('Merged title');
      expect(grid.el.querySelector('#gc-1-1')).toBeNull();
      grid.viewport.scrollTop = 500;
      grid.viewport.dispatchEvent(new Event('scroll'));
      while (frames.length) frames.shift()();
      expect(grid.el.querySelector('#gc-0-0').textContent).toBe('Merged title');
      expect(entries).toBeLessThan(2000);
    } finally {
      set.mockRestore();
      grid?.destroy();
      globalThis.requestAnimationFrame = previousRaf;
    }
  });

  it('shows unsafe hyperlink labels without a clickable URL', async () => {
    const { wb, id, grid } = setup();
    try {
      wb.setLink(id, 0, 0, 'javascript:alert(1)', 'Untrusted link');
      await flush();
      expect(grid.el.querySelector('#gc-0-0').textContent).toBe('Untrusted link');
      expect(grid.el.querySelector('#gc-0-0').classList.contains('link')).toBe(false);
      expect(grid.el.querySelector('.link-pop').hidden).toBe(true);
      expect(grid.el.querySelector('.link-pop-url').getAttribute('href')).toBeNull();
    } finally { grid.destroy(); }
  });

  it('renders visible cells with values and roles', async () => {
    const { grid } = setup();
    await flush();
    const a1 = grid.el.querySelector('#gc-0-0');
    expect(a1).not.toBeNull();
    expect(a1.textContent).toBe('Name');
    expect(a1.getAttribute('role')).toBe('gridcell');
    expect(grid.el.querySelector('#gc-2-1').textContent).toBe('6');
    expect(grid.viewport.getAttribute('aria-activedescendant')).toBe('gc-0-0');
    expect(grid.viewport.getAttribute('aria-rowcount')).toBe('100');
  });

  it('renders spilled array results in blank cells', async () => {
    const { wb, id, grid } = setup();
    wb.setInput(id, 4, 0, '=SEQUENCE(3)');
    await flush();
    expect(grid.el.querySelector('#gc-4-0').textContent).toBe('1');
    const spilled = grid.el.querySelector('#gc-6-0');
    expect(spilled.textContent).toBe('3');
    expect(spilled.classList.contains('arr')).toBe(true);
    expect(grid.el.querySelector('#gc-7-0').textContent).toBe('');
  });

  it('renders a cell font family', async () => {
    const { wb, id, grid } = setup();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { font: 'georgia' });
    await flush();
    expect(grid.el.querySelector('#gc-0-0').style.fontFamily).toContain('Georgia');
    expect(grid.el.querySelector('#gc-0-1').style.fontFamily).toBe('');
  });

  it('completes typed text from the column and lets Enter keep it', async () => {
    const { wb, id, grid } = setup();
    await flush();
    grid.setSelection({ active: { r: 2, c: 0 }, anchor: { r: 2, c: 0 }, focus: { r: 2, c: 0 } });
    key(grid.viewport, 'A');
    const editor = grid.el.querySelector('.grid-editor');
    expect(editor.hidden).toBe(false);
    editor.value = 'Ap';
    editor.setSelectionRange(2, 2);
    editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'p', bubbles: true }));
    expect(editor.value).toBe('Apples');
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(6);
    expect(grid.editState.text).toBe('Apples');
    key(editor, 'Enter');
    expect(wb.getValue(id, 2, 0)).toBe('Apples');
    // Deleting the suggestion is not undone by another suggestion.
    grid.setSelection({ active: { r: 3, c: 0 }, anchor: { r: 3, c: 0 }, focus: { r: 3, c: 0 } });
    key(grid.viewport, 'A');
    editor.value = 'A';
    editor.setSelectionRange(1, 1);
    editor.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
    expect(editor.value).toBe('A');
    key(editor, 'Escape');
  });

  it('shows formulas instead of values on request', async () => {
    const { grid } = setup();
    await flush();
    grid.setShowFormulas(true);
    await flush();
    const cell = grid.el.querySelector('#gc-2-1');
    expect(cell.textContent).toBe('=B2*2');
    expect(cell.classList.contains('formula-text')).toBe(true);
    expect(grid.el.querySelector('#gc-1-1').textContent).toBe('3');
    grid.setShowFormulas(false);
    await flush();
    expect(grid.el.querySelector('#gc-2-1').textContent).toBe('6');
  });

  it('cycles reference anchors with F4 while editing', async () => {
    const { grid } = setup();
    await flush();
    grid.beginEdit({ text: '=SUM(A1:B2)+C3', mode: 'inplace' });
    const editor = grid.el.querySelector('.grid-editor');
    editor.setSelectionRange(8, 8); // inside A1:B2
    key(editor, 'F4');
    expect(grid.editState.text).toBe('=SUM($A$1:$B$2)+C3');
    key(editor, 'F4');
    expect(grid.editState.text).toBe('=SUM(A$1:B$2)+C3');
    key(editor, 'F4');
    expect(grid.editState.text).toBe('=SUM($A1:$B2)+C3');
    key(editor, 'F4');
    expect(grid.editState.text).toBe('=SUM(A1:B2)+C3');
    editor.setSelectionRange(editor.value.length, editor.value.length); // after C3
    key(editor, 'F4');
    expect(grid.editState.text).toBe('=SUM(A1:B2)+$C$3');
    key(editor, 'Escape');
  });

  it('maps hide, insert, delete, and sheet shortcuts to commands', async () => {
    const { grid, commands } = setup();
    await flush();
    const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true };
    key(grid.viewport, '9', { ...mod, code: 'Digit9' });
    key(grid.viewport, '0', { ...mod, code: 'Digit0', shiftKey: true });
    key(grid.viewport, '=', { ...mod, shiftKey: true });
    key(grid.viewport, '-', mod);
    key(grid.viewport, 'PageDown', mod);
    key(grid.viewport, '`', mod);
    // On a single cell, Ctrl+Shift+= and Ctrl+- ask how the cells should move.
    expect(commands.slice(-6)).toEqual(['hide', 'unhide', 'insertDialog', 'deleteDialog', 'sheet', 'showFormulas']);
  });

  it('opens the replacement picker, not the chart dialog, when Enter is pressed on a selected picture', async () => {
    const { wb, id, grid, commands } = setup();
    const imageId = wb.addChart(id, { type: 'image', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', title: 'logo.gif', anchor: { r: 1, c: 2 }, w: 120, h: 80 });
    await flush();
    grid.selectChart(imageId);
    await flush();
    key(grid.viewport, 'Enter');
    // The same command a double-click on the picture sends; a chart still opens its dialog.
    expect(commands.at(-1)).toBe('replaceImage');
  });

  it('renders charts as floating boxes and lets the keyboard edit or delete a selected one', async () => {
    const { wb, id, grid, commands } = setup();
    const chartId = wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 2, c2: 1 }, title: 'Stock', anchor: { r: 1, c: 2 }, dx: 10, dy: 5, w: 300, h: 200 });
    await flush();
    const box = grid.el.querySelector('.chart-box');
    expect(box).not.toBeNull();
    expect(box.style.transform).toBe(`translate(210px, ${Math.round(DEFAULT_ROW_HEIGHT) + 5}px)`); // C2 plus the offset
    expect(box.style.width).toBe('300px');
    expect(box.querySelector('svg')).not.toBeNull();
    expect(box.textContent).toContain('Stock');
    grid.selectChart(chartId);
    await flush();
    expect(box.classList.contains('selected')).toBe(true);
    key(grid.viewport, 'Enter');
    expect(commands.at(-1)).toBe('editChart');
    key(grid.viewport, 'Delete');
    expect(commands.at(-1)).toBe('deleteChart');
    // Dragging the box moves the chart to a new anchor cell and offset.
    const pe = (type, x, y) => box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, button: 0, pointerType: 'mouse' }));
    pe('pointerdown', 250, 60);
    pe('pointermove', 450, 68 + 2 * Math.round(DEFAULT_ROW_HEIGHT));
    pe('pointerup', 450, 68 + 2 * Math.round(DEFAULT_ROW_HEIGHT));
    const moved = wb.chartById(id, chartId);
    expect(moved.anchor).toEqual({ r: 3, c: 4 }); // Move two columns and two rows, plus 8px vertically.
    expect(moved.dx).toBe(10);
    expect(moved.dy).toBe(13);
    expect(wb.undoLabel()).toBe('Move chart');
    wb.deleteChart(id, chartId);
    await flush();
    expect(grid.el.querySelector('.chart-box')).toBeNull();
  });

  it('refreshes an image when its replacement has the same encoded length and name', async () => {
    const { wb, id, grid } = setup();
    const image = (color) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="${color}"/></svg>`)}`;
    const before = image('#ff0000');
    const after = image('#0000ff');
    expect(before.length).toBe(after.length);
    try {
      const imageId = wb.addChart(id, { type: 'image', src: before, title: 'logo.svg', anchor: { r: 0, c: 2 } });
      await flush();
      const picture = () => grid.el.querySelector('.image-box img');
      expect(picture().getAttribute('src')).toBe(before);
      wb.updateChart(id, imageId, { src: after }, 'Replace image');
      await flush();
      expect(picture().getAttribute('src')).toBe(after);
      wb.undo();
      await flush();
      expect(picture().getAttribute('src')).toBe(before);
      wb.redo();
      await flush();
      expect(picture().getAttribute('src')).toBe(after);
      const rendered = picture();
      wb.setInput(id, 0, 0, 'Unrelated edit');
      await flush();
      expect(picture()).toBe(rendered);
    } finally { grid.destroy(); }
  });

  it('draws SPARKLINE results inside the cell', async () => {
    const { wb, id, grid } = setup();
    wb.setInput(id, 5, 0, '=SPARKLINE(B2:B3,"column")');
    await flush();
    const cell = grid.el.querySelector('#gc-5-0');
    expect(cell.classList.contains('sparkline')).toBe(true);
    expect(cell.querySelector('svg rect')).not.toBeNull();
    expect(wb.getDisplay(id, 5, 0)).toBe('');
  });

  it('indents text away from its aligned edge', async () => {
    const { wb, id, grid } = setup();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { indent: 2 });
    wb.applyStyle(id, { r1: 1, c1: 1, r2: 1, c2: 1 }, { indent: 1 }); // a number: right-aligned
    await flush();
    expect(grid.el.querySelector('#gc-0-0').style.paddingLeft).toBe('26px');
    expect(grid.el.querySelector('#gc-1-1').style.paddingRight).toBe('14px');
    expect(grid.el.querySelector('#gc-1-1').style.paddingLeft).toBe('');
  });

  it.each(['calibri', 'arial'])('keeps indented %s labels clear of filter and inline chip buttons at every zoom', async font => {
    const { wb, id, grid } = setup();
    try {
      wb.setFilterRange(id, { r1: 0, c1: 0, r2: 2, c2: 1 });
      wb.addValidation(id, { range: { r1: 1, c1: 1, r2: 1, c2: 1 }, type: 'list', source: '3, 6', chips: true });
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 1 }, { font, align: 'right', indent: 1 });
      for (const zoom of [0.5, 1, 2]) {
        grid.setZoom(zoom);
        await flush();
        expect(parseFloat(grid.el.querySelector('#gc-0-0').style.paddingRight)).toBeGreaterThanOrEqual(18 + 2 * zoom);
        expect(parseFloat(grid.el.querySelector('#gc-1-1').style.paddingRight)).toBeGreaterThanOrEqual(16 + 2 * zoom);
      }
      grid.setZoom(1);
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { indent: 3 });
      await flush();
      expect(grid.el.querySelector('#gc-0-0').style.paddingRight).toBe('38px');
      // Removing the control restores the ordinary indentation without changing the style.
      wb.clearFilter(id);
      await flush();
      expect(grid.el.querySelector('#gc-0-1').style.paddingRight).toBe('14px');
      expect(wb.styleAt(id, 0, 1).indent).toBe(1);
    } finally { grid.destroy(); }
  });

  it('moves with the keyboard and announces the new cell', async () => {
    const { grid, announced } = setup();
    await flush();
    key(grid.viewport, 'ArrowDown');
    key(grid.viewport, 'ArrowRight');
    expect(grid.active).toEqual({ r: 1, c: 1 });
    expect(announced.at(-1)).toBe('B2, 3');
    key(grid.viewport, 'ArrowRight', { shiftKey: true });
    expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 1, c2: 2 });
    expect(announced.at(-1)).toMatch(/^B2:C2 selected/);
    key(grid.viewport, 'Enter'); // inside a range, Enter walks the range
    expect(grid.active).toEqual({ r: 1, c: 2 });
    key(grid.viewport, 'Home', { ctrlKey: true, metaKey: true });
    expect(grid.active).toEqual({ r: 0, c: 0 });
  });

  it('starts editing on a printable key and commits on Enter', async () => {
    const { grid, wb, id } = setup();
    await flush();
    grid.setSelection({ active: { r: 4, c: 0 }, anchor: { r: 4, c: 0 }, focus: { r: 4, c: 0 } });
    key(grid.viewport, '7');
    expect(grid.editing).toBe(true);
    expect(grid.editState.text).toBe('7');
    const editor = grid.el.querySelector('.grid-editor');
    editor.value = '75';
    editor.dispatchEvent(new Event('input'));
    key(editor, 'Enter');
    expect(grid.editing).toBe(false);
    expect(wb.getValue(id, 4, 0)).toBe(75);
    expect(grid.active).toEqual({ r: 5, c: 0 });
  });

  it('cancels an edit with Escape without changing the cell', async () => {
    const { grid, wb, id } = setup();
    await flush();
    grid.setSelection({ active: { r: 1, c: 0 }, anchor: { r: 1, c: 0 }, focus: { r: 1, c: 0 } });
    key(grid.viewport, 'F2');
    expect(grid.editState.text).toBe('Apples');
    const editor = grid.el.querySelector('.grid-editor');
    editor.value = 'Pears';
    editor.dispatchEvent(new Event('input'));
    key(editor, 'Escape');
    expect(wb.getValue(id, 1, 0)).toBe('Apples');
  });

  it('forwards clear, undo, save, and format shortcuts to the host', async () => {
    const wb = new Workbook();
    const seen = [];
    const grid = createGrid({ wb, sheetId: wb.sheets[0].id, onCommand: (c, a) => seen.push(a === undefined ? c : `${c}:${a}`) });
    document.body.replaceChildren(grid.el);
    await flush();
    key(grid.viewport, 'Delete');
    key(grid.viewport, 'z', { ctrlKey: true, metaKey: true });
    key(grid.viewport, 's', { ctrlKey: true, metaKey: true });
    key(grid.viewport, '5', { ctrlKey: true, metaKey: true });
    key(grid.viewport, '%', { ctrlKey: true, metaKey: true, shiftKey: true });
    key(grid.viewport, '$', { ctrlKey: true, metaKey: true, shiftKey: true });
    key(grid.viewport, '~', { ctrlKey: true, metaKey: true, shiftKey: true });
    key(grid.viewport, ':', { ctrlKey: true, metaKey: true, shiftKey: true });
    key(grid.viewport, ';', { ctrlKey: true, metaKey: true });
    key(grid.viewport, 'L', { ctrlKey: true, metaKey: true, shiftKey: true });
    expect(seen).toEqual(['clear', 'undo', 'save', 'strike', 'fmt:percent', 'fmt:currency', 'fmt:general', 'insertTime', 'insertDate', 'filter']);
  });

  it('jumps to a typed reference and grows the sheet when needed', async () => {
    const { grid, wb, id } = setup();
    await flush();
    expect(grid.selectByName('C3:D4')).toBe(true);
    expect(grid.range).toEqual({ r1: 2, c1: 2, r2: 3, c2: 3 });
    expect(grid.selectByName('nonsense')).toBe(false);
    expect(grid.selectByName('A500')).toBe(true);
    expect(wb.sheet(id).rows).toBeGreaterThanOrEqual(500);
  });

  it('re-renders after workbook changes', async () => {
    const { grid, wb, id } = setup();
    await flush();
    wb.setInput(id, 1, 1, '10');
    await flush();
    expect(grid.el.querySelector('#gc-2-1').textContent).toBe('20');
    wb.insertRows(id, 0, 1);
    await flush();
    expect(grid.el.querySelector('#gc-1-0').textContent).toBe('Name');
  });

  it('renders frozen panes as separate layers with copies of the cells', async () => {
    const { grid, wb, id } = setup();
    await flush();
    const rows = grid.el.querySelector('.frz-rows');
    expect(rows.hidden).toBe(true);
    wb.setFrozen(id, 1, 1);
    await flush();
    expect(rows.hidden).toBe(false);
    expect(grid.el.querySelector('.frz-cols').hidden).toBe(false);
    expect(grid.el.querySelector('.frz-corner').hidden).toBe(false);
    expect(rows.querySelector('.cell[data-r="0"][data-c="1"]').textContent).toBe('Qty');
    // Copies carry no ids so the main canvas keeps the only aria target.
    expect(rows.querySelectorAll('[id]').length).toBe(0);
    expect(grid.el.querySelectorAll('#gc-0-0').length).toBe(1);
    expect(grid.el.querySelector('.grid-colhead-frozen .hcell').textContent).toBe('A');
    expect(grid.frozen).toEqual({ rows: 1, cols: 1 });
    wb.setFrozen(id, 0, 0);
    await flush();
    expect(rows.hidden).toBe(true);
  });

  it('collapses hidden columns and steps over them with the keyboard', async () => {
    const { grid, wb, id } = setup();
    await flush();
    wb.setHidden(id, 'col', [1], true);
    await flush();
    expect(grid.el.querySelector('#gc-0-1')).toBeNull();
    expect(grid.el.querySelector('#gc-0-2').style.left).toBe('100px');
    expect(grid.el.querySelector('.grid-colhead .hcell[data-c="2"]').classList.contains('after-hidden')).toBe(true);
    key(grid.viewport, 'ArrowRight');
    expect(grid.active).toEqual({ r: 0, c: 2 });
    key(grid.viewport, 'ArrowLeft');
    expect(grid.active).toEqual({ r: 0, c: 0 });
  });

  it('applies font size and vertical alignment to cells', async () => {
    const { grid, wb, id } = setup();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { size: 20, valign: 'top' });
    await flush();
    const a1 = grid.el.querySelector('#gc-0-0');
    expect(a1.style.fontSize).toBe('20px');
    expect(a1.classList.contains('vt')).toBe(true);
  });

  it('renders a merged block as one spanning anchor and snaps the selection to it', async () => {
    const { grid, wb, id } = setup();
    wb.mergeCells(id, { r1: 0, c1: 0, r2: 1, c2: 1 });
    await flush();
    const anchor = grid.el.querySelector('#gc-0-0');
    expect(anchor.classList.contains('merged')).toBe(true);
    expect(anchor.style.width).toBe('200px');
    expect(anchor.style.height).toBe(`${2 * Math.round(DEFAULT_ROW_HEIGHT)}px`);
    expect(anchor.getAttribute('aria-colspan')).toBe('2');
    expect(grid.el.querySelector('#gc-0-1')).toBeNull();
    expect(grid.el.querySelector('#gc-1-1')).toBeNull();
    grid.setSelection({ active: { r: 1, c: 1 }, anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
    expect(grid.active).toEqual({ r: 0, c: 0 });
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
    key(grid.viewport, 'ArrowRight');
    expect(grid.active).toEqual({ r: 0, c: 2 });
    key(grid.viewport, 'ArrowLeft');
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
    key(grid.viewport, 'ArrowDown');
    expect(grid.active).toEqual({ r: 2, c: 0 });
  });

  it('marks noted cells and shows the active cell note', async () => {
    const { grid, wb, id } = setup();
    wb.setNote(id, 1, 0, 'Fresh today');
    await flush();
    const cell = grid.el.querySelector('#gc-1-0');
    expect(cell.classList.contains('has-note')).toBe(true);
    expect(cell.title).toBe('Fresh today');
    const pop = grid.el.querySelector('.note-pop');
    expect(pop.hidden).toBe(true);
    grid.setSelection({ active: { r: 1, c: 0 }, anchor: { r: 1, c: 0 }, focus: { r: 1, c: 0 } });
    await flush();
    expect(pop.hidden).toBe(false);
    expect(pop.textContent).toBe('Fresh today');
    key(grid.viewport, 'ArrowDown');
    await flush();
    expect(pop.hidden).toBe(true);
  });

  it('zooms the geometry while sizes stay stored unzoomed', async () => {
    const { grid, wb, id } = setup();
    await flush();
    grid.setZoom(2);
    await flush();
    expect(grid.zoom).toBe(2);
    expect(grid.el.querySelector('#gc-0-1').style.left).toBe('200px');
    expect(grid.el.querySelector('#gc-0-1').style.width).toBe('200px');
    expect(wb.colWidth(id, 1)).toBe(100);
    grid.setZoom(0.01); // below the lower bound
    expect(grid.zoom).toBe(0.1);
    grid.setZoom(1);
    await flush();
    expect(grid.el.querySelector('#gc-0-1').style.left).toBe('100px');
  });

  it('fits row heights to wrapped text', async () => {
    const { grid, wb, id } = setup();
    wb.setInput(id, 3, 0, 'a fairly long sentence that certainly needs more than one line of space');
    wb.applyStyle(id, { r1: 3, c1: 0, r2: 3, c2: 0 }, { wrap: true });
    await flush();
    grid.autoFitRows(3, 3);
    expect(wb.rowHeight(id, 3)).toBeGreaterThan(ONE_LINE);
    const tall = wb.rowHeight(id, 3);
    // Unwrapped rows are not touched unless forced.
    grid.autoFitRows(1, 1);
    expect(wb.rowHeight(id, 1)).toBe(DEFAULT_ROW_HEIGHT);
    wb.setRowHeight(id, 1, 60);
    grid.autoFitRows(1, 1, { force: true });
    expect(wb.rowHeight(id, 1)).toBe(ONE_LINE);
    wb.undo(); wb.undo(); wb.undo();
    expect(wb.rowHeight(id, 3)).not.toBe(tall);
  });

  it.each([['wrapped', 37], ['multiline', ONE_LINE], ['large', 40], ['empty', DEFAULT_ROW_HEIGHT]])('fits %s content when the row boundary is double-clicked', async (kind, height) => {
    const { grid, wb, id } = setup();
    try {
      if (kind !== 'empty') {
        wb.setInput(id, 3, 0, kind === 'large' ? 'Large' : 'First\nSecond');
        wb.applyStyle(id, { r1: 3, c1: 0, r2: 3, c2: 0 }, kind === 'large' ? { size: 28 } : { wrap: kind === 'wrapped' });
      }
      wb.setRowHeight(id, 3, 100);
      grid.setZoom(1.5);
      await flush();
      grid.el.querySelector('.row-resizer[data-r="3"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      expect(wb.rowHeight(id, 3)).toBe(height);
      wb.undo();
      expect(wb.rowHeight(id, 3)).toBe(100);
      wb.redo();
      expect(wb.rowHeight(id, 3)).toBe(height);
    } finally { grid.destroy(); }
  });

  it.each(['manual', 'filter'].flatMap((hiddenBy) => [false, true].map((force) => [hiddenBy, force])))('preserves rows hidden by %s during autofit (force=%s)', async (hiddenBy, force) => {
    const { grid, wb, id } = setup();
    try {
      wb.setInput(id, 1, 0, 'First\nSecond');
      wb.setInput(id, 2, 0, 'Visible');
      wb.applyStyle(id, { r1: 1, c1: 0, r2: 2, c2: 0 }, { wrap: true });
      wb.setRowHeight(id, 1, 100);
      wb.setRowHeight(id, 2, 90);
      if (hiddenBy === 'manual') wb.setHidden(id, 'row', [1], true);
      else {
        wb.setFilterRange(id, { r1: 0, c1: 0, r2: 2, c2: 1 });
        wb.setFilterCriteria(id, 1, { values: ['6'] });
      }
      await flush();
      expect(wb.isRowHidden(id, 1)).toBe(true);
      expect(wb.isRowHidden(id, 2)).toBe(false);
      wb.clearHistory();
      grid.autoFitRows(1, 2, { force });
      expect(wb.sheet(id).rowHeights.get(1)).toBe(100);
      expect(wb.rowHeight(id, 2)).toBe(ONE_LINE);
      wb.undo();
      expect(wb.sheet(id).rowHeights.get(1)).toBe(100);
      expect(wb.rowHeight(id, 2)).toBe(90);
    } finally { grid.destroy(); }
  });

  it('remembers a values-only paste request until the paste event reads it', async () => {
    const { grid } = setup();
    await flush();
    expect(grid.consumePlainPaste()).toBe(false);
    key(grid.viewport, 'v', { ctrlKey: true, metaKey: true, shiftKey: true });
    expect(grid.consumePlainPaste()).toBe(true);
    expect(grid.consumePlainPaste()).toBe(false);
  });

  it('forwards Alt+= as autosum', async () => {
    const { grid, commands } = setup();
    await flush();
    key(grid.viewport, '=', { altKey: true });
    expect(commands).toEqual(['autosum']);
    expect(grid.editing).toBe(false);
  });

  it('paints conditional formats over cell styles', async () => {
    const { grid, wb, id } = setup();
    wb.applyStyle(id, { r1: 1, c1: 1, r2: 1, c2: 1 }, { bg: '#eeeeee' });
    wb.addRule(id, { range: { r1: 1, c1: 1, r2: 2, c2: 1 }, type: 'gt', value: 2, style: { bg: '#ff0000', bold: true } });
    await flush();
    const b2 = grid.el.querySelector('#gc-1-1');
    expect(b2.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(b2.classList.contains('b')).toBe(true);
    expect(grid.el.querySelector('#gc-2-1').classList.contains('cf')).toBe(true);
    wb.setInput(id, 1, 1, '1');
    await flush();
    expect(grid.el.querySelector('#gc-1-1').style.backgroundColor).toBe('rgb(238, 238, 238)');
  });

  it('draws checkboxes and lists, toggles with Space, and blocks strict invalid input', async () => {
    const { grid, wb, id } = setup();
    wb.addValidation(id, { range: { r1: 4, c1: 0, r2: 4, c2: 0 }, type: 'checkbox' });
    wb.addValidation(id, { range: { r1: 5, c1: 0, r2: 5, c2: 0 }, type: 'list', source: 'Yes, No', strict: true });
    await flush();
    const box = grid.el.querySelector('#gc-4-0');
    expect(box.getAttribute('role')).toBe('gridcell'); // the checkbox is an element inside the cell
    expect(box.querySelector('[role="checkbox"]').getAttribute('aria-checked')).toBe('false');
    grid.setSelection({ active: { r: 4, c: 0 }, anchor: { r: 4, c: 0 }, focus: { r: 4, c: 0 } });
    key(grid.viewport, ' ');
    expect(wb.getValue(id, 4, 0)).toBe(true);
    key(grid.viewport, 'x'); // typing does not replace a checkbox
    expect(grid.editing).toBe(false);
    expect(grid.el.querySelector('#gc-5-0').classList.contains('has-list')).toBe(true);
    // A strict list refuses a value outside the list; the editor stays open.
    const strictGrid = createGrid({ wb, sheetId: id, validate: (r, c, text) => ({ ...wb.validateInput(id, r, c, text), strict: true }) });
    document.body.append(strictGrid.el);
    await flush();
    strictGrid.setSelection({ active: { r: 5, c: 0 }, anchor: { r: 5, c: 0 }, focus: { r: 5, c: 0 } });
    key(strictGrid.viewport, 'M');
    const editor = strictGrid.el.querySelector('.grid-editor');
    editor.value = 'Maybe';
    editor.dispatchEvent(new Event('input'));
    key(editor, 'Enter');
    expect(strictGrid.editing).toBe(true);
    expect(wb.getCell(id, 5, 0)).toBeUndefined();
    document.querySelector('.modal-root:not(.closing) .btn-primary').click();
    await Promise.resolve();
    editor.value = 'yes';
    editor.dispatchEvent(new Event('input'));
    key(editor, 'Enter');
    expect(strictGrid.editing).toBe(false);
    expect(wb.getValue(id, 5, 0)).toBe('yes');
  });

  it('marks filter header cells, hides filtered rows, and opens the menu with Alt+Down', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    [['Fruit', 'Qty'], ['Apple', '3'], ['Pear', '5'], ['Kiwi', '5']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
    const opened = [];
    const grid = createGrid({ wb, sheetId: id, onFilterOpen: (info) => opened.push(info.c) });
    document.body.replaceChildren(grid.el);
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 1 });
    wb.setFilterCriteria(id, 1, { values: ['5'] });
    await flush();
    expect(grid.el.querySelector('#gc-0-1').classList.contains('filter-on')).toBe(true);
    expect(grid.el.querySelector('#gc-0-0').classList.contains('filter-head')).toBe(true);
    expect(grid.el.querySelector('#gc-1-0')).toBeNull(); // Apple row filtered out
    expect(grid.el.querySelector('#gc-2-0').style.left).toBe('0px');
    key(grid.viewport, 'ArrowDown');
    expect(grid.active).toEqual({ r: 2, c: 0 }); // skips the filtered row
    grid.setSelection({ active: { r: 0, c: 1 }, anchor: { r: 0, c: 1 }, focus: { r: 0, c: 1 } });
    key(grid.viewport, 'ArrowDown', { altKey: true });
    expect(opened).toEqual([1]);
  });
});

describe('formula point mode', () => {
  it('arrow keys insert and extend a reference while a formula wants one', async () => {
    const { grid } = setup();
    await flush();
    grid.setSelection({ active: { r: 3, c: 1 }, anchor: { r: 3, c: 1 }, focus: { r: 3, c: 1 } });
    grid.beginEdit({ text: '=', mode: 'type' });
    const editor = grid.el.querySelector('.grid-editor');
    editor.setSelectionRange(1, 1);
    key(editor, 'ArrowUp');
    expect(grid.editState.text).toBe('=B3');
    key(editor, 'ArrowUp');
    expect(grid.editState.text).toBe('=B2');
    key(editor, 'ArrowLeft');
    expect(grid.editState.text).toBe('=A2');
    key(editor, 'ArrowDown', { shiftKey: true });
    expect(grid.editState.text).toBe('=A2:A3');
    key(editor, 'ArrowRight', { shiftKey: true });
    expect(grid.editState.text).toBe('=A2:B3');
    expect(grid.editing).toBe(true);
    // Typing an operator ends the pointed reference; the next arrow starts a fresh one from the cell.
    grid.insertText('+');
    expect(grid.editState.text).toBe('=A2:B3+');
    key(editor, 'ArrowUp');
    expect(grid.editState.text).toBe('=A2:B3+B3');
    // Enter commits the pointed formula.
    key(editor, 'Enter');
    expect(grid.editing).toBe(false);
  });

  it('leaves the caret alone when the formula is not expecting a reference', async () => {
    const { grid } = setup();
    await flush();
    grid.setSelection({ active: { r: 3, c: 1 }, anchor: { r: 3, c: 1 }, focus: { r: 3, c: 1 } });
    grid.beginEdit({ text: '=B2*2', mode: 'inplace' });
    const editor = grid.el.querySelector('.grid-editor');
    editor.setSelectionRange(5, 5);
    key(editor, 'ArrowLeft');
    expect(grid.editState.text).toBe('=B2*2');
    expect(grid.editing).toBe(true);
    // Up in type mode with a finished formula commits and moves, as before.
    grid.cancelEdit();
    grid.beginEdit({ text: '=B2*2', mode: 'type' });
    const ed2 = grid.el.querySelector('.grid-editor');
    ed2.setSelectionRange(5, 5);
    key(ed2, 'ArrowUp');
    expect(grid.editing).toBe(false);
    expect(grid.active).toEqual({ r: 2, c: 1 });
  });

  // Moving back through a typed formula to fix it switched to picking cells as soon as the caret
  // passed a "+", writing B4, C4… into the middle of the formula.
  it('moves the caret once it has been put into the formula, until F2 switches back', async () => {
    const { grid } = setup();
    await flush();
    grid.setSelection({ active: { r: 3, c: 0 }, anchor: { r: 3, c: 0 }, focus: { r: 3, c: 0 } });
    grid.beginEdit({ text: '=A3+A2)', mode: 'type' });
    const editor = grid.el.querySelector('.grid-editor');
    editor.setSelectionRange(7, 7);
    key(editor, 'ArrowLeft');
    expect(grid.editState.mode).toBe('inplace');
    editor.setSelectionRange(4, 4); // just after the "+"
    key(editor, 'ArrowLeft');
    key(editor, 'ArrowRight');
    expect(grid.editState.text).toBe('=A3+A2)');
    expect(grid.editing).toBe(true);
    // A click into the text is Edit mode too.
    grid.cancelEdit();
    grid.beginEdit({ text: '=A3+A2)', mode: 'type' });
    editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    editor.setSelectionRange(4, 4);
    key(editor, 'ArrowRight');
    expect(grid.editState.text).toBe('=A3+A2)');
    // F2 goes back to Enter mode, where the arrows pick a reference again.
    key(editor, 'F2');
    key(editor, 'ArrowRight');
    expect(grid.editState.text).toBe('=A3+B4A2)');
    grid.cancelEdit();
  });
});

describe('outline groups', () => {
  it('draws a gutter with a bracket and a toggle button, and toggling collapses the rows', async () => {
    const { wb, id, grid, commands } = setup();
    await flush();
    const before = grid.el.style.getPropertyValue('--row-header-w');
    wb.groupLines(id, 'row', 1, 3);
    await flush();
    expect(grid.el.style.getPropertyValue('--row-header-w')).not.toBe(before);
    expect(grid.el.style.getPropertyValue('--outline-w')).toBe('32px'); // a bracket column and one for the last level button
    const btn = grid.el.querySelector('.grid-rowhead .outline-btn');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('−');
    expect(grid.el.querySelector('.grid-rowhead .outline-line')).not.toBeNull();
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(commands).not.toContain('toggleGroup');
    btn.click();
    expect(commands.filter(c=>c==='toggleGroup')).toHaveLength(1);
    wb.toggleGroup(id, 'row', 1, 3);
    await flush();
    expect(grid.el.querySelector('#gc-2-0')).toBeNull(); // hidden rows are not rendered
    expect(grid.el.querySelector('.grid-rowhead .outline-btn').textContent).toBe('+');
    wb.ungroupLines(id, 'row', 1, 3);
    await flush();
    expect(grid.el.querySelector('.grid-rowhead .outline-btn')).toBeNull();
    expect(grid.el.style.getPropertyValue('--outline-w')).toBe('0px');
  });
});

describe('IMAGE cells', () => {
  it('renders an img inside the cell and shows nothing as text', async () => {
    const { wb, id, grid } = setup();
    wb.setInput(id, 5, 0, '=IMAGE("https://example.com/logo.png")');
    await flush();
    const cell = grid.el.querySelector('#gc-5-0');
    expect(cell.classList.contains('img-cell')).toBe(true);
    expect(cell.querySelector('img').getAttribute('src')).toBe('https://example.com/logo.png');
    expect(wb.getDisplay(id, 5, 0)).toBe('');
  });
});

describe('Keyboard extras', () => {
  it('F9, Shift+F11, and the copy-from-above keys reach the editor as commands', async () => {
    const { grid, commands } = setup();
    await flush();
    key(grid.viewport, 'F9');
    key(grid.viewport, 'F11', { shiftKey: true });
    key(grid.viewport, "'", { ctrlKey: true, metaKey: true });
    key(grid.viewport, '"', { ctrlKey: true, metaKey: true, shiftKey: true });
    expect(commands).toEqual(expect.arrayContaining(['recalc', 'newSheet', 'copyAbove']));
    expect(commands.filter((c) => c === 'copyAbove').length).toBe(2);
    expect(grid.editing).toBe(false);
  });
});

describe('multi-range selection', () => {
  it('adds ranges with Ctrl/Cmd+click, exposes them, and drops them on a plain selection', async () => {
    const { grid, announced } = setup();
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    await flush();
    grid.setSelection({ active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 1, c: 0 } });
    const pe = (type, x, y, init = {}) => grid.viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, button: 0, pointerType: 'mouse', ...init }));
    // Column B is 100px in; click inside row 3.
    const row3Y = 2.5 * Math.round(DEFAULT_ROW_HEIGHT);
    pe('pointerdown', 150, row3Y, { ctrlKey: true, metaKey: true });
    pe('pointerup', 150, row3Y, { ctrlKey: true, metaKey: true });
    expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 2, c1: 1, r2: 2, c2: 1 }]);
    expect(grid.range).toEqual({ r1: 2, c1: 1, r2: 2, c2: 1 });
    await flush();
    expect(grid.el.querySelectorAll('.sel-extras .sel-range.extra').length).toBe(1);
    expect(announced.at(-1)).toMatch(/2 ranges selected/);
    // Escape and a plain selection both go back to one range.
    key(grid.viewport, 'Escape');
    expect(grid.ranges.length).toBe(1);
    pe('pointerdown', 150, row3Y, { ctrlKey: true, metaKey: true });
    pe('pointerup', 150, row3Y);
    expect(grid.ranges.length).toBe(2);
    grid.setSelection({ active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
    expect(grid.ranges.length).toBe(1);
  });

  it('keeps every range when an added range or its header is right-clicked', async () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const menus = [];
    const grid = createGrid({ wb, sheetId: id, onContextMenu: (m) => menus.push(m) });
    document.body.replaceChildren(grid.el);
    await flush();
    grid.setRanges([{ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 2, c1: 1, r2: 2, c2: 1 }]);
    const menu = (target, x, y) => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    menu(grid.viewport, 50, 13); // A1, inside the first range
    expect(grid.ranges.length).toBe(2);
    expect(menus.at(-1)).toMatchObject({ kind: 'cell' });
    // A header over cells only partly selected in its line takes the whole line, as Excel's does (header-menu-whole-lines).
    menu(grid.el.querySelector('.grid-rowhead .hcell[data-r="0"]'), 20, 40);
    expect(grid.ranges.length).toBe(1);
    expect(grid.range).toMatchObject({ r1: 0, r2: 0, c1: 0 });
    expect(menus.at(-1)).toMatchObject({ kind: 'row' });
    // Outside every range the right-click selects the cell under the pointer, as before.
    menu(grid.viewport, 350, 7.5 * Math.round(DEFAULT_ROW_HEIGHT));
    expect(grid.ranges.length).toBe(1);
    expect(grid.active).toEqual({ r: 7, c: 3 });
    grid.destroy();
  });
});

describe('text rotation', () => {
  it('renders rotated text in a turned span and vertical text stacked', async () => {
    const { wb, id, grid } = setup();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { rot: 45 });
    wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { rot: -90 });
    wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { rot: 90 });
    await flush();
    const a1 = grid.el.querySelector('#gc-0-0');
    expect(a1.classList.contains('rot')).toBe(true);
    expect(a1.querySelector('.rot-text').style.transform).toContain('rotate(-45deg)');
    expect(a1.textContent).toBe('Name');
    const b1 = grid.el.querySelector('#gc-0-1');
    expect(b1.classList.contains('vert')).toBe(true);
    expect(b1.classList.contains('down')).toBe(true);
    expect(grid.el.querySelector('#gc-1-0').classList.contains('up')).toBe(true);
    // Rows with rotated text grow to fit the turned text.
    const before = wb.rowHeight(id, 0);
    grid.autoFitRows(0, 0);
    expect(wb.rowHeight(id, 0)).toBeGreaterThan(before);
  });
});

describe('date cells', () => {
  it.each([{ fmt: 'date' }, { fmt: 'custom', code: 'dd/mm/yyyy' }])('opens the date picker for %j with Alt+Down, but edits other cells', async (style) => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setInput(id, 0, 0, '2026-08-28');
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, style);
    wb.setInput(id, 1, 0, 'plain');
    const opened = [];
    const commands = [];
    const grid = createGrid({ wb, sheetId: id, onDateOpen: (p) => opened.push(p), onCommand: (cmd, arg) => commands.push([cmd, arg]) });
    document.body.replaceChildren(grid.el);
    await flush();
    key(grid.viewport, 'ArrowDown', { altKey: true });
    expect(opened).toEqual([{ r: 0, c: 0 }]);
    expect(commands).toEqual([]);
    grid.setSelection({ active: { r: 1, c: 0 }, anchor: { r: 1, c: 0 }, focus: { r: 1, c: 0 } });
    key(grid.viewport, 'ArrowDown', { altKey: true }); // on any other cell the chord offers the pick list
    expect(opened).toHaveLength(1);
    expect(commands).toEqual([['pickFromList', undefined]]);
    expect(grid.active).toEqual({ r: 1, c: 0 });
    grid.destroy();
  });
});

describe('validation input message', () => {
  it('shows the rule prompt under the selected cell and hides it elsewhere', async () => {
    const { wb, id, grid } = setup();
    wb.addValidation(id, { range: { r1: 1, c1: 1, r2: 1, c2: 1 }, type: 'number', min: 0, prompt: 'Whole boxes only' });
    grid.setSelection({ active: { r: 1, c: 1 }, anchor: { r: 1, c: 1 }, focus: { r: 1, c: 1 } });
    await flush();
    const pop = grid.el.querySelector('.grid-canvas > .prompt-pop');
    expect(pop.hidden).toBe(false);
    expect(pop.textContent).toBe('Whole boxes only');
    grid.setSelection({ active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
    await flush();
    expect(pop.hidden).toBe(true);
  });
});

describe('text clipping', () => {
  it.each(['text', 'number'])('checks the longest displayed line for %s overflow', async (kind) => {
    const { wb, id, grid } = setup();
    try {
      const display = '1234567890\nabcdefghij';
      wb.setInput(id, 5, 0, kind === 'text' ? display : '1234567890');
      // Explicit line breaks are displayed only when Wrap Text is enabled.
      wb.applyStyle(id, { r1: 5, c1: 0, r2: 5, c2: 0 }, { wrap: true });
      if (kind === 'number') wb.applyStyle(id, { r1: 5, c1: 0, r2: 5, c2: 0 }, { fmt: 'custom', code: '0"\nabcdefghij"' });
      wb.setColWidth(id, 0, 80);
      wb.setRowHeight(id, 5, 60);
      expect(wb.getDisplay(id, 5, 0)).toBe(display);
      await flush();
      const cell = grid.el.querySelector('#gc-5-0');
      expect.soft(cell.textContent).toBe(display);
      expect.soft(cell.classList.contains('overflow')).toBe(false);
      expect(cell.classList.contains('spill')).toBe(false);
      expect(cell.style.width).toBe('80px');
    } finally { grid.destroy(); }
  });

  it('lets long text overflow into empty neighbours unless the cell is clipped', async () => {
    const { wb, id, grid } = setup();
    wb.setInput(id, 5, 0, 'A very long label that does not fit in one column at all');
    await flush();
    expect(grid.el.querySelector('#gc-5-0').classList.contains('spill')).toBe(true);
    wb.applyStyle(id, { r1: 5, c1: 0, r2: 5, c2: 0 }, { clip: true });
    await flush();
    expect(grid.el.querySelector('#gc-5-0').classList.contains('spill')).toBe(false);
  });
});

describe('icon set rendering', () => {
  it('draws the glyph before the value, or alone when asked', async () => {
    const { wb, id, grid } = setup();
    wb.setInput(id, 3, 1, '1');
    wb.setInput(id, 4, 1, '100');
    wb.addRule(id, { range: { r1: 1, c1: 1, r2: 4, c2: 1 }, type: 'icons', set: 'arrows', style: {} });
    await flush();
    const top = grid.el.querySelector('#gc-4-1');
    expect(top.querySelector('.cf-icon').textContent).toBe('▲');
    expect(top.textContent).toBe('▲100');
    wb.updateRule(id, wb.sheet(id).rules[0].id, { iconOnly: true });
    await flush();
    expect(grid.el.querySelector('#gc-3-1').textContent).toBe('▼');
  });
});

describe('show zeros', () => {
  it('blanks zero values when the sheet hides them, without changing the value', async () => {
    const { wb, id, grid } = setup();
    wb.setInput(id, 5, 0, '0');
    wb.setInput(id, 6, 0, '=A6*2');
    await flush();
    expect(grid.el.querySelector('#gc-5-0').textContent).toBe('0');
    wb.setZeros(id, false);
    grid.refresh();
    await flush();
    expect(grid.el.querySelector('#gc-5-0').textContent).toBe('');
    expect(grid.el.querySelector('#gc-6-0').textContent).toBe('');
    expect(wb.getValue(id, 6, 0)).toBe(0);
    expect(JSON.parse(JSON.stringify(wb.toJSON())).sheets[0].zeros).toBe(false);
  });
});

describe('setRanges', () => {
  it('selects several ranges at once with the active cell in the last', async () => {
    const { grid } = setup();
    await flush();
    grid.setRanges([{ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 3, c1: 2, r2: 3, c2: 2 }]);
    expect(grid.ranges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 3, c1: 2, r2: 3, c2: 2 }]);
    expect(grid.active).toEqual({ r: 3, c: 2 });
  });
});

describe('header visibility', () => {
  it('collapses the header tracks when headers are hidden and restores them', async () => {
    const { grid } = setup();
    await flush();
    expect(grid.showHeaders).toBe(true);
    grid.setShowHeaders(false);
    expect(grid.showHeaders).toBe(false);
    expect(grid.el.classList.contains('no-headers')).toBe(true);
    expect(grid.el.style.getPropertyValue('--row-header-w')).toBe('0px');
    expect(grid.el.style.getPropertyValue('--col-header-h')).toBe('0px');
    grid.setShowHeaders(true);
    expect(grid.el.classList.contains('no-headers')).toBe(false);
    expect(grid.el.style.getPropertyValue('--row-header-w')).not.toBe('0px');
  });
});

describe('spell checking while editing', () => {
  it('is on for text, off inside formulas, and can be turned off', async () => {
    const { grid } = setup();
    await flush();
    const editor = grid.el.querySelector('textarea');
    grid.beginEdit({ text: 'hello' });
    expect(editor.spellcheck).toBe(true);
    grid.setEditText('=SUM(');
    expect(editor.spellcheck).toBe(false);
    grid.setEditText('plain');
    expect(editor.spellcheck).toBe(true);
    grid.setSpellcheck(false);
    expect(editor.spellcheck).toBe(false);
    grid.cancelEdit?.();
    grid.beginEdit({ text: 'words' });
    expect(editor.spellcheck).toBe(false);
  });
});

describe('freeze bars', () => {
  it('sit at the frozen boundary and freeze where they are dropped', async () => {
    const { grid, commands, wb, id } = setup();
    await flush();
    const v = grid.el.querySelector('.freeze-bar.v');
    const h = grid.el.querySelector('.freeze-bar.h');
    expect(v && h).toBeTruthy();
    const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, button: 0, pointerType: 'mouse' }));
    // Column offsets are 100px wide in jsdom; dropping past the second column freezes two columns.
    pe(v, 'pointerdown', 40, 10);
    pe(v, 'pointermove', 250, 10);
    pe(v, 'pointerup', 250, 10);
    expect(commands).toContain('freeze');
    // The bar follows the frozen area.
    wb.setFrozen(id, 2, 1);
    await flush();
    expect(parseInt(v.style.left, 10)).toBeGreaterThan(parseInt(grid.el.style.getPropertyValue('--row-header-w') || '48', 10));
    expect(parseInt(h.style.top, 10)).toBeGreaterThan(20);
  });
});

describe('Tab at the end of a table', () => {
  it('adds a row and moves to its first cell', async () => {
    const { grid, wb, id } = setup();
    wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'T' });
    await flush();
    grid.setSelection({ active: { r: 2, c: 1 }, anchor: { r: 2, c: 1 }, focus: { r: 2, c: 1 } });
    key(grid.viewport, 'Tab');
    expect(wb.tableById(id, wb.tablesOn(id)[0].id).range.r2).toBe(3);
    expect(grid.selection.active).toEqual({ r: 3, c: 0 });
    // Elsewhere Tab just moves right.
    grid.setSelection({ active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
    key(grid.viewport, 'Tab');
    expect(grid.selection.active).toEqual({ r: 0, c: 1 });
  });
});

describe('structured reference highlights', () => {
  it('boxes the cells a table reference names while editing', async () => {
    const { grid, wb, id } = setup();
    wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'T' });
    await flush();
    grid.setSelection({ active: { r: 5, c: 3 }, anchor: { r: 5, c: 3 }, focus: { r: 5, c: 3 } });
    grid.beginEdit({ text: '=SUM(T[Qty])+A1' });
    await flush();
    const boxes = grid.el.querySelectorAll('.ref-hl');
    expect(boxes.length).toBe(2); // A1 and the Qty column
    grid.setEditText('=SUM(T[Nope])');
    await flush();
    expect(grid.el.querySelectorAll('.ref-hl').length).toBe(0);
    grid.cancelEdit();
  });
});

describe('table resize handle', () => {
  it('shows a corner per table and resizes the table when dragged', async () => {
    const { grid, wb, id } = setup();
    wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'T' });
    await flush();
    const handle = grid.el.querySelector('.table-handle');
    expect(handle).toBeTruthy();
    const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 11, button: 0, pointerType: 'mouse' }));
    pe(handle, 'pointerdown', 195, 70);
    // Columns are 100px and rows 24px in jsdom: (350, 130) is column D, row 6.
    pe(grid.viewport, 'pointermove', 350, 130);
    pe(grid.viewport, 'pointerup', 350, 130);
    const t = wb.tablesOn(id)[0];
    expect(t.range.r1).toBe(0);
    expect(t.range.c1).toBe(0);
    expect(t.range.r2).toBeGreaterThan(2);
    expect(t.range.c2).toBeGreaterThan(1);
  });
});

describe('moving a protected selection', () => {
  it('keeps the selection and does not announce success after a refused move', async () => {
    const { grid, wb, id, announced } = setup();
    try {
      grid.viewport.setPointerCapture = () => {};
      wb.protectRange(id, { r1: 0, c1: 0, r2: 0, c2: 0 });
      await flush();
      const selection = structuredClone(grid.selection);
      announced.length = 0;
      const pe = (type, x, y) => grid.viewport.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 12, button: 0, pointerType: 'mouse',
      }));
      pe('pointerdown', 1, 13);
      pe('pointermove', 201, 13);
      pe('pointerup', 201, 13);
      expect(grid.selection).toEqual(selection);
      expect(announced.some((text) => text.startsWith('Moved to'))).toBe(false);
      expect(wb.getValue(id, 0, 0)).toBe('Name');
      expect(wb.getValue(id, 0, 2)).toBeNull();
    } finally { grid.destroy(); }
  });
});

describe('references picked on another sheet', () => {
  it('keeps the edit alive across a sheet switch, inserts qualified refs, and comes back on commit', async () => {
    const { wb, id, grid } = setup();
    const other = wb.addSheet("Q1 data");
    wb.setInput(other.id, 1, 1, '40');
    wb.setActiveSheet(id);
    grid.setSheet(id);
    await flush();
    grid.setSelection({ anchor: { r: 4, c: 0 }, focus: { r: 4, c: 0 }, active: { r: 4, c: 0 } });
    grid.beginEdit({ text: '=SUM(' });
    expect(grid.acceptsRef()).toBe(true);
    grid.setSheet(other.id);
    expect(grid.editing).toBe(true);
    expect(grid.sheetId).toBe(other.id);
    grid.insertRef({ r1: 1, c1: 1, r2: 1, c2: 1 });
    expect(grid.editState.text).toBe("=SUM('Q1 data'!B2");
    // Dragging on to a range replaces the reference just inserted.
    grid.insertRef({ r1: 1, c1: 1, r2: 2, c2: 1 });
    expect(grid.editState.text).toBe("=SUM('Q1 data'!B2:B3");
    grid.setEditText("=SUM('Q1 data'!B2:B3)");
    grid.commitEdit();
    expect(grid.editing).toBe(false);
    expect(grid.sheetId).toBe(id);
    expect(wb.activeSheetId).toBe(id);
    expect(wb.getCell(id, 4, 0).f).toBe("SUM('Q1 data'!B2:B3)");
    expect(wb.getValue(id, 4, 0)).toBe(40);
    // Escape on the other sheet cancels and comes back without writing anything.
    grid.beginEdit({ text: '=' });
    grid.setSheet(other.id);
    grid.insertRef({ r1: 0, c1: 0, r2: 0, c2: 0 });
    grid.cancelEdit();
    expect(grid.editing).toBe(false);
    expect(grid.sheetId).toBe(id);
    expect(wb.getCell(id, 4, 0).f).toBe("SUM('Q1 data'!B2:B3)");
    // A switch with no reference expected commits as before.
    grid.beginEdit({ text: 'plain text' });
    grid.setSheet(other.id);
    expect(grid.editing).toBe(false);
    expect(wb.getCell(id, 4, 0).v).toBe('plain text');
  });
});

describe('deleting the sheet being edited', () => {
  const at = (r, c) => ({ active: { r, c }, anchor: { r, c }, focus: { r, c } });

  it('drops a formula waiting for a reference on another sheet instead of committing it there', async () => {
    const { wb, id, grid } = setup();
    const other = wb.addSheet('Other');
    wb.setActiveSheet(id);
    grid.setSheet(id);
    await flush();
    grid.setSelection(at(4, 0));
    grid.beginEdit({ text: '=SUM(' });
    grid.setSheet(other.id);
    expect(grid.editing).toBe(true);
    wb.deleteSheet(id);
    expect(grid.editing).toBe(false);
    expect(grid.sheetId).toBe(other.id);
    grid.commitEdit();
    expect(wb.getCell(other.id, 4, 0)).toBeUndefined();
    grid.destroy();
  });

  it('drops a plain entry on the shown sheet without trying to write it', async () => {
    const { wb, id, grid } = setup();
    const other = wb.addSheet('Other');
    wb.setActiveSheet(id);
    grid.setSheet(id);
    await flush();
    grid.setSelection(at(4, 0));
    grid.beginEdit({ text: 'plain' });
    const transactions = vi.spyOn(wb, 'transaction');
    wb.deleteSheet(id);
    expect(grid.editing).toBe(false);
    expect(grid.sheetId).toBe(other.id);
    expect(transactions.mock.calls.map((c) => c[0])).not.toContain('Edit cell');
    expect(wb.getCell(other.id, 4, 0)).toBeUndefined();
    transactions.mockRestore();
    grid.destroy();
  });
});

describe('Enter and Tab movement', () => {
  const at = (r, c) => ({ active: { r, c }, anchor: { r, c }, focus: { r, c } });

  it('steps over hidden rows and columns, in the grid and after a commit', async () => {
    const { wb, id, grid } = setup();
    wb.setHidden(id, 'row', [1], true);
    wb.setHidden(id, 'col', [1], true);
    await flush();
    grid.setSelection(at(0, 0));
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 2, c: 0 });
    key(grid.viewport, 'Enter', { shiftKey: true });
    expect(grid.active).toEqual({ r: 0, c: 0 });
    key(grid.viewport, 'Tab');
    expect(grid.active).toEqual({ r: 0, c: 2 });
    key(grid.viewport, 'Tab', { shiftKey: true });
    expect(grid.active).toEqual({ r: 0, c: 0 });
    // Typing then Enter lands on the next visible row, not the hidden one.
    key(grid.viewport, 'x');
    key(grid.el.querySelector('.grid-editor'), 'Enter');
    expect(wb.getCell(id, 0, 0).v).toBe('x');
    expect(grid.active).toEqual({ r: 2, c: 0 });
    key(grid.viewport, 'y');
    key(grid.el.querySelector('.grid-editor'), 'Tab');
    expect(grid.active).toEqual({ r: 2, c: 2 });
  });

  it('treats a merged block as one cell', async () => {
    const { wb, id, grid } = setup();
    wb.mergeCells(id, { r1: 0, c1: 0, r2: 2, c2: 0 });
    wb.mergeCells(id, { r1: 4, c1: 0, r2: 4, c2: 2 });
    await flush();
    grid.setSelection(at(0, 0));
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 3, c: 0 });
    key(grid.viewport, 'Enter', { shiftKey: true });
    expect(grid.active).toEqual({ r: 0, c: 0 });
    key(grid.viewport, 'z');
    key(grid.el.querySelector('.grid-editor'), 'Enter');
    expect(wb.getCell(id, 0, 0).v).toBe('z');
    expect(grid.active).toEqual({ r: 3, c: 0 });
    grid.setSelection(at(4, 0));
    key(grid.viewport, 'Tab');
    expect(grid.active).toEqual({ r: 4, c: 3 });
    key(grid.viewport, 'Tab', { shiftKey: true });
    expect(grid.active).toEqual({ r: 4, c: 0 });
  });

  it('walks a range without stopping on hidden rows or covered cells', async () => {
    const { wb, id, grid } = setup();
    wb.setHidden(id, 'row', [1], true);
    wb.mergeCells(id, { r1: 2, c1: 0, r2: 3, c2: 0 });
    await flush();
    grid.setSelection({ active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 4, c: 1 } });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 2, c: 0 });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 4, c: 0 });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 0, c: 1 });
    key(grid.viewport, 'Enter', { shiftKey: true });
    expect(grid.active).toEqual({ r: 4, c: 0 });
    // The range selection survives the walk.
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 4, c2: 1 });
  });

  it('keeps walking the range when Enter follows a Tab inside it', async () => {
    const { grid } = setup();
    await flush();
    grid.setSelection({ active: { r: 1, c: 1 }, anchor: { r: 1, c: 1 }, focus: { r: 3, c: 3 } });
    key(grid.viewport, 'Tab');
    expect(grid.active).toEqual({ r: 1, c: 2 });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 2, c: 2 });
    expect(grid.range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 3 });
    // A run of Tabs from a single cell still brings Enter back to where it began.
    grid.setSelection(at(5, 1));
    key(grid.viewport, 'Tab');
    key(grid.viewport, 'Tab');
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 6, c: 1 });
    // Extending that single cell into a range ends the run: Enter walks the range.
    grid.setSelection(at(7, 1));
    key(grid.viewport, 'Tab');
    key(grid.viewport, 'ArrowDown', { shiftKey: true });
    key(grid.viewport, 'Enter');
    expect(grid.active).toEqual({ r: 8, c: 2 });
    expect(grid.range).toEqual({ r1: 7, c1: 2, r2: 8, c2: 2 });
  });
});

describe('editing', () => {
  const at = (r, c) => ({ active: { r, c }, anchor: { r, c }, focus: { r, c } });

  it('leaves the context menu inside the editor to the browser', async () => {
    const { grid } = setup();
    await flush();
    key(grid.viewport, 'x');
    const editor = grid.el.querySelector('.grid-editor');
    const inEditor = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    editor.dispatchEvent(inEditor);
    expect(inEditor.defaultPrevented).toBe(false);
    expect(grid.editing).toBe(true);
    // Elsewhere on the grid the page menu stays suppressed while typing.
    const onCells = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 });
    grid.viewport.dispatchEvent(onCells);
    expect(onCells.defaultPrevented).toBe(true);
    key(editor, 'Escape');
  });
});

describe('editing an off-screen cell', () => {
  const at = (r, c) => ({ active: { r, c }, anchor: { r, c }, focus: { r, c } });

  it('scrolls the active cell into view when typing starts', async () => {
    const { grid, wb, id } = setup();
    await flush();
    const calls = [];
    grid.viewport.scrollTo = (o) => { calls.push(o); };
    grid.setSelection(at(60, 0), { scroll: false });
    expect(calls.length).toBe(0);
    key(grid.viewport, 'x');
    expect(calls.length).toBe(1);
    expect(calls[0].top).toBeGreaterThan(0);
    key(grid.el.querySelector('.grid-editor'), 'Escape');
    // An edit driven from the formula bar leaves the scroll position alone.
    grid.setSelection(at(70, 0), { scroll: false });
    grid.beginEdit({ text: 'abc', mode: 'inplace', focusEditor: false });
    expect(calls.length).toBe(1);
    grid.commitEdit();
    expect(wb.getCell(id, 70, 0).v).toBe('abc');
  });
});

describe('Ctrl+Enter over several ranges', () => {
  it('fills every selected range in one undo step', async () => {
    const { wb, id, grid } = setup();
    await flush();
    grid.setRanges([{ r1: 5, c1: 0, r2: 6, c2: 0 }, { r1: 5, c1: 2, r2: 6, c2: 2 }]);
    key(grid.viewport, '7');
    key(grid.el.querySelector('.grid-editor'), 'Enter', { ctrlKey: true });
    expect([wb.getCell(id, 5, 0).v, wb.getCell(id, 6, 0).v, wb.getCell(id, 5, 2).v, wb.getCell(id, 6, 2).v]).toEqual([7, 7, 7, 7]);
    wb.undo();
    expect([wb.getCell(id, 5, 0), wb.getCell(id, 6, 0), wb.getCell(id, 5, 2), wb.getCell(id, 6, 2)]).toEqual([undefined, undefined, undefined, undefined]);
    // A formula shifts relative to the cell it was typed in, across every range.
    grid.setRanges([{ r1: 5, c1: 1, r2: 6, c2: 1 }, { r1: 5, c1: 3, r2: 5, c2: 3 }]);
    key(grid.viewport, '=');
    grid.setEditText('=C6*2');
    key(grid.el.querySelector('.grid-editor'), 'Enter', { ctrlKey: true });
    expect(wb.getCell(id, 5, 3).f).toBe('C6*2');
    expect(wb.getCell(id, 5, 1).f).toBe('A6*2');
    expect(wb.getCell(id, 6, 1).f).toBe('A7*2');
  });
});

describe('protected ranges while editing', () => {
  it('refuses to open the editor on a protected cell and explains why', async () => {
    const { wb, id, grid } = setup();
    wb.protectRange(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, 'Title');
    await flush();
    const events = [];
    wb.addEventListener('change', (e) => { if (e.detail.type === 'protected') events.push(e.detail); });
    key(grid.viewport, 'x');
    expect(grid.editing).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0].description).toBe('Title');
    key(grid.viewport, 'F2');
    expect(grid.editing).toBe(false);
    expect(wb.getCell(id, 0, 0).v).toBe('Name');
    // The cell next to it edits as usual.
    grid.setSelection({ active: { r: 0, c: 1 }, anchor: { r: 0, c: 1 }, focus: { r: 0, c: 1 } });
    key(grid.viewport, 'x');
    expect(grid.editing).toBe(true);
    key(grid.el.querySelector('.grid-editor'), 'Escape');
  });
});

describe('multi-line cell editor', () => {
  const at = (r, c) => ({ active: { r, c }, anchor: { r, c }, focus: { r, c } });

  it('grows downward for Alt+Enter lines and turns wrapping on when they are committed', async () => {
    const { wb, id, grid } = setup();
    await flush();
    grid.setSelection(at(5, 0));
    key(grid.viewport, 'a');
    const editor = grid.el.querySelector('.grid-editor');
    expect(editor.style.height).toBe(`${Math.round(DEFAULT_ROW_HEIGHT)}px`);
    key(editor, 'Enter', { altKey: true });
    expect(editor.value).toBe('a\n');
    editor.value = 'a\nb\nc';
    editor.dispatchEvent(new Event('input'));
    expect(parseFloat(editor.style.height)).toBeGreaterThan(40);
    expect(parseFloat(editor.style.paddingTop)).toBeLessThan(4);
    key(editor, 'Enter');
    expect(wb.getCell(id, 5, 0).v).toBe('a\nb\nc');
    expect(wb.getCell(id, 5, 0).s.wrap).toBe(true);
    expect(wb.rowHeight(id, 5)).toBeGreaterThan(26);
    // One undo step takes the text, the wrap, and the row height back together.
    wb.undo();
    expect(wb.getCell(id, 5, 0)).toBeUndefined();
    expect(wb.rowHeight(id, 5)).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('wraps at the cell width in a wrap-formatted cell', async () => {
    const { wb, id, grid } = setup();
    wb.applyStyle(id, { r1: 6, c1: 0, r2: 6, c2: 0 }, { wrap: true });
    await flush();
    grid.setSelection(at(6, 0));
    key(grid.viewport, 'F2');
    const editor = grid.el.querySelector('.grid-editor');
    expect(editor.classList.contains('wrap')).toBe(true);
    editor.value = 'a sentence long enough to need several lines in a narrow column';
    editor.dispatchEvent(new Event('input'));
    expect(editor.style.width).toBe(`${wb.colWidth(id, 0)}px`);
    // A formula in the same cell runs on to the right instead.
    editor.value = '=SUM(A1:A5)+B2+C3+D4+E5+F6+G7+H8+I9+J10+K11+L12+M13';
    editor.dispatchEvent(new Event('input'));
    expect(editor.classList.contains('wrap')).toBe(false);
    expect(parseFloat(editor.style.width)).toBeGreaterThan(wb.colWidth(id, 0));
    key(editor, 'Escape');
  });

  it('places one line where the cell draws it: centered in a tall row, or at the top or bottom', async () => {
    const { wb, id, grid } = setup();
    wb.setRowHeight(id, 7, 60);
    await flush();
    grid.setSelection(at(7, 0));
    key(grid.viewport, 'x');
    const editor = grid.el.querySelector('.grid-editor');
    expect(editor.style.height).toBe('60px');
    const centered = parseFloat(editor.style.paddingTop);
    expect(centered).toBeGreaterThan(15);
    expect(centered).toBeLessThan(25);
    key(editor, 'Escape');
    wb.applyStyle(id, { r1: 7, c1: 0, r2: 7, c2: 0 }, { valign: 'top' });
    key(grid.viewport, 'x');
    expect(parseFloat(editor.style.paddingTop)).toBeLessThan(3);
    key(editor, 'Escape');
    wb.applyStyle(id, { r1: 7, c1: 0, r2: 7, c2: 0 }, { valign: 'bottom' });
    key(grid.viewport, 'x');
    expect(parseFloat(editor.style.paddingTop)).toBeGreaterThan(35);
    key(editor, 'Escape');
  });
});

describe('double-click to edit', () => {
  const dbl = (grid, clientX, clientY) => grid.viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY }));

  it('opens the editor with the cell text and the caret under the pointer', async () => {
    const { wb, id, grid } = setup();
    await flush();
    // Columns are 100px wide. Each character measures 7px in the test canvas.
    dbl(grid, 4 + 7 * 2 + 3, 1.5 * Math.round(DEFAULT_ROW_HEIGHT));
    expect(grid.editing).toBe(true);
    expect(grid.editState).toMatchObject({ r: 1, c: 0, text: 'Apples' });
    const editor = grid.el.querySelector('.grid-editor');
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(2);
    // Far right of the text: the caret goes to the end.
    key(editor, 'Escape');
    dbl(grid, 90, 1.5 * Math.round(DEFAULT_ROW_HEIGHT));
    expect(editor.selectionStart).toBe(6);
    // Double-clicking another cell while editing commits the first and edits the second.
    editor.value = 'Apples!';
    editor.dispatchEvent(new Event('input'));
    dbl(grid, 150, 13);
    expect(wb.getCell(id, 1, 0).v).toBe('Apples!');
    expect(grid.editState).toMatchObject({ r: 0, c: 1, text: 'Qty' });
    key(editor, 'Escape');
    // An empty cell opens an empty editor.
    dbl(grid, 250, 5.5 * Math.round(DEFAULT_ROW_HEIGHT));
    expect(grid.editState).toMatchObject({ r: 5, c: 2, text: '' });
    expect(editor.selectionStart).toBe(0);
    key(editor, 'Escape');
  });
});

describe('double-click near the fill handle', () => {
  const pe = (grid, type, x, y) => grid.viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 5, button: 0, pointerType: 'mouse' }));
  const dbl = (grid, x, y) => grid.viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 2 }));

  it('edits the cell when the first click only selected it, and fills when both clicks hit the handle', async () => {
    const { wb, id, grid } = setup();
    grid.viewport.setPointerCapture = () => {};
    grid.viewport.releasePointerCapture = () => {};
    await flush();
    // Start on another cell, then click inside A2 near its bottom-right corner.
    const bottom = 2 * Math.round(DEFAULT_ROW_HEIGHT);
    grid.setSelection({ active: { r: 3, c: 2 }, anchor: { r: 3, c: 2 }, focus: { r: 3, c: 2 } });
    pe(grid, 'pointerdown', 97, bottom - 3);
    pe(grid, 'pointerup', 97, bottom - 3);
    expect(grid.active).toEqual({ r: 1, c: 0 });
    pe(grid, 'pointerdown', 97, bottom - 3);
    pe(grid, 'pointerup', 97, bottom - 3);
    dbl(grid, 97, bottom - 3);
    expect(grid.editing).toBe(true);
    expect(grid.editState).toMatchObject({ r: 1, c: 0, text: 'Apples' });
    expect(wb.getCell(id, 2, 0)).toBeUndefined(); // nothing was filled down
    key(grid.el.querySelector('.grid-editor'), 'Escape');
    // A double-click that begins on the handle of an existing selection still auto-fills.
    pe(grid, 'pointerdown', 99, bottom - 1);
    pe(grid, 'pointerup', 99, bottom - 1);
    pe(grid, 'pointerdown', 99, bottom - 1);
    pe(grid, 'pointerup', 99, bottom - 1);
    dbl(grid, 99, bottom - 1);
    expect(grid.editing).toBe(false);
    expect(wb.getCell(id, 2, 0)?.v).toBe('Apples');
  });
});

describe('selection changes keep the cell nodes', () => {
  const at = (r, c) => ({ active: { r, c }, anchor: { r, c }, focus: { r, c } });
  const pe = (grid, type, x, y) => grid.viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, button: 0, pointerType: 'mouse' }));

  it('does not rebuild the cells when a cell is clicked, so a double-click reaches the browser intact', async () => {
    const { grid } = setup();
    grid.viewport.setPointerCapture = () => {};
    grid.viewport.releasePointerCapture = () => {};
    await flush();
    const a2 = document.getElementById('gc-1-0');
    const b3 = document.getElementById('gc-2-1');
    // First click: the selection moves to A2. Second click: A2 again.
    pe(grid, 'pointerdown', 50, 39); pe(grid, 'pointerup', 50, 39);
    await flush();
    expect(grid.active).toEqual({ r: 1, c: 0 });
    expect(document.getElementById('gc-1-0')).toBe(a2);
    pe(grid, 'pointerdown', 50, 39); pe(grid, 'pointerup', 50, 39);
    await flush();
    expect(document.getElementById('gc-1-0')).toBe(a2);
    expect(document.getElementById('gc-2-1')).toBe(b3);
    // Arrow keys move the selection without redrawing the cells either.
    key(grid.viewport, 'ArrowDown');
    await flush();
    expect(grid.active).toEqual({ r: 2, c: 0 });
    expect(document.getElementById('gc-1-0')).toBe(a2);
    expect(a2.getAttribute('aria-selected')).toBeNull();
    expect(document.getElementById('gc-2-0').getAttribute('aria-selected')).toBe('true');
  });

  it('re-highlights the headers in place', async () => {
    const { grid } = setup();
    await flush();
    const rowHead = (r) => grid.el.querySelector(`.grid-rowhead .hcell[data-r="${r}"]`);
    const colHead = (c) => grid.el.querySelector(`.grid-colhead .hcell[data-c="${c}"]`);
    expect(rowHead(0).classList.contains('hl')).toBe(true);
    grid.setSelection({ active: { r: 2, c: 1 }, anchor: { r: 2, c: 1 }, focus: { r: 3, c: 2 } });
    await flush();
    expect(rowHead(0).classList.contains('hl')).toBe(false);
    expect(rowHead(2).classList.contains('hl')).toBe(true);
    expect(rowHead(3).classList.contains('hl')).toBe(true);
    expect(colHead(0).classList.contains('hl')).toBe(false);
    expect(colHead(1).classList.contains('hl')).toBe(true);
    expect(colHead(2).classList.contains('hl')).toBe(true);
    // A whole column marks its header as selected.
    key(grid.viewport, ' ', { ctrlKey: true });
    await flush();
    expect(colHead(1).classList.contains('sel')).toBe(true);
    expect(colHead(1).classList.contains('hl')).toBe(false);
    expect(colHead(3).classList.contains('sel')).toBe(false);
    // Ctrl-added ranges light their headers too.
    grid.setRanges([{ r1: 5, c1: 0, r2: 5, c2: 0 }, { r1: 7, c1: 3, r2: 7, c2: 3 }]);
    await flush();
    expect(rowHead(5).classList.contains('hl')).toBe(true);
    expect(rowHead(7).classList.contains('hl')).toBe(true);
    expect(rowHead(6).classList.contains('hl')).toBe(false);
  });

  it('still rebuilds when the data changes or the active cell leaves the rendered area', async () => {
    const { wb, id, grid } = setup();
    await flush();
    const a2 = document.getElementById('gc-1-0');
    wb.setInput(id, 1, 0, 'Pears');
    await flush();
    expect(document.getElementById('gc-1-0')).not.toBe(a2);
    expect(document.getElementById('gc-1-0').textContent).toBe('Pears');
    grid.setSelection(at(60, 0), { scroll: false });
    await flush();
    expect(document.getElementById('gc-60-0')).not.toBeNull();
    expect(grid.viewport.getAttribute('aria-activedescendant')).toBe('gc-60-0');
  });
});

describe('text boxes in the grid', () => {
  it('draws a text box with its text and style, and Enter asks to edit it', async () => {
    const { wb, id, grid, commands } = setup();
    const boxId = wb.addChart(id, { type: 'text', text: 'Note to self', anchor: { r: 0, c: 0 }, w: 200, h: 60, style: { bold: true, align: 'right' } });
    await flush();
    const box = grid.el.querySelector('.chart-box.text-box');
    expect(box).not.toBeNull();
    expect(box.querySelector('.text-body').textContent).toBe('Note to self');
    expect(box.querySelector('.text-body').style.fontWeight).toBe('600');
    expect(box.querySelector('.text-body').style.textAlign).toBe('right');
    expect(box.getAttribute('aria-label')).toBe('Text box: Note to self');
    grid.selectChart(boxId);
    key(grid.viewport, 'Enter');
    expect(commands).toContain('editChart');
    wb.updateChart(id, boxId, { text: 'Changed' }, 'Edit text box');
    await flush();
    expect(box.querySelector('.text-body').textContent).toBe('Changed');
  });
});

describe('dropdown chips in the grid', () => {
  it('draws a chip list value as a colored pill', async () => {
    const { wb, id, grid } = setup();
    wb.addValidation(id, { range: { r1: 3, c1: 0, r2: 5, c2: 0 }, type: 'list', source: 'Open, Closed', chips: true, colors: { Closed: '#e2f6ea' } });
    wb.setInput(id, 3, 0, 'Closed');
    wb.setInput(id, 4, 0, 'Open');
    await flush();
    const closed = grid.el.querySelector('#gc-3-0 .chip');
    expect(closed).not.toBeNull();
    expect(closed.textContent).toBe('Closed');
    expect(closed.style.backgroundColor).toBe('rgb(226, 246, 234)');
    expect(grid.el.querySelector('#gc-4-0 .chip')).not.toBeNull();
    expect(grid.el.querySelector('#gc-3-0').classList.contains('has-list')).toBe(true);
    expect(grid.el.querySelector('#gc-1-0 .chip')).toBeNull();
  });
});


describe('autocomplete keyboard interaction', () => {
  it('keeps the highlighted suggestion after ArrowDown keyup', () => {
    const { grid } = setup();
    grid.beginEdit({ text: '=SU', mode: 'type' });
    const editor = grid.el.querySelector('.grid-editor');
    const items = [...grid.el.querySelectorAll('.fx-name')].map((n) => n.textContent);
    expect(items.length).toBeGreaterThan(2);
    key(editor, 'ArrowDown');
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    expect(grid.el.querySelector('.fx-item.selected .fx-name').textContent).toBe(items[1]);
    key(editor, 'ArrowDown');
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    key(editor, 'Tab');
    expect(grid.editState.text).toBe(`=${items[2]}(`);
    grid.destroy();
  });
});


describe('input method composition', () => {
  it.each(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'F4'])('leaves %s to the input method', (name) => {
    const { grid, wb, id } = setup();
    grid.beginEdit({ text: '=SU', mode: 'type' });
    const editor = grid.el.querySelector('.grid-editor');
    const event = new KeyboardEvent('keydown', { key: name, isComposing: true, bubbles: true, cancelable: true });
    editor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(grid.editState.text).toBe('=SU');
    expect(wb.getValue(id, 0, 0)).toBe('Name');
    grid.destroy();
  });

  it('does not commit the IME confirmation key reported as legacy key code 229', () => {
    const { grid } = setup();
    grid.beginEdit({ text: '日本語' });
    const editor = grid.el.querySelector('.grid-editor');
    key(editor, 'Enter', { keyCode: 229 });
    expect(grid.editing).toBe(true);
    grid.destroy();
  });

  it('does not replace composing text with a column suggestion', () => {
    const { grid } = setup();
    grid.selectByName('A3');
    grid.beginEdit({ text: '', mode: 'type' });
    const editor = grid.el.querySelector('.grid-editor');
    editor.value = 'App';
    editor.setSelectionRange(3, 3);
    editor.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    expect(editor.value).toBe('App');
    expect(editor.selectionStart).toBe(3);
    grid.destroy();
  });
});

describe('navigation across hidden cells', () => {
  it('extends to the next visible cell with Shift+Arrow', () => {
    const { grid, wb, id } = setup();
    wb.setHidden(id, 'row', [1, 2], true);
    wb.setHidden(id, 'col', [1, 2], true);
    key(grid.viewport, 'ArrowDown', { shiftKey: true });
    expect(grid.selection.focus).toEqual({ r: 3, c: 0 });
    key(grid.viewport, 'ArrowRight', { shiftKey: true });
    expect(grid.selection.focus).toEqual({ r: 3, c: 3 });
    key(grid.viewport, 'ArrowUp', { shiftKey: true });
    key(grid.viewport, 'ArrowLeft', { shiftKey: true });
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
    grid.destroy();
  });

  it('jumps through a visible block without stopping at hidden gaps', () => {
    const { grid, wb, id } = setup();
    wb.setInput(id, 1, 0, '');
    wb.setInput(id, 2, 0, 'Second');
    wb.setInput(id, 3, 0, 'Third');
    wb.setHidden(id, 'row', [1], true);
    key(grid.viewport, 'ArrowDown', { ctrlKey: true });
    expect(grid.active).toEqual({ r: 3, c: 0 });
    grid.destroy();
  });

  it('uses visible boundaries for Home and End', () => {
    const { grid, wb, id } = setup();
    wb.setInput(id, 0, 4, 'End');
    wb.setHidden(id, 'col', [0, 4], true);
    grid.selectByName('C1');
    key(grid.viewport, 'Home');
    expect(grid.active).toEqual({ r: 0, c: 1 });
    // Ctrl+End: the last cell of the data, its hidden column passed over for the last visible one.
    key(grid.viewport, 'End', { ctrlKey: true });
    expect(grid.active.c).toBe(3);
    grid.destroy();
  });

  it('moves the active cell of a header or select-all selection off hidden lines', async () => {
    const { grid, wb, id } = setup();
    wb.setHidden(id, 'col', [0], true);
    await flush();
    const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 4, button: 0, pointerType: 'mouse' }));
    pe(grid.el.querySelector('.grid-rowhead .hcell[data-r="2"]'), 'pointerdown', 20, 83);
    pe(grid.el.querySelector('.grid-rowhead-clip'), 'pointerup', 20, 83);
    expect(grid.range).toMatchObject({ r1: 2, r2: 2, c1: 0 });
    expect(grid.active).toEqual({ r: 2, c: 1 });
    key(grid.viewport, 'x');
    expect(grid.editState).toMatchObject({ r: 2, c: 1 });
    key(grid.el.querySelector('.grid-editor'), 'Escape');
    key(grid.viewport, 'a', { ctrlKey: true, metaKey: true }); // the block of data around B3 first, the active cell kept
    expect(grid.range).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 });
    expect(grid.active).toEqual({ r: 2, c: 1 });
    key(grid.viewport, 'a', { ctrlKey: true, metaKey: true }); // then the whole sheet, the active cell kept where it was, as in Excel
    expect(grid.active).toEqual({ r: 2, c: 1 });
    // A selection made only of hidden lines keeps its active cell, so Unhide still knows which lines are meant.
    wb.setHidden(id, 'row', [4, 5], true);
    grid.selectByName('5:6');
    expect(grid.active).toEqual({ r: 4, c: 0 });
    grid.destroy();
  });

  it('crosses more than ten thousand hidden rows for navigation and formula references', () => {
    const { grid, wb, id } = setup();
    wb.ensureSize(id, 12005, 26);
    wb.setHidden(id, 'row', Array.from({ length: 12000 }, (_, i) => i + 1), true);
    key(grid.viewport, 'ArrowDown');
    expect(grid.active).toEqual({ r: 12001, c: 0 });
    grid.selectByName('A1');
    grid.beginEdit({ text: '=', mode: 'type' });
    key(grid.el.querySelector('.grid-editor'), 'ArrowDown');
    expect(grid.editState.text).toBe('=A12002');
    grid.destroy();
  });
});

it('switches sheets from an open formula with Ctrl+PageDown', () => {
  const { grid, commands } = setup();
  grid.beginEdit({ text: '=SUM(' });
  key(grid.el.querySelector('.grid-editor'), 'PageDown', { ctrlKey: true });
  expect(commands).toEqual(['sheet']);
  expect(grid.editState.text).toBe('=SUM(');
  grid.destroy();
});

it.each(['ContextMenu', 'F10'])('opens the cell menu using %s without changing the selection', (name) => {
  const wb = new Workbook();
  const onContextMenu = vi.fn();
  const grid = createGrid({ wb, sheetId: wb.activeSheetId, onContextMenu });
  document.body.replaceChildren(grid.el);
  grid.selectByName('B2:C4');
  const before = grid.range;
  const event = new KeyboardEvent('keydown', { key: name, shiftKey: name === 'F10', bubbles: true, cancelable: true });
  grid.viewport.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cell', x: expect.any(Number), y: expect.any(Number) }));
  expect(grid.range).toEqual(before);
  grid.destroy();
});

it('leaves Enter and Space on a link popover control to that control', () => {
  const { wb, id, grid, commands } = setup();
  wb.setInput(id, 0, 0, 'https://example.com');
  grid.setSelection({ active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
  const button = grid.el.querySelector('.link-pop-btn');
  button.focus();
  for (const name of ['Enter', ' ', 'Backspace']) {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(grid.active).toEqual({ r: 0, c: 0 });
    expect(grid.editing).toBe(false);
    expect(commands).toEqual([]);
  }
  grid.destroy();
});

it('skips hidden columns in a large Enter traversal without scanning their cells', () => {
  const { grid, wb, id } = setup();
  wb.ensureSize(id, 1000, 26);
  wb.setHidden(id, 'col', Array.from({ length: 24 }, (_, i) => i + 1), true);
  grid.setSelection({ active: { r: 999, c: 0 }, anchor: { r: 0, c: 0 }, focus: { r: 999, c: 25 } });
  const lookup = vi.spyOn(wb.sheet(id).hiddenCols, 'has');
  key(grid.viewport, 'Enter');
  expect(grid.active).toEqual({ r: 0, c: 25 });
  expect(lookup.mock.calls.length).toBeLessThan(1000);
  lookup.mockRestore();
  grid.destroy();
});

it('walks visible merged selections in both orders and directions', () => {
  const { grid, wb, id } = setup();
  wb.mergeCells(id, { r1: 1, c1: 1, r2: 3, c2: 3 });
  wb.mergeCells(id, { r1: 4, c1: 0, r2: 5, c2: 1 });
  wb.setHidden(id, 'row', [2], true);
  wb.setHidden(id, 'col', [4], true);
  const cells = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    const merge = wb.mergeAt(id, r, c);
    if (r !== 2 && c !== 4 && (!merge || (merge.r1 === r && merge.c1 === c))) cells.push({ r, c });
  }
  for (const name of ['Enter', 'Tab']) for (const back of [false, true]) {
    const order = [...cells].sort(name === 'Enter' ? (a, b) => a.c - b.c || a.r - b.r : (a, b) => a.r - b.r || a.c - b.c);
    if (back) order.reverse();
    grid.setSelection({ active: order[0], anchor: { r: 0, c: 0 }, focus: { r: 5, c: 5 } });
    for (let i = 1; i <= order.length; i++) {
      key(grid.viewport, name, { shiftKey: back });
      expect(grid.active).toEqual(order[i % order.length]);
    }
  }
  grid.destroy();
});

describe('bulk keyboard entry', () => {
  function setupFill() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const announce = vi.fn();
    const grid = createGrid({ wb, sheetId: id, announce,
      validate: (r, c, text) => { const result = wb.validateInput(id, r, c, text); return { ...result, strict: result.rule?.strict !== false }; },
    });
    document.body.replaceChildren(grid.el);
    return { wb, id, grid, announce };
  }

  it('validates every destination before Ctrl+Enter changes any cells', async () => {
    const { wb, id, grid } = setupFill();
    wb.addValidation(id, { range: { r1: 1, c1: 0, r2: 1, c2: 0 }, type: 'list', source: 'Yes,No', strict: true });
    grid.selectByName('A1:A3');
    grid.beginEdit({ text: 'Invalid' });
    expect(grid.commitEdit({ fillSelection: true })).toBe(false);
    expect(grid.editing).toBe(true);
    expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual([null, null, null]);
    document.querySelector('.modal-root:not(.closing) .btn-primary').click();
    await Promise.resolve();
    grid.setEditText('Yes');
    expect(grid.commitEdit({ fillSelection: true })).toBe(true);
    expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual(['Yes', 'Yes', 'Yes']);
    wb.undo();
    expect(wb.getValue(id, 0, 0)).toBeNull();
    grid.destroy();
  });

  it('does not partially fill separate ranges when one contains a protected cell', () => {
    const { wb, id, grid } = setupFill();
    wb.protectRange(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, 'Locked');
    grid.setRanges([0, 1, 2].map((c) => ({ r1: 0, c1: c, r2: 0, c2: c })));
    grid.beginEdit({ text: 'Shared' });
    expect(grid.commitEdit({ fillSelection: true })).toBe(false);
    expect(grid.editing).toBe(true);
    expect([0, 1, 2].map((c) => wb.getValue(id, 0, c))).toEqual([null, null, null]);
    grid.destroy();
  });

  it('keeps the entry and explains a fill that exceeds the supported size', () => {
    const { grid, announce } = setupFill();
    grid.selectByName('A1:Z2000');
    grid.beginEdit({ text: 'Keep this' });
    expect(grid.commitEdit({ fillSelection: true })).toBe(false);
    expect(grid.editState.text).toBe('Keep this');
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/50,000/));
    grid.destroy();
  });
});

it('keeps the active cell visible while Enter and Tab walk a large selection', () => {
  const { grid } = setup();
  grid.selectByName('A1:Z50');
  grid.viewport.scrollTop = 0;
  grid.viewport.scrollLeft = 0;
  const scroll = vi.spyOn(grid.viewport, 'scrollTo');
  key(grid.viewport, 'Enter');
  expect(grid.active).toEqual({ r: 1, c: 0 });
  expect(scroll).not.toHaveBeenCalled();
  key(grid.viewport, 'Tab');
  expect(grid.active).toEqual({ r: 1, c: 1 });
  expect(scroll).not.toHaveBeenCalled();
  scroll.mockRestore();
  grid.destroy();
});

it('accepts AltGraph characters without treating them as spreadsheet shortcuts', () => {
  const { grid, commands } = setup();
  const event = new KeyboardEvent('keydown', { key: '€', code: 'KeyE', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true });
  expect(event.getModifierState('AltGraph')).toBe(true);
  grid.viewport.dispatchEvent(event);
  expect(grid.editState?.text).toBe('€');
  expect(commands).toEqual([]);
  grid.destroy();
});

it('includes spilled formula results when Ctrl+Arrow finds a data boundary', () => {
  const { grid, wb, id } = setup();
  wb.setInput(id, 0, 3, '=SEQUENCE(4)');
  grid.selectByName('D1');
  key(grid.viewport, 'ArrowDown', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 3, c: 3 });
  key(grid.viewport, 'ArrowUp', { ctrlKey: true });
  expect(grid.active).toEqual({ r: 0, c: 3 });
  grid.destroy();
});

it('explains a header drag that would split a table without changing the selection', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Qty');
  wb.setInput(id, 0, 1, 'Price');
  wb.setInput(id, 0, 2, 'Amount');
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 2 });
  wb.clearHistory();
  const invalid = vi.fn();
  const announce = vi.fn();
  const grid = createGrid({ wb, sheetId: id, onInvalid: invalid, announce });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    const clip = grid.el.querySelector('.grid-colhead-clip');
    clip.setPointerCapture = () => {};
    clip.releasePointerCapture = () => {};
    const header = clip.querySelector('.hcell[data-c="1"]');
    const pe = (target, type, x) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, pointerId: 9, button: 0, pointerType: 'mouse' }));
    pe(header, 'pointerdown', 150);
    pe(clip, 'pointerup', 150);
    const selected = grid.range;
    const before = wb.toJSON();
    pe(header, 'pointerdown', 150);
    pe(clip, 'pointermove', 550);
    pe(clip, 'pointerup', 550);
    expect(invalid).toHaveBeenCalledWith({ message: expect.stringContaining('split a table') });
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining('split a table'));
    expect(grid.range).toEqual(selected);
    expect(wb.toJSON()).toEqual(before);
    expect(wb.canUndo()).toBe(false);
  } finally { grid.destroy(); }
});

it('explains a refused table resize without announcing success or changing the table', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const first = wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'First' });
  wb.addTable(id, { r1: 0, c1: 3, r2: 2, c2: 4 }, { name: 'Other' });
  wb.clearHistory();
  const invalid = vi.fn();
  const announce = vi.fn();
  const grid = createGrid({ wb, sheetId: id, onInvalid: invalid, announce });
  document.body.replaceChildren(grid.el);
  try {
    await flush();
    grid.viewport.setPointerCapture = () => {};
    grid.viewport.releasePointerCapture = () => {};
    const handle = grid.el.querySelector(`.table-handle[data-id="${first}"]`);
    expect(handle).not.toBeNull();
    const pe = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, button: 0, pointerType: 'mouse' }));
    const before = wb.toJSON();
    pe(handle, 'pointerdown', 195, 70);
    pe(grid.viewport, 'pointermove', 350, 60);
    pe(grid.viewport, 'pointerup', 350, 60);
    expect(invalid).toHaveBeenCalledWith({ message: expect.stringContaining('overlap another table') });
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining('overlap another table'));
    expect(wb.toJSON()).toEqual(before);
    expect(wb.canUndo()).toBe(false);
  } finally { grid.destroy(); }
});

describe('filter button visibility', () => {
  it('renders and opens only the visible columns in a mixed-visibility filter', async () => {
    const wb = new Workbook(), id = wb.activeSheetId, opened = [];
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 2 });
    wb.activeSheet.filter.hiddenButtons = [0, 2];
    const grid = createGrid({ wb, sheetId: id, onFilterOpen: c => opened.push(c) });
    document.body.replaceChildren(grid.el);
    try {
      await flush();
      expect([...grid.el.querySelectorAll('.filter-head')].map(cell => cell.id)).toEqual(['gc-0-1']);
      grid.selectByName('A1'); key(grid.viewport, 'ArrowDown', { altKey: true }); expect(opened).toHaveLength(0);
      grid.selectByName('B1'); key(grid.viewport, 'ArrowDown', { altKey: true }); expect(opened).toHaveLength(1);
      grid.selectByName('C1'); key(grid.viewport, 'ArrowDown', { altKey: true }); expect(opened).toHaveLength(1);
    } finally { grid.destroy(); }
  });
  it('keeps filtering rows without rendering or opening hidden header controls', async () => {
    const wb = new Workbook(), id = wb.activeSheetId, opened = [];
    wb.setInput(id, 0, 0, 'Value'); wb.setInput(id, 1, 0, '3'); wb.setInput(id, 2, 0, '9');
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 2, c2: 0 }); wb.setFilterCriteria(id, 0, { op: 'gt', value: 5 });
    wb.activeSheet.filter.showButtons = false;
    const grid = createGrid({ wb, sheetId: id, onFilterOpen: () => opened.push('filter') }); document.body.replaceChildren(grid.el);
    grid.viewport.setPointerCapture = () => {};
    try {
      await flush(); expect(grid.el.querySelector('.filter-head')).toBeNull(); expect(grid.el.querySelector('#gc-1-0')).toBeNull();
      key(grid.viewport, 'ArrowDown', { altKey: true }); expect(opened).toEqual([]);
      grid.selectByName('A1');
      const rect = grid.cellRect(0, 0);
      grid.viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: rect.right - 10, clientY: rect.top + 8, pointerId: 1, pointerType: 'mouse', button: 0 }));
      expect(opened).toEqual([]);
    } finally { grid.destroy(); }
  });
  it('allows a validation dropdown at a header with hidden filter buttons', async () => {
    const wb = new Workbook(), id = wb.activeSheetId, opened = [];
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 2, c2: 0 }); wb.activeSheet.filter.showButtons = false;
    wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: 'Yes,No' });
    const grid = createGrid({ wb, sheetId: id, onFilterOpen: () => opened.push('filter'), onListOpen: () => opened.push('list') }); document.body.replaceChildren(grid.el);
    try {
      await flush(); const rect = grid.cellRect(0, 0);
      grid.viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: rect.right - 10, clientY: rect.top + 8, pointerId: 2, pointerType: 'mouse', button: 0 }));
      expect(opened).toEqual([]);
      grid.el.querySelector('.cell-list-button').click();
      expect(opened).toEqual(['list']); expect(grid.el.querySelector('#gc-0-0').classList.contains('has-list')).toBe(true);
    } finally { grid.destroy(); }
  });
});

describe('focus during an edit', () => {
  it('returns to the cell being edited when the grid is refocused, as menus and dialogs do on close', () => {
    const { grid } = setup();
    try {
      grid.beginEdit({ text: 'abc', mode: 'inplace' });
      const editor = grid.el.querySelector('.grid-editor');
      expect(document.activeElement).toBe(editor);
      grid.el.querySelector('[role="grid"]').focus();
      expect(document.activeElement).not.toBe(editor);
      grid.focus();
      expect(document.activeElement).toBe(editor);
      expect(grid.editing).toBe(true);
      grid.cancelEdit();
      grid.focus();
      expect(document.activeElement).toBe(grid.el.querySelector('[role="grid"]'));
    } finally { grid.destroy(); }
  });
});

describe('saved worksheet headings',()=>{
 it('loads per-sheet headers, switches sheets, and follows Undo without moving the selection',async()=>{
  const wb=new Workbook({sheets:[{name:'Hidden headings',headers:false,frozenRows:1,frozenCols:1},{name:'Ordinary'}]});
  const id=wb.sheets[0].id,grid=createGrid({wb,sheetId:id});document.body.replaceChildren(grid.el);
  try {
   await flush();expect(grid.showHeaders).toBe(false);expect(grid.el.style.getPropertyValue('--row-header-w')).toBe('0px');
   grid.selectByName('D5');grid.setShowHeaders(true);expect(grid.active).toEqual({r:4,c:3});expect(wb.sheet(id).headers).toBe(true);
   wb.undo();expect(grid.showHeaders).toBe(false);expect(grid.active).toEqual({r:4,c:3});
   grid.setSheet(wb.sheets[1].id);expect(grid.showHeaders).toBe(true);expect(grid.el.style.getPropertyValue('--row-header-w')).toBe('48px');
   grid.setSheet(id);expect(grid.showHeaders).toBe(false);expect(grid.active).toEqual({r:4,c:3});
  }finally{grid.destroy()}
 });
});

it('keeps outline controls accessible when row and column headings are hidden',async()=>{
 const {wb,id,grid,commands}=setup();
 try {
  wb.groupLines(id,'row',1,3);wb.groupLines(id,'col',1,2);grid.setShowHeaders(false);await flush();
  const buttons=[...grid.el.querySelectorAll('.outline-btn')];expect(buttons).toHaveLength(2);
  expect(buttons.every(b=>!b.closest('[aria-hidden="true"]'))).toBe(true);
  expect(grid.el.querySelector('.hcell').getAttribute('aria-hidden')).toBe('true');
  expect(parseFloat(grid.el.style.getPropertyValue('--row-header-w'))).toBeGreaterThan(0);
  buttons.find(b=>b.dataset.axis==='row').click();expect(commands).toContain('toggleGroup');
 }finally{grid.destroy()}
});
