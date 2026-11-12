import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';

describe('type editing session', () => {
  let app;
  let doc;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    doc = app.editor.doc;
  });

  const add = (text, extra = {}) => {
    const t = createText(text, 100, 100, extra);
    doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
    return t.id;
  };
  const edit = (id, caret) => {
    app.setTool('type');
    const s = app.getTool('type').editText(id, null);
    if (caret != null) s.setSelection(caret, caret);
    return s;
  };
  const key = (s, k, extra = {}) => s.handleKey(new KeyboardEvent('keydown', { key: k, ...extra }), app.getTool('type').keyActions());

  it('arrow keys, Delete and Backspace never split an emoji', () => {
    const id = add('a\u{1F600}b');
    const s = edit(id, 1);
    key(s, 'ArrowRight');
    expect(s.caret).toBe(3);
    key(s, 'ArrowLeft');
    expect(s.caret).toBe(1);
    key(s, 'ArrowRight', { shiftKey: true });
    expect(s.range()).toEqual([1, 3]);
    s.setSelection(1, 1);
    key(s, 'Delete');
    expect(doc.get(id).text).toBe('ab');
    const id2 = add('x\u{1F468}‍\u{1F469}‍\u{1F467}y');
    const s2 = edit(id2, 9);
    key(s2, 'Backspace');
    expect(doc.get(id2).text).toBe('xy');
  });

  it('a caret placed by clicking lands beside an emoji, not inside it', () => {
    const id = add('a\u{1F600}b', { char: { fontSize: 48 } });
    const s = edit(id, 0);
    for (let x = 90; x < 260; x += 2) {
      const i = s.indexAt(x, 90);
      expect(i).not.toBe(2);
    }
  });

  it('Escape or a cancelled pointer while dragging a path type bracket restores it and leaves no open transaction', () => {
    const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
    const t = createText('Along', 100, 300, { kind: 'path', pathAnchors: [pt(100, 300), pt(500, 300)], pathClosed: false, pathOptions: { effect: 'rainbow', align: 'baseline', start: 0 } });
    doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
    app.setTool('type');
    app.editor.select([t.id]);
    const ev = (x, y) => {
      const p = app.editor.view.toScreen(x, y);
      return { x, y, sx: p.x, sy: p.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', native: {} };
    };
    const tool = app.tool;
    tool.onPointerDown(ev(100, 300));
    tool.onPointerMove(ev(160, 300));
    expect(doc.get(t.id).pathOptions.start).toBeGreaterThan(0);
    tool.cancel();
    expect(doc.tx).toBeNull();
    expect(doc.get(t.id).pathOptions.start).toBe(0);
    tool.onPointerDown(ev(100, 300));
    tool.onPointerMove(ev(160, 300));
    app.setTool('selection');
    expect(doc.tx).toBeNull();
  });

  it('Ctrl+Backspace and Ctrl+Delete delete a word on Windows and Linux (the line on a Mac is Command)', async () => {
    const { IS_MAC } = await import('../src/commands/registry.js');
    expect(IS_MAC).toBe(false);
    const id = add('one two three');
    const s = edit(id, 7);
    key(s, 'Backspace', { ctrlKey: true });
    expect(doc.get(id).text).toBe('one  three');
    key(s, 'Delete', { ctrlKey: true });
    expect(doc.get(id).text).toBe('one ');
  });

  it('Find Next with Check Locked Layers moves past a match in locked type instead of sticking on it', async () => {
    const { lastFind, findNext } = await import('../src/features/type/find.js');
    const a = add('a cat');
    const t = createText('the cat', 100, 200, { locked: true });
    doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
    const c = add('one cat');
    expect(doc.isLocked(t.id)).toBe(true);
    Object.assign(lastFind, { query: 'cat', matchCase: false, wholeWord: false, includeLocked: true, includeHidden: false, backwards: false, current: null });
    edit(a, 0);
    expect(findNext(app)).toBe('found');
    expect(app.typeSession.id).toBe(a);
    // The locked match is reported (it cannot be edited or selected) and the next search continues after it.
    expect(findNext(app)).toBe('locked');
    expect(lastFind.current.id).toBe(t.id);
    expect(app.editor.selection.has(t.id)).toBe(false);
    expect(findNext(app)).toBe('found');
    expect(app.typeSession?.id).toBe(c);
    Object.assign(lastFind, { includeLocked: false, current: null });
  });

  it('Edit > Undo and Redo from the menu put the caret where the text changed, like Cmd+Z while typing', async () => {
    const id = add('Hello world');
    const s = edit(id, 5);
    s.insert('XYZ');
    expect(doc.get(id).text).toBe('HelloXYZ world');
    await app.commands.run('edit.undo');
    expect(doc.get(id).text).toBe('Hello world');
    expect(app.typeSession).toBe(s);
    expect(s.range()).toEqual([5, 5]);
    await app.commands.run('edit.redo');
    expect(doc.get(id).text).toBe('HelloXYZ world');
    expect(s.range()).toEqual([5, 8]);
  });

  it('new point type that ends up empty leaves no object and no undo steps behind', () => {
    const ev = (x, y) => {
      const p = app.editor.view.toScreen(x, y);
      return { x, y, sx: p.x, sy: p.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', native: {} };
    };
    const texts = () => [...doc.nodes.values()].filter((n) => n.type === 'text');
    const keep = add('keep');
    const steps = doc.undoStack.length;
    app.setTool('type');
    for (const placeholder of [false, true]) {
      app.prefs.set('typePlaceholder', placeholder);
      app.tool.onPointerDown(ev(300, 300));
      app.tool.onPointerUp(ev(300, 300));
      const s = app.typeSession;
      expect(texts()).toHaveLength(2);
      // With placeholder text: delete it, type and delete again.
      if (placeholder) {
        key(s, 'Backspace');
        s.insert('ab');
        key(s, 'Backspace');
        key(s, 'Backspace');
      }
      key(s, 'Escape');
      expect(texts().map((n) => n.id)).toEqual([keep]);
      expect(doc.undoStack.length).toBe(steps);
      expect(doc.canRedo).toBe(false);
      app.setTool('type');
    }
    // Undo still takes back what came before.
    doc.undo();
    expect(texts()).toHaveLength(0);
  });

  it('empty type is still deleted as an undoable step after other changes', () => {
    const ev = (x, y) => {
      const p = app.editor.view.toScreen(x, y);
      return { x, y, sx: p.x, sy: p.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', native: {} };
    };
    const other = add('other');
    app.prefs.set('typePlaceholder', false);
    app.setTool('type');
    app.tool.onPointerDown(ev(300, 300));
    app.tool.onPointerUp(ev(300, 300));
    const s = app.typeSession;
    const id = s.id;
    s.insert('x');
    doc.transact('Edit other', () => doc.update(other, { text: 'changed' }));
    s.deleteBackward();
    key(s, 'Escape');
    expect(doc.has(id)).toBe(false);
    expect(doc.get(other).text).toBe('changed');
    doc.undo();
    expect(doc.get(id).text).toBe('');
    app.prefs.set('typePlaceholder', true);
  });

  it('cancelling a character options preview takes back previews made seconds apart', async () => {
    const { charPreview } = await import('../src/features/type/char-options.js');
    const id = add('Hello');
    edit(id).setSelection(0, 5);
    const steps = doc.undoStack.length;
    let now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const pv = charPreview(app, 'Underline Options');
      pv.preview({ underline: true });
      now += 3000;
      pv.preview({ underline: true, underlineStyle: { weight: 4 } });
      now += 3000;
      pv.preview({ underline: true, underlineStyle: { weight: 6 } });
      pv.cancel();
    } finally {
      spy.mockRestore();
    }
    expect(doc.undoStack.length).toBe(steps);
    expect(doc.get(id).runs).toBeUndefined();
  });

  it('Smart Punctuation on selected characters keeps exactly those characters selected', async () => {
    const { applySmartPunctuation } = await import('../src/features/type/smart-punctuation.js');
    const id = add('Wait... and -- then... the end');
    const s = edit(id);
    s.setSelection(0, 22);
    applySmartPunctuation(app, { ellipses: true, dashes: true }, 'selection');
    expect(doc.get(id).text).toBe('Wait\u2026 and \u2013 then\u2026 the end');
    expect(s.selectedText()).toBe('Wait\u2026 and \u2013 then\u2026');
  });

  it('the view scrolls to keep the caret visible (Find, typing and arrow keys past the window edge)', async () => {
    const { lastFind, findNext } = await import('../src/features/type/find.js');
    const view = app.editor.view;
    // A caret already in view does not move the view.
    const s = edit(add('visible'), 0);
    await Promise.resolve();
    const pan0 = [view.panX, view.panY];
    key(s, 'ArrowRight');
    s.insert('x');
    await Promise.resolve();
    expect([view.panX, view.panY]).toEqual(pan0);
    // Select All in a story running past the window keeps the view.
    const long = add('word\n'.repeat(300), { kind: 'area', width: 300, height: 9000 });
    const sl = edit(long, 0);
    await Promise.resolve();
    const pan1 = [view.panX, view.panY];
    sl.selectAll();
    await Promise.resolve();
    expect([view.panX, view.panY]).toEqual(pan1);
    // Cmd+End there scrolls to the caret.
    key(sl, 'End', { ctrlKey: true });
    await Promise.resolve();
    expect(view.panY).toBeLessThan(pan1[1]);
    // A match far outside the window is scrolled into view.
    const far = createText('a needle far away', 3000, 2500);
    doc.transact('Add', () => doc.insert(far, app.editor.targetLayer().id));
    Object.assign(lastFind, { query: 'needle', matchCase: false, wholeWord: false, includeLocked: false, includeHidden: false, backwards: false, current: null });
    expect(findNext(app)).toBe('found');
    expect(app.typeSession.id).toBe(far.id);
    await Promise.resolve();
    const p = view.toScreen(3000 + 20, 2500);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(view.width);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y).toBeLessThan(view.height);
  });

  it('typing or composing over a selection keeps the style of the first selected character', async () => {
    const { styleAt } = await import('../src/model/text-runs.js');
    const id = add('ab CD ef', { runs: [{ len: 3 }, { len: 2, fontWeight: 700 }, { len: 3 }] });
    const s = edit(id, 3);
    s.setSelection(3, 5);
    s.insert('X');
    expect(doc.get(id).text).toBe('ab X ef');
    expect(styleAt(doc.get(id), 3).fontWeight).toBe(700);
    s.setSelection(3, 4);
    s.onCompositionStart({});
    s.onCompositionUpdate({ data: 'に' });
    s.onCompositionEnd({ data: '日本' });
    expect(doc.get(id).text).toBe('ab 日本 ef');
    expect(styleAt(doc.get(id), 3).fontWeight).toBe(700);
    expect(styleAt(doc.get(id), 4).fontWeight).toBe(700);
    expect(styleAt(doc.get(id), 2).fontWeight).toBe(400);
  });

  it('typing after leaving and re-entering the same text is a separate undo step', () => {
    const id = add('Hello');
    let s = edit(id, 5);
    s.insert('A');
    app.getTool('type').endEditing();
    s = edit(id, 0);
    s.insert('B');
    expect(doc.get(id).text).toBe('BHelloA');
    doc.undo();
    expect(doc.get(id).text).toBe('HelloA');
  });

  it('dragging after a double or triple click extends the selection by whole words or paragraphs', async () => {
    const { caretPosition } = await import('../src/model/text-layout.js');
    const id = add('one two three\nfour five\nsix', { char: { fontSize: 20 } });
    const s = edit(id, 0);
    const at = (i) => {
      const c = caretPosition(s.layout(), i);
      const x = c.x + 1;
      const y = c.y - 5;
      const p = app.editor.view.toScreen(x, y);
      return { x, y, sx: p.x, sy: p.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', native: { buttons: 1 } };
    };
    const tool = app.tool;
    // Double-click "two", drag into "three": both words; back into "one": "one two".
    tool.onDoubleClick(at(5));
    expect(s.range()).toEqual([4, 7]);
    tool.onHover(at(10));
    expect(s.range()).toEqual([4, 13]);
    tool.onHover(at(1));
    expect([s.anchor, s.caret]).toEqual([7, 0]);
    // Releasing the button ends the drag.
    tool.onHover({ ...at(10), native: { buttons: 0 } });
    tool.onHover(at(10));
    expect([s.anchor, s.caret]).toEqual([7, 0]);
    // Triple-click in the first paragraph, drag into the second: both paragraphs.
    tool.onPointerDown(at(5));
    tool.onPointerUp(at(5));
    tool.onDoubleClick(at(5));
    tool.onPointerDown(at(5));
    expect(s.range()).toEqual([0, 14]);
    tool.onPointerMove(at(16));
    expect(s.range()).toEqual([0, 24]);
    tool.onPointerUp(at(16));
  });

  it('paragraph settings for a triple-clicked paragraph leave the next paragraph alone', async () => {
    const { applyParaStyle, currentParaStyle } = await import('../src/features/type/type-ops.js');
    const { paraAt } = await import('../src/model/text-runs.js');
    const id = add('first\nsecond\nthird');
    const s = edit(id, 0);
    s.selectParagraph(1);
    expect(s.range()).toEqual([0, 6]);
    applyParaStyle(app, { align: 'center' });
    expect(paraAt(doc.get(id), 0).align).toBe('center');
    expect(paraAt(doc.get(id), 1).align).toBe('left');
    expect(currentParaStyle(app).align).toBe('center');
    // A selection reaching into the next paragraph still includes it.
    s.setSelection(0, 7);
    expect(currentParaStyle(app).align).toBe('mixed');
  });

  it('size, leading, tracking and baseline shortcuts step mixed characters each from their own value', async () => {
    const { styleAt } = await import('../src/model/text-runs.js');
    const id = add('small BIG', { char: { fontSize: 12 }, runs: [{ len: 6 }, { len: 3, fontSize: 40, tracking: 50 }] });
    const s = edit(id, 0);
    s.setSelection(0, 9);
    key(s, '.', { metaKey: true, ctrlKey: true, shiftKey: true });
    let n = doc.get(id);
    expect(styleAt(n, 0).fontSize).toBe(14);
    expect(styleAt(n, 7).fontSize).toBe(42);
    key(s, 'ArrowRight', { altKey: true });
    n = doc.get(id);
    expect(styleAt(n, 0).tracking).toBe(20);
    expect(styleAt(n, 7).tracking).toBe(70);
    // Auto leading steps from each size's own auto leading.
    key(s, 'ArrowDown', { altKey: true });
    n = doc.get(id);
    expect(styleAt(n, 0).leading).toBeCloseTo(14 * 1.2 + 2);
    expect(styleAt(n, 7).leading).toBeCloseTo(42 * 1.2 + 2);
    key(s, 'ArrowUp', { altKey: true, shiftKey: true });
    n = doc.get(id);
    expect(styleAt(n, 0).baselineShift).toBe(2);
    // With the objects selected (not editing) the menu command does the same.
    app.getTool('type').exitToSelection();
    await app.commands.run('type.sizeDown');
    n = doc.get(id);
    expect(styleAt(n, 0).fontSize).toBe(12);
    expect(styleAt(n, 7).fontSize).toBe(40);
  });

  it('arrow keys in a Character panel field showing mixed values step each character, not from zero', async () => {
    const { styleAt } = await import('../src/model/text-runs.js');
    const id = add('small BIG', { char: { fontSize: 12 }, runs: [{ len: 6 }, { len: 3, fontSize: 40 }] });
    app.editor.select([id]);
    const p = app.dock.panels.get('character');
    p.ensureBuilt();
    p.update();
    const input = p.el.querySelector('input[aria-label="Font size"]');
    expect(input.value).toBe('');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const n = doc.get(id);
    expect(styleAt(n, 0).fontSize).toBe(13);
    expect(styleAt(n, 7).fontSize).toBe(41);
  });

  it('type on a closed path starts where the path was clicked', async () => {
    const { createPath } = await import('../src/model/nodes.js');
    const { layoutText, glyphPlacements } = await import('../src/model/text-layout.js');
    const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
    const sq = createPath([pt(100, 100), pt(300, 100), pt(300, 300), pt(100, 300)], true);
    doc.transact('Add', () => doc.insert(sq, app.editor.targetLayer().id));
    app.setTool('type-on-path');
    const p = app.editor.view.toScreen(300, 200);
    const ev = { x: 300, y: 200, sx: p.x, sy: p.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', native: {} };
    app.tool.onPointerDown(ev);
    app.tool.onPointerUp(ev);
    const t = [...doc.nodes.values()].find((n) => n.type === 'text');
    expect(t.pathOptions.start).toBeCloseTo(300);
    // The first character sits on the right edge, where the click was.
    const g = glyphPlacements(layoutText(t))[0];
    expect(g.m[4]).toBeCloseTo(300, 0);
  });
});
