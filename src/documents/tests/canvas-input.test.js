import { MAX_DOCUMENT_CHARACTERS } from '../src/engine/text-limits.js';
// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { caretRect } from '../src/engine/layout.js';
import { EMU_PER_INCH } from '../src/engine/images.js';

let editor, host, changed, errors;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto',
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  changed = vi.fn(); errors = vi.fn();
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Alpha'), paragraph('Beta')], onChange: changed, onError: errors });
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function nativeValue(value, selection = value.length, composing = false) {
  editor.input.value = value; editor.input.setSelectionRange(selection, selection);
  editor.input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: composing ? 'insertCompositionText' : 'insertReplacementText', isComposing: composing }));
}

it.each([['ArrowDown', false], ['ArrowDown', true], ['ArrowUp', false], ['ArrowUp', true]])('retains bidi boundary affinity for %s with selection extension %s', (key, shiftKey) => {
  editor.destroy();
  const mixed = paragraph('');
  mixed.runs = [{ text: 'Left ' }, { text: 'אבג', rtl: true }, { text: ' Right' }];
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Before'), mixed, paragraph('After')], onError: errors });
  const [before, line, after] = editor.layout.lines;
  const stop = line.stops.find(s => s.affinity === 'backward' && line.stops.some(t => t.offset === s.offset && Math.abs(t.x - s.x) > 1));
  expect(stop).toBeDefined();
  const origin = key === 'ArrowDown' ? before : after, text = editor.model.text;
  editor.model.select(origin.start); editor.caretAffinity = 'forward'; editor.caretPage = origin.page;
  editor.preferredCellId = null; editor.preferredX = stop.x; editor.syncInput();
  const event = new KeyboardEvent('keydown', { key, shiftKey, cancelable: true });
  editor.input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(caretRect(editor.layout, editor.model.selection.focus, editor.caretAffinity, editor.caretPage).x).toBeCloseTo(stop.x, 6);
  expect(editor.model.selection.anchor).toBe(shiftKey ? origin.start : editor.model.selection.focus);
  expect(editor.model.text).toBe(text); expect(editor.session.history).toHaveLength(0);
  expect(errors).not.toHaveBeenCalled();
});

it('retains a pending direct-format reset across native typing, composition, undo and redo', () => {
  editor.model.select(0, 5); editor.setRunFormat({ bold: true, fontSize: 24 }); editor.model.select(2); editor.focus();
  editor.clearDirectTextFormatting(); expect(editor.model.runFormatting).toMatchObject({ bold: false, fontSize: 12 }); expect(editor.session.history).toHaveLength(1);
  nativeValue('AlXpha\nBeta', 3); expect(editor.model.paragraphs[0].runs.find(r => r.text === 'X')).toMatchObject({ bold: false, fontSize: 12 });
  editor.input.dispatchEvent(new CompositionEvent('compositionstart'));
  nativeValue('AlXQpha\nBeta', 4, true); nativeValue('AlXÁ😀pha\nBeta', 7, true);
  editor.input.dispatchEvent(new CompositionEvent('compositionend', { data: 'Á😀' }));
  expect(editor.model.paragraphs[0].runs.find(r => r.text === 'XÁ😀')).toMatchObject({ bold: false, fontSize: 12 });
  editor.undo(); expect(editor.model.text).toBe('AlXpha\nBeta'); expect(editor.model.typingDirectCleared).toBe(true);
  editor.undo(); expect(editor.model.text).toBe('Alpha\nBeta'); expect(editor.model.typingDirectCleared).toBe(true); editor.redo(); expect(editor.model.text).toBe('AlXpha\nBeta'); expect(errors).not.toHaveBeenCalled();
});

it('handles direct-format reset shortcuts and native formatRemove while leaving IME keys alone', () => {
  editor.model.select(0, 5); editor.setRunFormat({ bold: true });
  editor.input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, keyCode: 229, cancelable: true })); expect(editor.model.bold).toBe(true);
  const key = new KeyboardEvent('keydown', { key: ' ', code: 'Space', metaKey: true, cancelable: true }); editor.input.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true); expect(editor.model.bold).toBe(false); editor.undo(); expect(editor.model.bold).toBe(true);
  const native = new InputEvent('beforeinput', { inputType: 'formatRemove', cancelable: true }); editor.input.dispatchEvent(native);
  expect(native.defaultPrevented).toBe(true); expect(editor.model.bold).toBe(false); editor.undo(); expect(editor.model.bold).toBe(true);
});

