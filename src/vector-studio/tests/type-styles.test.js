import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { styleAt, paraAt, applyRunStyle } from '../src/model/text-runs.js';
import { styleLists, resolvePara, resolveChar, restyleNode, charStyleState, paraStyleState, wouldCycle, NORMAL, listsFromRoot } from '../src/features/type/text-styles.js';
import {
  applyStyle,
  newStyle,
  clearOverrides,
  redefineStyle,
  deleteStyles,
  duplicateStyle,
  updateStyle,
  currentStyleState,
  sortStyles,
  unusedStyles,
  openStyleOptions,
} from '../src/features/type/styles-panel.js';
import { typeDefaults } from '../src/features/type/type-ops.js';

function add(app, node) {
  const doc = app.editor.doc;
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return doc.get(node.id);
}

function edit(app, id, a, b) {
  app.setTool('type');
  const s = app.tool.editText(id);
  s.setSelection(a, b);
  return s;
}

function addStyle(app, kind, style) {
  const doc = app.editor.doc;
  const key = kind === 'char' ? 'charStyles' : 'paraStyles';
  // Keep a stored Normal style (new documents store the Normal Paragraph Style's composer).
  doc.transact('Add style', () => doc.updateRoot({ [key]: [...(doc.root[key] || []), style] }));
}

describe('style model', () => {
  it('resolves based-on chains, paragraph styles on top of the Normal style, and survives cycles', () => {
    const lists = listsFromRoot({
      charStyles: [
        { id: 'a', name: 'A', basedOn: 'b', attrs: { fontWeight: 700 } },
        { id: 'b', name: 'B', basedOn: 'a', attrs: { fontStyle: 'italic', fontWeight: 300 } },
      ],
      paraStyles: [
        { id: NORMAL, name: 'Normal Paragraph Style', attrs: { fontSize: 14 } },
        { id: 'h', name: 'Heading', basedOn: null, attrs: { fontWeight: 700, spaceAfter: 6 } },
        { id: 'h2', name: 'Sub', basedOn: 'h', attrs: { fontSize: 11 } },
      ],
    });
    expect(resolveChar(lists.char, 'a')).toEqual({ fontStyle: 'italic', fontWeight: 700 });
    expect(resolveChar(lists.char, NORMAL)).toEqual({});
    const sub = resolvePara(lists.para, 'h2');
    expect(sub.fontSize).toBe(11);
    expect(sub.fontWeight).toBe(700);
    expect(sub.spaceAfter).toBe(6);
    expect(resolvePara(lists.para, 'h').fontSize).toBe(14);
    expect(resolvePara(lists.para, 'missing').fontSize).toBe(14);
    expect(wouldCycle(lists.para, 'h', 'h2', true)).toBe(true);
    expect(wouldCycle(lists.para, 'h2', 'h', true)).toBe(false);
  });

  it('restyles a node keeping local overrides', () => {
    const lists = listsFromRoot({ charStyles: [{ id: 'em', name: 'Em', attrs: { fontStyle: 'italic' } }] });
    let n = createText('Hello world', 0, 0);
    const p = restyleNode(n, { oldLists: lists, charTarget: (s) => (s >= 0 ? { id: 'em' } : null) });
    n = { ...n, ...p };
    expect(styleAt(n, 3).fontStyle).toBe('italic');
    expect(styleAt(n, 3).charStyle).toBe('em');
    expect(charStyleState(lists, n, 0, 5)).toEqual({ id: 'em', override: false });
    // An override, then the style changes: the override stays, other attributes follow.
    n = { ...n, runs: applyRunStyle(n, 0, 5, { fontSize: 30 }) };
    expect(charStyleState(lists, n, 0, 5).override).toBe(true);
    const next = listsFromRoot({ charStyles: [{ id: 'em', name: 'Em', attrs: { fontStyle: 'italic', fontWeight: 700 } }] });
    n = { ...n, ...restyleNode(n, { oldLists: lists, newLists: next }) };
    expect(styleAt(n, 0).fontSize).toBe(30);
    expect(styleAt(n, 0).fontWeight).toBe(700);
    expect(styleAt(n, 8).fontWeight).toBe(700);
    expect(styleAt(n, 8).fontSize).toBe(12);
  });
});

