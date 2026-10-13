// Type menu layout commands: bullets and numbering, optical margins,
// orientation, type on a path effects and options, vertical tools, glyph snapping.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText, createPath } from '../src/model/nodes.js';
import { layoutText, extraPlacements } from '../src/model/text-layout.js';
import { paraAt } from '../src/model/text-runs.js';
import { listToTextPatch, glyphSnapPoints } from '../src/features/type/layout-commands.js';
import { buildSnapIndex, snapHooks } from '../src/tools/snap.js';

const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 40 };
let app;
let doc;

function add(node) {
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return doc.get(node.id);
}

const p = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });

beforeEach(async () => {
  app = await bootAppWithFeatures();
  if (!app.editor) app.newDocument();
  doc = app.editor.doc;
});

describe('bullets and numbering', () => {
  it('Apply Bullets toggles a list with a hanging indent on the selected type', () => {
    const t = add(createText('one\ntwo', 0, 0, { kind: 'area', width: 400, height: 400, char: { ...CHAR } }));
    app.editor.select([t.id]);
    app.commands.run('type.bullets');
    let n = doc.get(t.id);
    expect(n.para.list).toEqual({ kind: 'bullet', bullet: '•' });
    expect(n.para.indentLeft).toBe(18);
    expect(n.para.indentFirst).toBe(-18);
    expect(app.commands.get('type.bullets').checked(app)).toBe(true);
    expect(extraPlacements(layoutText(n)).map((g) => g.ch)).toEqual(['•', '•']);
    app.commands.run('type.numbering');
    n = doc.get(t.id);
    expect(n.para.list.kind).toBe('number');
    expect(extraPlacements(layoutText(n)).map((g) => g.ch)).toEqual(['1.', '2.']);
    app.commands.run('type.numbering');
    expect(doc.get(t.id).para.list).toBeNull();
    app.commands.run('edit.undo');
    expect(doc.get(t.id).para.list.kind).toBe('number');
  });

  it('applies to the paragraphs of the text selection while editing', () => {
    const t = add(createText('one\ntwo\nthree', 0, 0, { kind: 'area', width: 400, height: 400, char: { ...CHAR } }));
    app.setTool('type');
    const s = app.tool.editText(t.id);
    s.setSelection(5, 9);
    app.commands.run('type.numbering');
    const n = doc.get(t.id);
    expect(paraAt(n, 0).list).toBeNull();
    expect(paraAt(n, 1).list.kind).toBe('number');
    expect(paraAt(n, 2).list.kind).toBe('number');
    expect(extraPlacements(layoutText(n)).map((g) => g.ch)).toEqual(['1.', '2.']);
  });

  it('Convert to Text writes the markers into the text with a tab', () => {
    const t = createText('one\ntwo', 0, 0, { kind: 'area', width: 400, height: 400, char: { ...CHAR }, para: { align: 'left', indentLeft: 18, indentFirst: -18, list: { kind: 'number', format: 'A', suffix: ')' } } });
    const patch = listToTextPatch(t);
    const n = { ...t, ...patch };
    expect(n.text).toBe('A)\tone\nB)\ttwo');
    expect(paraAt(n, 0).list).toBeNull();
    expect(paraAt(n, 1).tabs).toEqual([{ pos: 18, align: 'left' }]);
    expect(extraPlacements(layoutText(n))).toHaveLength(0);
  });
});

describe('paragraph and orientation options', () => {
  it('Optical Margin Alignment toggles for the whole story', () => {
    const t = add(createText('"Quoted"', 0, 0, { kind: 'area', width: 400, height: 400, char: { ...CHAR } }));
    app.editor.select([t.id]);
    app.commands.run('type.opticalMargin');
    expect(doc.get(t.id).para.opticalMargin).toBe(true);
    expect(app.commands.get('type.opticalMargin').checked(app)).toBe(true);
    expect(layoutText(doc.get(t.id)).lines[0].x).toBeLessThan(0);
  });

  it('Type Orientation switches between horizontal and vertical', () => {
    const t = add(createText('Hi', 0, 50, { char: { ...CHAR } }));
    app.editor.select([t.id]);
    expect(app.commands.get('type.orientation.horizontal').checked(app)).toBe(true);
    app.commands.run('type.orientation.vertical');
    expect(doc.get(t.id).vertical).toBe(true);
    expect(layoutText(doc.get(t.id)).vertical).toBe(true);
    app.commands.run('type.orientation.horizontal');
    expect(doc.get(t.id).vertical).toBeUndefined();
  });
});