it('inserts real tabs, deletes them as one character, and leaves focus navigation available', () => {
  const key = (value, props = {}) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...props });
    editor.input.dispatchEvent(event); return event.defaultPrevented;
  };
  editor.model.select(2); editor.focus();
  expect(key('Tab')).toBe(true); expect(editor.model.text).toBe('Al\tpha\nBeta');
  expect(editor.layout.lines[0].fragments.map(f => f.text)).toEqual(['Al', 'pha']);
  key('Backspace'); expect(editor.model.text).toBe('Alpha\nBeta');
  editor.undo(); expect(editor.model.text).toBe('Al\tpha\nBeta');
  expect(key('Tab', { shiftKey: true })).toBe(false);
  key('Escape'); expect(key('Tab')).toBe(false);
  editor.setAccessible(true); expect(key('Tab')).toBe(true);
});

it('rolls back both paragraph and document tab settings when layout cannot fit', () => {
  editor.model.select(1, 8); const before = editor.model.snapshot(), original = editor.layout;
  expect(editor.setParagraphGeometry({ indentLeft: 10000 }, 360)).toBe(false);
  expect(editor.model.snapshot()).toEqual(before); expect(editor.layout).toEqual(original);
  expect(editor.session.history).toHaveLength(0); expect(changed).not.toHaveBeenCalled();
  expect(errors).toHaveBeenCalledOnce();
});

it('records a native replacement and preserves unaffected formatting', () => {
  editor.model.select(6, 10); editor.toggleBold(); changed.mockClear();
  nativeValue('Alpine\nBeta', 6);
  expect(editor.model.text).toBe('Alpine\nBeta');
  expect(editor.model.paragraphs[1].runs[0].bold).toBe(true);
  expect(changed).toHaveBeenCalledTimes(1);
  editor.undo(); expect(editor.model.text).toBe('Alpha\nBeta');
});

it('groups an entire composition into one undo transaction and notifies only after commit', () => {
  editor.model.select(0); editor.syncInput();
  editor.input.dispatchEvent(new CompositionEvent('compositionstart'));
  nativeValue('ㅎAlpha\nBeta', 1, true);
  nativeValue('한Alpha\nBeta', 1, true);
  expect(changed).not.toHaveBeenCalled();
  editor.input.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(editor.session.history).toHaveLength(1);
  editor.undo(); expect(editor.model.text).toBe('Alpha\nBeta');
  expect(editor.model.selection).toEqual({ anchor: 0, focus: 0 });
});

it('pastes plain text as one transaction, ignoring clipboard HTML', () => {
  editor.model.select(2, 8); editor.syncInput();
  const event = new Event('paste', { cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: type => type === 'text/plain' ? 'X\nY' : '<script>bad()</script>' } });
  editor.input.dispatchEvent(event);
  expect(editor.model.text).toBe('AlX\nYta');
  editor.undo(); expect(editor.model.text).toBe('Alpha\nBeta');
});

it('cuts a selected range and restores it with undo', () => {
  editor.model.select(2, 8); editor.syncInput();
  const setData = vi.fn(), event = new Event('cut', { cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData } });
  editor.input.dispatchEvent(event);
  expect(setData).toHaveBeenCalledWith('text/plain', 'pha\nBe');
  expect(editor.model.text).toBe('Alta');
  editor.undo(); expect(editor.model.text).toBe('Alpha\nBeta');
});

it('restores the last valid document when a composition exceeds the character limit', () => {
  editor.input.dispatchEvent(new CompositionEvent('compositionstart'));
  nativeValue('x'.repeat(MAX_DOCUMENT_CHARACTERS + 1), MAX_DOCUMENT_CHARACTERS + 1, true);
  editor.input.dispatchEvent(new CompositionEvent('compositionend'));
  expect(editor.model.text).toBe('Alpha\nBeta');
  expect(editor.input.value).toBe('Alpha\nBeta');
  expect(errors).toHaveBeenCalled();
});

