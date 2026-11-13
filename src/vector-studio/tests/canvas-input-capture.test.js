import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

// Presses a second apart, so no two count as a double-click.
let clock = 0;
const ptr = (x, y, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, timeStamp: (clock += 1000), ...extra });

/** The browser takes pointer capture away from the canvas. */
function loseCapture(app, pointerId = 1) {
  const e = new Event('lostpointercapture');
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  app.canvasHost.dispatchEvent(e);
}

describe('losing pointer capture mid-drag', () => {
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
    const p = createPath(rectangle(100, 100, 100, 100), true, { fill: { type: 'solid', color: '#ff0000' } });
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    id = p.id;
    ed.clearSelection();
    app.setTool('selection');
  });

  it('ends the drag where the pointer was, instead of leaving the tool dragging', () => {
    const input = app.input;
    input.down(ptr(150, 150));
    input.move(ptr(170, 160));
    input.move(ptr(190, 170));
    loseCapture(app);
    expect(input.active).toBe(null);
    expect(doc.tx).toBeFalsy();
    expect(doc.undoLabel).toBe('Move');
    expect(doc.get(id).anchors[0]).toMatchObject({ x: 140, y: 120 });
    // The button comes up over another element; later moves over the canvas only hover.
    input.move(ptr(400, 400, { buttons: 0 }));
    expect(doc.get(id).anchors[0]).toMatchObject({ x: 140, y: 120 });
    doc.undo();
    expect(doc.get(id).anchors[0]).toMatchObject({ x: 100, y: 100 });
  });

  it('does nothing after a normal release', () => {
    const input = app.input;
    const steps = doc.undoStack.length;
    input.down(ptr(150, 150));
    input.move(ptr(170, 160));
    input.up(ptr(170, 160));
    loseCapture(app);
    expect(doc.undoStack.length).toBe(steps + 1);
    expect(doc.get(id).anchors[0]).toMatchObject({ x: 120, y: 110 });
  });

  it('abandons a pending touch when capture is lost before settling', () => {
    vi.useFakeTimers();
    const menu = vi.spyOn(app, 'showContextMenu');
    try {
      const input = app.input;
      input.down(ptr(150, 150, { pointerType: 'touch' }));
      loseCapture(app);
      vi.advanceTimersByTime(700);
      expect(menu).not.toHaveBeenCalled();
      expect(app.editor.selection.size).toBe(0);
      expect(input.active).toBeNull();
      expect(input.pointers.size).toBe(0);
      expect(doc.tx).toBeFalsy();
    } finally {
      app.input.reset();
      menu.mockRestore();
      vi.useRealTimers();
    }
  });

  it('clears the hold timer after capture loss ends a settled touch press', () => {
    vi.useFakeTimers();
    const menu = vi.spyOn(app, 'showContextMenu');
    try {
      const input = app.input;
      input.down(ptr(150, 150, { pointerType: 'touch' }));
      vi.advanceTimersByTime(120);
      loseCapture(app);
      expect(input.pendingTouch).toBeNull();
      expect(input.longPressTimer).toBe(0);
      expect(input.active).toBeNull();
      expect(doc.tx).toBeFalsy();
      vi.advanceTimersByTime(700);
      expect(menu).not.toHaveBeenCalled();
    } finally {
      app.input.reset();
      menu.mockRestore();
      vi.useRealTimers();
    }
  });

  it('ends a pinch when a participating touch loses capture', () => {
    const input = app.input;
    input.down(ptr(100, 100, { pointerType: 'touch' }));
    input.down(ptr(200, 100, { pointerType: 'touch', pointerId: 2 }));
    input.move(ptr(250, 100, { pointerType: 'touch', pointerId: 2 }));
    const view = app.editor.view.snapshot();
    loseCapture(app);
    input.move(ptr(300, 100, { pointerType: 'touch', pointerId: 2 }));
    expect(app.editor.view.snapshot()).toEqual(view);
    expect(input.gesture).toBeNull();
    input.up(ptr(300, 100, { pointerType: 'touch', pointerId: 2 }));
    expect(input.pointers.size).toBe(0);
  });

  it('ends a middle-button pan', () => {
    const input = app.input;
    input.down(ptr(300, 300, { button: 1 }));
    input.move(ptr(320, 300, { button: 1 }));
    expect(app.editor.view.panX).toBe(20);
    loseCapture(app);
    expect(input.pan).toBe(null);
    input.move(ptr(400, 300));
    expect(app.editor.view.panX).toBe(20);
  });
});
