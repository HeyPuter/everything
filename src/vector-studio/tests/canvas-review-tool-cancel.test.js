import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { anchor } from '../src/model/bezier.js';

let clock = 0;
const ptr = (x, y, extra = {}) => ({
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  clientX: x,
  clientY: y,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  timeStamp: (clock += 1000),
  ...extra,
});

describe('a canceled press (pointercancel, Escape, a second finger) ends cleanly', () => {
  let app;
  let doc;
  let id;
  beforeAll(() => {
    app = bootApp();
    app.newDocument();
  });
  beforeEach(() => {
    const ed = app.editor;
    doc = ed.doc;
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const p = createPath([anchor(100, 100), anchor(300, 100)], false, {
      stroke: { type: 'solid', color: '#000000' },
    });
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    id = p.id;
    ed.select([id]);
  });

  it('Path Eraser: a canceled stroke is undone and leaves no transaction open', () => {
    app.setTool('path-eraser');
    const input = app.input;
    const steps = doc.undoStack.length;
    input.down(ptr(200, 100));
    input.move(ptr(210, 100));
    input.cancel(ptr(210, 100));
    expect(doc.tx).toBeFalsy();
    expect(doc.undoStack.length).toBe(steps);
    expect(doc.get(id).anchors).toHaveLength(2);
    // The document still takes edits.
    expect(() => doc.transact('Edit', () => doc.update(id, { opacity: 0.5 }))).not.toThrow();
    app.setTool('selection');
  });

  it('Anchor Point: a canceled handle drag is undone and leaves no transaction open', () => {
    app.setTool('anchor-point');
    const input = app.input;
    const steps = doc.undoStack.length;
    input.down(ptr(300, 100));
    input.move(ptr(330, 140));
    input.cancel(ptr(330, 140));
    expect(doc.tx).toBeFalsy();
    expect(doc.undoStack.length).toBe(steps);
    expect(doc.get(id).anchors[1]).toMatchObject({ ox: 300, oy: 100 });
    app.setTool('selection');
  });

  it('Pencil: Escape mid-stroke drops the stroke and its preview', () => {
    app.setTool('pencil');
    const input = app.input;
    const steps = doc.undoStack.length;
    input.down(ptr(400, 400));
    input.move(ptr(450, 420));
    input.move(ptr(500, 470));
    app.tool.cancel();
    expect(app.tool.points).toBeFalsy();
    input.move(ptr(520, 480));
    input.up(ptr(520, 480));
    expect(doc.undoStack.length).toBe(steps);
    app.setTool('selection');
  });
});