it('removes all text input listeners when the editor is destroyed', () => {
  const input = editor.input;
  editor.destroy();
  input.value = 'Changed'; input.dispatchEvent(new InputEvent('input'));
  expect(changed).not.toHaveBeenCalled();
  expect(host.children).toHaveLength(0);
});

it('keeps End on the wrapped line, then moves down to the intended line across a page break', () => {
  editor.model.select(0, editor.model.text.length);
  editor.execute(() => editor.model.replace('word '.repeat(800)));
  editor.setParagraphFormat({ lineSpacing: 2, alignment: 'center' });
  const firstOnSecond = editor.layout.lines.find(l => l.page === 1);
  const previous = editor.layout.lines[editor.layout.lines.indexOf(firstOnSecond) - 1];
  editor.model.select(previous.start); editor.caretAffinity = 'forward'; editor.focus();
  editor.move('End', false, false, false);
  expect(editor.model.selection.focus).toBe(previous.end);
  expect(editor.caretAffinity).toBe('backward');
  editor.move('Home', false, false, false);
  expect(editor.model.selection.focus).toBe(previous.start);
  editor.move('ArrowDown', false, false, false);
  expect(editor.model.selection.focus).toBe(firstOnSecond.start);
  expect(editor.caretAffinity).toBe('forward');
  editor.move('ArrowUp', true, false, false);
  expect(editor.model.selection).toEqual({ anchor: firstOnSecond.start, focus: previous.start });
});

it('retains oversized text formatting and restores it through undo', () => {
  // The natural 200 pt line must exceed the writing area: expanded automatic
  // leading alone is allowed to cross its bottom edge by the native controls.
  editor.setPageSettings({ height: 4320, top: 360, bottom: 360 });
  editor.model.select(0, editor.model.text.length);
  editor.setParagraphFormat({ lineSpacing: 5 });
  const before = editor.model.snapshot(), history = [...editor.session.history];
  changed.mockClear();
  editor.setRunFormat({ fontSize: 200 });
  expect(editor.session.history).toHaveLength(history.length + 1);
  expect(errors).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalled();
  expect(editor.layout.lines.some(l => l.oversizedInlineHeight)).toBe(true);
  editor.undo(); expect(editor.model.snapshot()).toEqual(before);
});

it('retains oversized text after page setup and restores geometry and selection on undo', () => {
  editor.model.select(0, 5); editor.setRunFormat({ fontSize: 48 });
  const before = editor.model.snapshot(), history = [...editor.session.history], oldLayout = editor.layout;
  changed.mockClear();
  expect(editor.setPageSettings({ height: 3360 })).toBe(true);
  expect(editor.session.history).toHaveLength(history.length + 1);
  expect(changed).toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  editor.undo(); expect(editor.model.snapshot()).toEqual(before); expect(editor.layout).toEqual(oldLayout);
});

it('rejects an excessive break paste before canvas allocation and preserves the previous document', () => {
  const before = editor.model.snapshot(), count = editor.canvases.length;
  editor.execute(() => editor.model.replace('\f'.repeat(1000)));
  expect(editor.model.snapshot()).toEqual(before);
  expect(editor.canvases).toHaveLength(count);
  expect(editor.session.history).toHaveLength(0);
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('200 pages') }));
});

it('keeps break source offsets through keyboard movement, native input, text mode and composition', () => {
  editor.model.select(2); editor.focus();
  editor.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }));
  expect(editor.model.text).toBe('Al\fpha\nBeta'); expect(editor.layout.pageCount).toBe(2);
  editor.move('ArrowLeft', false, false, false);
  expect(editor.model.selection.focus).toBe(2);
  editor.move('ArrowRight', false, false, false);
  expect(editor.model.selection.focus).toBe(3);
  editor.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
  expect(editor.model.text).toBe('Al\f\vpha\nBeta'); expect(editor.model.paragraphs).toHaveLength(2);
  editor.setAccessible(true);
  expect(editor.input.value).toBe('Al\n\npha\nBeta');
  editor.input.setSelectionRange(8, 12);
  editor.input.dispatchEvent(new Event('select'));
  expect(editor.model.range).toEqual([8, 12]);
  // The textarea presents readable newlines. Unchanged breaks keep their original kinds.
  nativeValue('Al\n\npha\nBetaX');
  expect(editor.model.text).toBe('Al\f\vpha\nBetaX');
  editor.input.dispatchEvent(new CompositionEvent('compositionstart'));
  nativeValue('Al\n\npha\nBetaX한', 13, true);
  editor.input.dispatchEvent(new CompositionEvent('compositionend'));
  expect(editor.model.text).toBe('Al\f\vpha\nBetaX한');
  editor.undo(); expect(editor.model.text).toBe('Al\f\vpha\nBetaX');
  editor.model.select(2, 4); editor.focus();
  editor.input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'Z', cancelable: true }));
  expect(editor.model.text).toBe('AlZpha\nBetaX'); expect(editor.layout.pageCount).toBe(1);
  editor.undo(); expect(editor.model.text).toBe('Al\f\vpha\nBetaX'); expect(editor.layout.pageCount).toBe(2);
});


