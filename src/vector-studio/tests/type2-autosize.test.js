// Auto-sized area type: threaded and multi-column frames, turning Auto
// Size off when the height is set by hand, and vertical alignment of text
// that wraps around objects.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText, createPath } from '../src/model/nodes.js';
import { layoutText, autoSized, autoGrows } from '../src/model/text-layout.js';
import { transformNodes } from '../src/model/geometry.js';
import { autoHeight } from '../src/features/type/type-options.js';
import { threadFrames } from '../src/features/type/thread-model.js';

// The test canvas measures every character 0.06 em wide.
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 40 };
const STORY = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');

let app;
let doc;

function add(node) {
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return doc.get(node.id);
}

function frame(x, y, text = '', extra = {}) {
  return add(createText(text, x, y, { kind: 'area', width: 80, height: 40, char: { ...createText('', 0, 0).char, ...CHAR }, ...extra }));
}

function rect(x, y, w, h) {
  const p = (px, py) => ({ x: px, y: py, ix: px, iy: py, ox: px, oy: py });
  return add(createPath([p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h)], true));
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
  if (!app.editor) app.newDocument();
  doc = app.editor.doc;
});

describe('Auto Size', () => {
  it('turns off when the frame height is changed by hand, not when only the width is', () => {
    const t = frame(0, 0, 'Hello', { areaOptions: { autoSize: true } });
    doc.transact('Scale', () => transformNodes(doc, [t.id], [2, 0, 0, 1, 0, 0]));
    expect(doc.get(t.id).areaOptions.autoSize).toBe(true);
    const fitted = doc.get(t.id).height;
    doc.transact('Scale', () => transformNodes(doc, [t.id], [1, 0, 0, 3, 0, 0]));
    expect(doc.get(t.id).areaOptions.autoSize).toBeFalsy();
    expect(doc.get(t.id).height).toBeCloseTo(fitted * 3);
    doc.undo();
    expect(doc.get(t.id).areaOptions.autoSize).toBe(true);
  });

  it('grows the last frame of a threaded story to hold the rest of the story', () => {
    const a = frame(0, 0, STORY);
    const b = frame(200, 0);
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    let [h, last] = threadFrames(doc, doc.get(a.id));
    expect(layoutText(last).story.overflow).toBe(true);
    // Only the last frame can grow.
    expect(autoSized({ ...h, areaOptions: { autoSize: true } })).toBe(false);
    doc.transact('Auto Size', () => doc.update(last.id, { areaOptions: { autoSize: true } }));
    last = doc.get(last.id);
    expect(autoSized(last)).toBe(true);
    expect(autoGrows(last)).toBe(true);
    const lay = layoutText(last);
    expect(lay.overflow).toBe(false);
    const height = autoHeight(last);
    expect(height).toBeGreaterThan(40);
    // Typing in the first frame refits the last one in the same step.
    doc.transact('Type', () => doc.update(h.id, { text: `${STORY} ${STORY}` }));
    expect(doc.get(last.id).height).toBeGreaterThan(height);
    expect(layoutText(doc.get(last.id)).overflow).toBe(false);
    doc.undo();
    expect(doc.get(last.id).height).toBeCloseTo(height);
  });

  it('fits a frame of several columns to its text with balanced columns', () => {
    const t = frame(0, 0, STORY, { width: 300, height: 20, areaOptions: { columns: 2, columnGutter: 10 } });
    expect(layoutText(t).overflow).toBe(true);
    doc.transact('Auto Size', () => doc.update(t.id, { areaOptions: { ...t.areaOptions, autoSize: true } }));
    const n = doc.get(t.id);
    expect(autoSized(n)).toBe(true);
    expect(autoGrows(n)).toBe(false);
    const h = autoHeight(n);
    expect(layoutText({ ...n, height: h }).overflow).toBe(false);
    expect(layoutText({ ...n, height: h - 2 }).overflow).toBe(true);
    const lay = layoutText({ ...n, height: h });
    const perCell = [0, 1].map((c) => lay.lines.filter((l) => l.cell === c).length);
    expect(Math.abs(perCell[0] - perCell[1])).toBeLessThanOrEqual(1);
    // Edits keep it fitted.
    doc.transact('Type', () => doc.update(t.id, { text: `${STORY} ${STORY}` }));
    expect(layoutText(doc.get(t.id)).overflow).toBe(false);
    expect(doc.get(t.id).height).toBeGreaterThan(h);
  });
});

describe('vertical alignment with text wrap', () => {
  it('moves wrapped text down to the bottom or the middle of the frame', () => {
    const r = rect(-10, -10, 150, 60);
    app.editor.select([r.id]);
    app.commands.run('textWrap.make');
    const text = 'word0 word1 word2 word3 word4 word5';
    const mk = (va) => frame(0, 0, text, { width: 400, height: 400, areaOptions: { verticalAlign: va } });
    const t = mk('top');
    const b = mk('bottom');
    const c = mk('center');
    // Frames are above the object in the stacking order, so the object wraps them.
    const top = layoutText(doc.get(t.id));
    const bottom = layoutText(doc.get(b.id));
    const center = layoutText(doc.get(c.id));
    const end = (lay) => lay.lines[lay.lines.length - 1].y + lay.lines[lay.lines.length - 1].desc;
    expect(end(bottom)).toBeGreaterThan(end(top) + 100);
    expect(end(bottom)).toBeLessThanOrEqual(400.01);
    expect(400 - end(bottom)).toBeLessThan(10);
    const gapAbove = center.lines[0].y - center.lines[0].asc - 0;
    const gapBelow = 400 - end(center);
    expect(Math.abs(gapAbove - gapBelow)).toBeLessThan(10);
    // Lines that move out of the object's band take the full width.
    expect(bottom.lines[0].x).toBeLessThan(1);
    expect(bottom.overflow).toBe(false);
  });
});
