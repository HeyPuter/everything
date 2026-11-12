import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let clock = 0;
const ptr = (x, y) => ({
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
});
const click = (app, x, y) => {
  app.input.down(ptr(x, y));
  app.input.up(ptr(x, y));
};
const key = (k) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('A pen path ended after its first click', () => {
  let app;
  let doc;
  let rect;
  beforeAll(() => {
    app = bootApp();
    app.newDocument();
  });
  beforeEach(() => {
    const ed = app.editor;
    doc = ed.doc;
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    rect = createPath(rectangle(10, 10, 20, 20), true, {
      fill: { type: 'solid', color: '#ff0000' },
    });
    doc.transact('Rectangle', () => doc.insert(rect, ed.targetLayer().id));
    ed.select([rect.id]);
  });

  for (const tool of ['pen', 'curvature']) {
    it(`${tool}: leaves no undo step that brings back a one-point path`, () => {
      app.setTool(tool);
      const steps = doc.undoStack.length;
      const count = doc.get(app.editor.targetLayer().id).children.length;
      click(app, 400, 400);
      key('Escape');
      expect(doc.undoStack.length).toBe(steps);
      expect(doc.undoLabel).toBe('Rectangle');
      expect(doc.get(app.editor.targetLayer().id).children.length).toBe(count);
      expect(doc.canRedo).toBe(false);
      // The selection from before the click is back.
      expect([...app.editor.selection]).toEqual([rect.id]);
      app.setTool('selection');
    });
  }

  it('pen: a one-point path edited since (by another command) is deleted as its own step', () => {
    app.setTool('pen');
    click(app, 400, 400);
    const id = app.tool.pathId;
    doc.transact('Opacity', () => doc.update(id, { opacity: 0.5 }));
    const steps = doc.undoStack.length;
    key('Escape');
    expect(doc.has(id)).toBe(false);
    expect(doc.undoStack.length).toBe(steps + 1);
    app.setTool('selection');
  });
});