it('accepts an oversized cell glyph and restores the original document on undo', () => {
  editor.model.select(0); expect(editor.insertTable(1, 16)).toBe(true);
  editor.setRunFormat({ fontSize: 48 });
  // The production measurement scales with font size; use that contract here.
  editor.measure = (text, style) => ({ width: [...text].length * style.fontSize, ascent: style.fontSize, descent: style.fontSize / 4 });
  editor.relayout(); const before = editor.model.snapshot(), history = editor.session.history.length;
  const grid = structuredClone(editor.model.tables[0].grid);
  expect(editor.execute(() => editor.model.replace('W'))).toBe(true);
  expect(editor.model.tables[0].grid).toEqual(grid); expect(errors).not.toHaveBeenCalled();
  editor.undo(); expect(editor.model.snapshot()).toEqual(before); expect(editor.session.history).toHaveLength(history);
});

it('rolls back a vertical merge edit exceeding the page budget, retaining selection and undo history', () => {
  editor.setPageSettings({ height: 1440, top: 360, bottom: 360 });
  editor.model.select(0); editor.insertTable(2, 2); editor.mergeCellBelow();
  const before = editor.model.snapshot(), history = [...editor.session.history], geometry = editor.layout;
  changed.mockClear(); errors.mockClear();
  expect(editor.execute(() => editor.model.replace('Long merged content '.repeat(600)))).toBe(false);
  expect(editor.model.snapshot()).toEqual(before); expect(editor.session.history).toEqual(history); expect(editor.layout).toEqual(geometry);
  expect(changed).not.toHaveBeenCalled(); expect(errors.mock.calls[0][0].message).toMatch(/supports up to \d+ pages/);
});

it('edits a repeated header on the clicked page and keeps its caret there through typing, movement and undo', () => {
  editor.setPageSettings({ height: 4320, top: 360, bottom: 360 }); editor.model.select(0); editor.insertTable(3, 2);
  const table = editor.model.tables[0]; editor.execute(() => editor.model.replace('Title'));
  editor.model.selectCell(table.rows[1].cells[0].id); editor.execute(() => editor.model.replace('Body text. '.repeat(100)));
  editor.model.selectCell(table.rows[0].cells[0].id); editor.setTableHeaderRows(1);
  const copy = editor.layout.repeatedLines.find(l => l.cellId === table.rows[0].cells[0].id), stop = copy.stops[0];
  editor.canvases.forEach((canvas, i) => { canvas.getBoundingClientRect = () => ({ top: i * editor.layout.page.height, bottom: (i + 1) * editor.layout.page.height, left: 0 }); });
  const at = editor.point({ clientX: stop.x, clientY: copy.page * editor.layout.page.height + copy.y + copy.height / 2 }); editor.model.select(at); editor.focus();
  expect(editor.caretPage).toBe(copy.page); editor.execute(() => editor.model.replace('X'));
  expect(caretRect(editor.layout, editor.model.selection.focus, editor.caretAffinity, editor.caretPage).page).toBe(copy.page);
  expect(editor.model.text.match(/XTitle/g)).toHaveLength(1); expect(editor.layout.repeatedLines.filter(l => l.cellId === copy.cellId).every(l => l.fragments.map(f => f.text).join('') === 'XTitle')).toBe(true);
  editor.move('ArrowRight', false, false, false); expect(editor.caretPage).toBe(copy.page);
  editor.undo(); expect(editor.model.text).not.toContain('XTitle'); expect(caretRect(editor.layout, editor.model.selection.focus, 'forward', editor.caretPage).page).toBe(copy.page);
  editor.redo(); expect(editor.model.text.match(/XTitle/g)).toHaveLength(1); expect(caretRect(editor.layout, editor.model.selection.focus, 'forward', editor.caretPage).page).toBe(copy.page);
});