describe('Character and Paragraph Styles', () => {
  let app;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
  });

  it('creates a character style from the selection, applies it and undoes in one step', () => {
    const t = add(app, createText('Hello world', 100, 100));
    const s = edit(app, t.id, 0, 5);
    app.tool.keyActions().toggle('bold');
    const id = newStyle(app, 'char', { name: 'Strong' });
    const doc = app.editor.doc;
    const st = styleLists(doc).char.find((x) => x.id === id);
    expect(st.name).toBe('Strong');
    expect(st.attrs.fontWeight).toBe(700);
    expect(styleAt(doc.get(t.id), 2).charStyle).toBe(id);
    expect(currentStyleState(app, 'char')).toMatchObject({ id, override: false });
    doc.undo();
    expect(styleLists(doc).char.find((x) => x.id === id)).toBeUndefined();
    expect(styleAt(doc.get(t.id), 2).charStyle).toBeNull();
    s.setSelection(6, 11);
  });

  it('applies a character style to selected characters, detects overrides and clears them', () => {
    const t = add(app, createText('Hello world', 100, 100));
    addStyle(app, 'char', { id: 'em', name: 'Emphasis', basedOn: null, attrs: { fontStyle: 'italic', fill: { type: 'solid', color: '#ff0000' } } });
    edit(app, t.id, 6, 11);
    applyStyle(app, 'char', 'em');
    const doc = app.editor.doc;
    let n = doc.get(t.id);
    expect(styleAt(n, 7).fontStyle).toBe('italic');
    expect(styleAt(n, 7).fill).toEqual({ type: 'solid', color: '#ff0000' });
    expect(styleAt(n, 2).fontStyle).toBe('normal');
    // Override inside the styled range.
    doc.transact('size', () => doc.update(t.id, { runs: applyRunStyle(doc.get(t.id), 6, 8, { fontSize: 20 }) }));
    app.typeSession.setSelection(6, 11);
    expect(currentStyleState(app, 'char')).toMatchObject({ id: 'em', override: true });
    clearOverrides(app, 'char');
    n = doc.get(t.id);
    expect(styleAt(n, 6).fontSize).toBe(12);
    expect(styleAt(n, 6).fontStyle).toBe('italic');
    expect(currentStyleState(app, 'char').override).toBe(false);
    // Back to Normal: the attributes the style gave go back to the paragraph's.
    applyStyle(app, 'char', NORMAL);
    n = doc.get(t.id);
    expect(styleAt(n, 7).fontStyle).toBe('normal');
    expect(styleAt(n, 7).fill).toEqual({ type: 'solid', color: '#000000' });
    expect(n.runs).toBeUndefined();
  });

  it('paragraph styles set paragraph and character attributes; character styles win inside them', () => {
    const t = add(app, createText('Title\nBody text here', 100, 100));
    addStyle(app, 'char', { id: 'em', name: 'Emphasis', basedOn: null, attrs: { fontStyle: 'italic', fontSize: 9 } });
    addStyle(app, 'para', { id: 'head', name: 'Heading', basedOn: null, attrs: { fontSize: 24, fontWeight: 700, align: 'center', spaceAfter: 8 } });
    const doc = app.editor.doc;
    edit(app, t.id, 6, 10);
    applyStyle(app, 'char', 'em');
    // Paragraph style on both paragraphs.
    app.typeSession.setSelection(0, 20);
    applyStyle(app, 'para', 'head');
    const n = doc.get(t.id);
    expect(paraAt(n, 0).align).toBe('center');
    expect(paraAt(n, 1).paraStyle).toBe('head');
    expect(styleAt(n, 2).fontSize).toBe(24);
    expect(styleAt(n, 12).fontWeight).toBe(700);
    // The character style keeps its size and italic, takes the rest from the paragraph style.
    expect(styleAt(n, 7).fontSize).toBe(9);
    expect(styleAt(n, 7).fontStyle).toBe('italic');
    expect(styleAt(n, 7).fontWeight).toBe(700);
    const lists = styleLists(doc);
    expect(paraStyleState(lists, n, 0, 1)).toEqual({ id: 'head', override: false });
  });

  it('applies to the paragraph at the caret only, and Alt-apply clears overrides', () => {
    const t = add(app, createText('One\nTwo\nThree', 100, 100));
    addStyle(app, 'para', { id: 'q', name: 'Quote', basedOn: null, attrs: { indentLeft: 20 } });
    const doc = app.editor.doc;
    edit(app, t.id, 5, 5);
    app.tool.keyActions().toggle('italic');
    app.typeSession.setSelection(4, 7);
    app.tool.keyActions().toggle('italic');
    app.typeSession.setSelection(5, 5);
    applyStyle(app, 'para', 'q');
    let n = doc.get(t.id);
    expect(paraAt(n, 0).indentLeft).toBe(0);
    expect(paraAt(n, 1).indentLeft).toBe(20);
    expect(paraAt(n, 2).paraStyle).toBeNull();
    expect(styleAt(n, 5).fontStyle).toBe('italic'); // override kept
    applyStyle(app, 'para', 'q', { clear: true });
    n = doc.get(t.id);
    expect(styleAt(n, 5).fontStyle).toBe('normal');
  });

  it('redefines a style from the selection; other text using it follows but keeps its overrides', () => {
    const a = add(app, createText('Alpha', 0, 0));
    const b = add(app, createText('Beta', 0, 50));
    const c = add(app, createText('Gamma', 0, 100));
    addStyle(app, 'para', { id: 'p', name: 'Body', basedOn: null, attrs: { fontSize: 10 } });
    const doc = app.editor.doc;
    app.editor.select([a.id, b.id, c.id]);
    applyStyle(app, 'para', 'p');
    expect(styleAt(doc.get(c.id), 0).fontSize).toBe(10);
    // c gets a local override of its weight.
    doc.transact('w', () => doc.update(c.id, { char: { ...doc.get(c.id).char, fontWeight: 700 } }));
    // a: change size and family, then redefine from it.
    app.editor.select([a.id]);
    doc.transact('s', () => doc.update(a.id, { char: { ...doc.get(a.id).char, fontSize: 16, fontFamily: 'Lora' } }));
    expect(currentStyleState(app, 'para')).toMatchObject({ id: 'p', override: true });
    expect(redefineStyle(app, 'para')).toBe(true);
    const st = styleLists(doc).para.find((x) => x.id === 'p');
    expect(st.attrs).toMatchObject({ fontSize: 16, fontFamily: 'Lora' });
    expect(styleAt(doc.get(b.id), 0)).toMatchObject({ fontSize: 16, fontFamily: 'Lora' });
    expect(styleAt(doc.get(c.id), 0)).toMatchObject({ fontSize: 16, fontFamily: 'Lora', fontWeight: 700 });
    expect(currentStyleState(app, 'para').override).toBe(false);
    doc.undo();
    expect(styleAt(doc.get(b.id), 0).fontSize).toBe(10);
  });

  it('style options changes propagate; based-on changes restyle; Normal edits reach new type', () => {
    const t = add(app, createText('Text', 0, 0));
    addStyle(app, 'para', { id: 'base', name: 'Base', basedOn: null, attrs: { fontFamily: 'Lato' } });
    addStyle(app, 'para', { id: 'child', name: 'Child', basedOn: 'base', attrs: { fontSize: 18 } });
    const doc = app.editor.doc;
    app.editor.select([t.id]);
    applyStyle(app, 'para', 'child');
    expect(styleAt(doc.get(t.id), 0)).toMatchObject({ fontFamily: 'Lato', fontSize: 18 });
    updateStyle(app, 'para', 'base', { attrs: { fontFamily: 'Roboto' } });
    expect(styleAt(doc.get(t.id), 0).fontFamily).toBe('Roboto');
    updateStyle(app, 'para', 'child', { basedOn: null });
    expect(styleAt(doc.get(t.id), 0).fontFamily).toBe('Inter');
    app.editor.clearSelection();
    updateStyle(app, 'para', NORMAL, { attrs: { fontSize: 15 } });
    expect(typeDefaults(app).char.fontSize).toBe(15);
    expect(styleAt(doc.get(t.id), 0).fontSize).toBe(18);
  });

  it('deletes styles keeping attributes or reassigning, and rebases dependents', () => {
    const t = add(app, createText('Hello', 0, 0));
    const u = add(app, createText('World', 0, 40));
    addStyle(app, 'para', { id: 'x', name: 'X', basedOn: null, attrs: { fontSize: 30 } });
    addStyle(app, 'para', { id: 'y', name: 'Y', basedOn: 'x', attrs: { fontWeight: 700 } });
    addStyle(app, 'char', { id: 'k', name: 'K', basedOn: null, attrs: { fontStyle: 'italic' } });
    const doc = app.editor.doc;
    app.editor.select([t.id]);
    applyStyle(app, 'para', 'x');
    applyStyle(app, 'char', 'k');
    app.editor.select([u.id]);
    applyStyle(app, 'para', 'x');
    deleteStyles(app, 'para', ['x']);
    const lists = styleLists(doc);
    expect(lists.para.find((s) => s.id === 'x')).toBeUndefined();
    const y = lists.para.find((s) => s.id === 'y');
    expect(y.basedOn).toBeNull();
    expect(resolvePara(lists.para, 'y').fontSize).toBe(30);
    let n = doc.get(t.id);
    expect(paraAt(n, 0).paraStyle).toBeNull();
    expect(styleAt(n, 0).fontSize).toBe(30);
    // Reassign a character style.
    deleteStyles(app, 'char', ['k'], { replaceWith: NORMAL });
    n = doc.get(t.id);
    expect(styleAt(n, 0).charStyle).toBeNull();
    expect(styleAt(n, 0).fontStyle).toBe('normal');
    doc.undo();
    expect(styleAt(doc.get(t.id), 0).charStyle).toBe('k');
  });

  it('duplicates, sorts, finds unused styles; Normal cannot be deleted', () => {
    const t = add(app, createText('Hello', 0, 0));
    addStyle(app, 'char', { id: 'b', name: 'Beta', basedOn: null, attrs: { fontWeight: 700 } });
    addStyle(app, 'char', { id: 'a', name: 'Alpha', basedOn: null, attrs: { fontStyle: 'italic' } });
    const doc = app.editor.doc;
    const copy = duplicateStyle(app, 'char', 'b');
    let names = styleLists(doc).char.map((s) => s.name);
    expect(names).toEqual(['Normal Character Style', 'Beta', 'Beta copy', 'Alpha']);
    sortStyles(app, 'char');
    names = styleLists(doc).char.map((s) => s.name);
    expect(names).toEqual(['Normal Character Style', 'Alpha', 'Beta', 'Beta copy']);
    app.editor.select([t.id]);
    applyStyle(app, 'char', 'a');
    expect(unusedStyles(doc, 'char').sort()).toEqual(['b', copy].sort());
    expect(deleteStyles(app, 'char', [NORMAL])).toBe(0);
  });

  it('with nothing selected, a style becomes the default for new type', () => {
    addStyle(app, 'para', { id: 'h', name: 'Heading', basedOn: null, attrs: { fontSize: 28, align: 'center' } });
    app.editor.clearSelection();
    applyStyle(app, 'para', 'h');
    const d = typeDefaults(app);
    expect(d.char.fontSize).toBe(28);
    expect(d.para.align).toBe('center');
    expect(d.para.paraStyle).toBe('h');
    expect(currentStyleState(app, 'para').id).toBe('h');
  });

  it('the panels list styles, apply on click and show the override marker', async () => {
    const t = add(app, createText('Hello', 0, 0));
    addStyle(app, 'char', { id: 'em', name: 'Emphasis', basedOn: null, attrs: { fontStyle: 'italic' } });
    app.editor.select([t.id]);
    app.openPanel('characterStyles');
    const panel = app.dock.panels.get('characterStyles');
    panel.shown();
    panel.renderKey = null;
    panel.update();
    const items = [...panel.el.querySelectorAll('.st-item')];
    expect(items.map((i) => i.textContent)).toEqual(['[Normal Character Style]', 'Emphasis']);
    items[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(styleAt(app.editor.doc.get(t.id), 0).fontStyle).toBe('italic');
    const doc = app.editor.doc;
    doc.transact('size', () => doc.update(t.id, { char: { ...doc.get(t.id).char, fontSize: 40 } }));
    panel.update();
    const active = panel.el.querySelector('.st-item.active');
    expect(active.dataset.id).toBe('em');
    expect(active.querySelector('.st-plus')).not.toBeNull();
    expect(panel.clearBtn.disabled).toBe(false);
    // Keyboard: Enter on the focused row applies it.
    panel.focusId = NORMAL;
    panel.list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(styleAt(doc.get(t.id), 0).fontStyle).toBe('normal');
    const para = app.dock.panels.get('paragraphStyles');
    para.shown();
    expect(para.el.querySelectorAll('.st-item').length).toBe(1);
  });

  it('Style Options previews live, commits on OK and rolls back on Cancel', async () => {
    const t = add(app, createText('Hello', 0, 0));
    addStyle(app, 'char', { id: 'em', name: 'Emphasis', basedOn: null, attrs: { fontStyle: 'italic' } });
    const doc = app.editor.doc;
    app.editor.select([t.id]);
    applyStyle(app, 'char', 'em');
    const undoDepth = doc.undoStack.length;
    const run = async (button, edit) => {
      const p = openStyleOptions(app, 'char', 'em');
      await Promise.resolve();
      const dlg = document.querySelector('dialog.style-options-dialog');
      edit(dlg);
      [...dlg.querySelectorAll('.dialog-footer .btn')].find((b) => b.textContent === button).click();
      return p;
    };
    const setSize = (dlg) => {
      const label = [...dlg.querySelectorAll('label')].find((l) => l.textContent === 'Size');
      const input = dlg.querySelector(`#${label.htmlFor}`);
      input.value = '33';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      expect(styleAt(doc.get(t.id), 0).fontSize).toBe(33); // live preview
    };
    expect(await run('Cancel', setSize)).toBe(false);
    expect(styleAt(doc.get(t.id), 0).fontSize).toBe(12);
    expect(doc.undoStack.length).toBe(undoDepth);
    expect(await run('OK', setSize)).toBe(true);
    expect(styleAt(doc.get(t.id), 0).fontSize).toBe(33);
    expect(styleLists(doc).char.find((s) => s.id === 'em').attrs.fontSize).toBe(33);
    expect(doc.undoStack.length).toBe(undoDepth + 1);
  });
});
