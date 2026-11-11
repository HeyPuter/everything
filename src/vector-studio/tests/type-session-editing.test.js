import { describe, it, expect, beforeEach } from 'vitest';
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
});