it('rolls back header/body crossing merges and headers that leave no usable page space', () => {
  editor.setPageSettings({ height: 4320, top: 360, bottom: 360 }); editor.model.select(0); editor.insertTable(2, 2); editor.setTableHeaderRows(1);
  const before = editor.model.snapshot(), history = [...editor.session.history]; changed.mockClear(); errors.mockClear();
  expect(editor.execute(() => editor.model.mergeCellBelow())).toBe(false);
  expect(errors.mock.calls.at(-1)[0].message).toMatch(/header boundary/); expect(editor.model.snapshot()).toEqual(before);
  expect(editor.execute(() => editor.model.replace('Tall header '.repeat(100)))).toBe(false);
  expect(errors.mock.calls.at(-1)[0].message).toMatch(/header rows must fit/); expect(editor.model.snapshot()).toEqual(before); expect(editor.session.history).toEqual(history); expect(changed).not.toHaveBeenCalled();
});

it('selects a painted inline picture, preserves it during adjacent native composition and copies its description as plain text', () => {
  editor.model.assets.panels = { bytes: new Uint8Array(), mime: 'image/png' };
  const draw = vi.fn(); HTMLCanvasElement.prototype.getContext().drawImage = draw; editor.images.set('panels', { width: 96, height: 48 });
  editor.model.select(2); editor.execute(() => editor.model.insertImage('panels', { width: EMU_PER_INCH, height: EMU_PER_INCH / 2, alt: 'Blue panels' }));
  expect(draw).toHaveBeenCalled(); const line = editor.layout.lines[0], image = line.fragments.find(f => f.image);
  editor.canvases[0].getBoundingClientRect = () => ({ top: 0, left: 0, bottom: editor.layout.page.height }); editor.pages.setPointerCapture = vi.fn();
  editor.pointerDown({ button: 0, pointerId: 1, clientX: image.x + image.width / 2, clientY: line.baseline - image.ascent / 2, preventDefault() {} });
  expect(editor.model.selectedImage.alt).toBe('Blue panels');
  const clipboardData = { setData: vi.fn() }; editor.copy({ clipboardData, preventDefault() {} }, false);
  expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'Blue panels');
  editor.model.select(2); editor.syncInput(); editor.input.dispatchEvent(new CompositionEvent('compositionstart'));
  nativeValue('Al한\ufffcpha\nBeta', 3, true); editor.input.dispatchEvent(new CompositionEvent('compositionend'));
  expect(editor.model.paragraphs[0].runs.filter(r => r.image)).toHaveLength(1); expect(editor.model.text).toBe('Al한\ufffcpha\nBeta');
  editor.undo(); expect(editor.model.text).toBe('Al\ufffcpha\nBeta'); editor.redo(); expect(editor.model.text).toBe('Al한\ufffcpha\nBeta');
  editor.model.select(3, 4); editor.copy({ clipboardData, preventDefault() {} }, true); expect(editor.model.text).toBe('Al한pha\nBeta'); editor.undo(); expect(editor.model.text).toBe('Al한\ufffcpha\nBeta');
});

it('rolls back an image beyond the supported dimension limit and restores metadata, geometry, selection and history together', () => {
  editor.model.assets.panels = { bytes: new Uint8Array(), mime: 'image/png' }; editor.model.select(0);
  editor.execute(() => editor.model.insertImage('panels', { width: EMU_PER_INCH, height: EMU_PER_INCH / 2, alt: 'Panels' }));
  const before = editor.model.snapshot(), history = [...editor.session.history], geometry = editor.layout; changed.mockClear(); errors.mockClear();
  expect(editor.setImageProperties({ width: 24 * EMU_PER_INCH, height: 12 * EMU_PER_INCH, alt: 'Rejected', flipH: true, flipV: true })).toBe(false);
  expect(editor.model.snapshot()).toEqual(before); expect(editor.session.history).toEqual(history); expect(editor.layout).toEqual(geometry); expect(changed).not.toHaveBeenCalled();
  expect(errors.mock.calls.at(-1)[0].message).toMatch(/22 inches/);
});

