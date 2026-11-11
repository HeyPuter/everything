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
});