describe('type on a path', () => {
  const pathType = () => add(createText('Along the path', 0, 0, { kind: 'path', pathAnchors: [p(0, 100), p(300, 100)], pathOptions: { effect: 'rainbow', align: 'baseline', start: 0 }, char: { ...CHAR } }));

  it('effect commands set and check the effect', () => {
    const t = pathType();
    app.editor.select([t.id]);
    expect(app.commands.get('type.path.rainbow').checked(app)).toBe(true);
    app.commands.run('type.path.stairStep');
    expect(doc.get(t.id).pathOptions.effect).toBe('stair');
    expect(app.commands.get('type.path.stairStep').checked(app)).toBe(true);
    app.commands.run('type.path.gravity');
    expect(doc.get(t.id).pathOptions.effect).toBe('gravity');
  });

  it('Update completes the options and keeps the start on the path', () => {
    const t = add(createText('x', 0, 0, { kind: 'path', pathAnchors: [p(0, 0), p(100, 0)], pathOptions: { start: 5000 }, char: { ...CHAR } }));
    app.editor.select([t.id]);
    app.commands.run('type.path.update');
    const o = doc.get(t.id).pathOptions;
    expect(o.effect).toBe('rainbow');
    expect(o.align).toBe('baseline');
    expect(o.start).toBeLessThanOrEqual(100);
  });

  it('the options dialog previews and commits as one step', async () => {
    const t = pathType();
    app.editor.select([t.id]);
    const done = app.commands.run('type.pathOptions');
    await new Promise((r) => setTimeout(r, 0));
    const dialog = document.querySelector('dialog[open]');
    const select = dialog.querySelector('select');
    select.value = 'skew';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(doc.get(t.id).pathOptions.effect).toBe('skew');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(doc.get(t.id).pathOptions.effect).toBe('skew');
    app.commands.run('edit.undo');
    expect(doc.get(t.id).pathOptions.effect).toBe('rainbow');
  });
});

describe('vertical tools', () => {
  it('Vertical Type on a Path turns a path into vertical path type', () => {
    const path = add(createPath([p(0, 0), p(300, 0)], false));
    app.setTool('vertical-type-on-path');
    expect(app.tool.constructor.vertical).toBe(true);
    app.tool.pathTypeFrom(doc.get(path.id));
    const t = doc.leaves().find((n) => n.type === 'text');
    expect(t.kind).toBe('path');
    expect(t.vertical).toBe(true);
    app.tool.endEditing();
  });

  it('Vertical Area Type makes vertical area type from a drag', () => {
    app.setTool('vertical-area-type');
    const ev = (x, y) => ({ x, y, sx: x, sy: y, shift: false, alt: false, mod: false });
    app.tool.onPointerDown(ev(10, 10));
    app.tool.onPointerMove(ev(200, 200));
    app.tool.onPointerUp(ev(200, 200));
    const t = doc.leaves().find((n) => n.type === 'text');
    expect(t.kind).toBe('area');
    expect(t.vertical).toBe(true);
    app.tool.endEditing();
  });
});

describe('snap to letterforms', () => {
  it('adds baseline and x-height points of visible type', () => {
    add(createText('Snap here', 50, 100, { char: { ...CHAR } }));
    const points = [];
    glyphSnapPoints(app.editor, points, { exclude: new Set(), visible: { x: -1e6, y: -1e6, w: 2e6, h: 2e6 } });
    expect(points.some((q) => q.label === 'baseline' && Math.abs(q.y - 100) < 1e-6)).toBe(true);
    expect(points.some((q) => q.label === 'x-height' && q.y < 100)).toBe(true);
    app.editor.setViewOption('snapGlyph', false);
    const none = [];
    glyphSnapPoints(app.editor, none, { exclude: new Set(), visible: { x: -1e6, y: -1e6, w: 2e6, h: 2e6 } });
    expect(none).toHaveLength(0);
    expect(app.commands.get('view.snapGlyph').checked(app)).toBe(false);
    app.commands.run('view.snapGlyph');
    expect(app.editor.viewOptions.snapGlyph).toBe(true);
    expect(snapHooks.has(glyphSnapPoints)).toBe(true);
    expect(buildSnapIndex(app.editor).index).toBeTruthy();
  });
});