it('allows a rotated image to exceed the text width and restores its geometry on undo', () => {
  editor.model.assets.panels = { bytes: new Uint8Array(), mime: 'image/png' }; editor.model.select(0);
  expect(editor.execute(() => editor.model.insertImage('panels', { width: 6 * EMU_PER_INCH, height: 4 * EMU_PER_INCH, alt: 'Wide panels' }))).toBe(true);
  const before = editor.model.snapshot(), history = [...editor.session.history], geometry = editor.layout; changed.mockClear(); errors.mockClear();
  expect(editor.setImageProperties({ rotation: 45 * 60000 })).toBe(true);
  expect(editor.layout.lines.flatMap(l=>l.fragments).find(f=>f.image).width).toBeGreaterThan(6.5*96);
  expect(errors).not.toHaveBeenCalled(); editor.undo();
  expect(editor.model.snapshot()).toEqual(before); expect(editor.session.history).toEqual(history); expect(editor.layout).toEqual(geometry);
});

it('navigates an outline entry to its source paragraph without changing content, history or stale page affinity', () => {
  editor.model.select(0, editor.model.text.length); editor.execute(() => editor.model.replace('Opening\n' + 'Body text. '.repeat(400) + '\nLater heading'));
  editor.model.select(editor.model.text.indexOf('Later heading')); editor.setOutlineLevel(2);
  const entry = editor.outline.find(e => e.text === 'Later heading'); expect(entry.page).toBeGreaterThan(1);
  const text = editor.model.text, history = [...editor.session.history], future = [...editor.session.future]; changed.mockClear();
  editor.model.select(0); editor.caretPage = 0; editor.caretAffinity = 'backward'; editor.preferredX = 300;
  expect(editor.goToParagraph(entry.id)).toBe(true); expect(editor.model.selection).toEqual({ anchor: entry.start, focus: entry.start });
  expect(editor.caretPage).toBeNull(); expect(editor.caretAffinity).toBe('forward'); expect(editor.preferredX).toBeNull(); expect(document.activeElement).toBe(editor.input);
  expect(editor.model.text).toBe(text); expect(editor.session.history).toEqual(history); expect(editor.session.future).toEqual(future); expect(changed).not.toHaveBeenCalled();
  expect(editor.goToParagraph('missing-heading')).toBe(false); expect(editor.model.selection.focus).toBe(entry.start);
});

it('scales the viewport below 50% without changing layout, selection or edit history', () => {
  editor.model.select(1, 4); editor.focus();
  const layout = editor.layout, snapshot = editor.model.snapshot(), history = [...editor.session.history];
  editor.setZoom(0.35);
  expect(editor.zoom).toBe(0.35); expect(editor.layout).toBe(layout);
  // Shown at its backing store's whole-pixel size (devicePixelRatio 1 here), within half a pixel of the zoomed page.
  expect(editor.canvases[0].style.width).toBe(`${Math.round(layout.pages[0].width * .35)}px`);
  expect(editor.model.snapshot()).toEqual(snapshot); expect(editor.session.history).toEqual(history);
  expect(editor.input.selectionStart).toBe(1); expect(editor.input.selectionEnd).toBe(4);
  editor.setZoom(NaN); expect(editor.zoom).toBe(.35);
  editor.setZoom(1); expect(editor.layout).toBe(layout); expect(changed).not.toHaveBeenCalled();
});

it('pastes a long formatted HTML clipboard as plain text instead of formatting it run by run', () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `Line ${i} bold`);
  editor.model.select(0, editor.model.text.length);
  editor.pasteData(lines.join('\n'), lines.map(line => `<p>${line.replace('bold', '<b>bold</b>')}</p>`).join(''));
  expect(editor.model.text).toBe(lines.join('\n'));
  expect(editor.model.paragraphs.some(p => p.runs.some(r => r.bold))).toBe(false);
  expect(editor.session.history).toHaveLength(1);
  // A small paste keeps its formatting.
  editor.model.select(0, editor.model.text.length);
  editor.pasteData('Short bold', '<p>Short <b>bold</b></p>');
  expect(editor.model.paragraphs[0].runs.find(r => r.text === 'bold')?.bold).toBe(true);
  expect(errors).not.toHaveBeenCalled();
});
