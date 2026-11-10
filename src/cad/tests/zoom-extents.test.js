// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '../src/editor/editor.js';
import { Camera } from '../src/render/camera.js';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { buildRegistry } from '../src/editor/commands/index.js';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

function setup(insets) {
  const drawing = new Drawing();
  const index = new SpatialIndex(drawing);
  drawing.on((c) => index.applyChange(c));
  const stub = () => {};
  const renderer = {
    setSelection: stub,
    setPreview: stub,
    setDragMatrix: stub,
    setHidden: stub,
    setHover: stub,
    invalidate: stub,
    rebuildAll: stub,
  };
  const camera = new Camera();
  camera.setSize(1000, 800);
  const ui = {
    prompt: stub,
    log: stub,
    coords: stub,
    input: () => '',
    setInput: stub,
    contextMenu: stub,
    toast: stub,
    viewInsets: insets && (() => insets),
  };
  const ed = new Editor({
    el: document.createElement('canvas'),
    renderer,
    camera,
    overlay: { draw: stub },
    ui,
    commands: buildRegistry(),
    app: {},
  });
  ed.attach({ drawing, index, selection: new Set(), viewStack: [] });
  drawing.transaction('Box', () =>
    drawing.add({ type: 'line', layer: '0', x1: 0, y1: 0, x2: 100, y2: 100 }),
  );
  return { ed, camera };
}

describe('zoom extents', () => {
  it('keeps the drawing clear of the floating command line and navigation bar', () => {
    const insets = { top: 0, right: 50, bottom: 60, left: 0 };
    const { ed, camera } = setup(insets);
    ed.zoomExtents();
    const lo = camera.toScreen(0, 0);
    const hi = camera.toScreen(100, 100);
    // Screen y grows downwards: (0,0) is the bottom left corner of the line's box.
    expect(lo.y).toBeLessThanOrEqual(800 - insets.bottom);
    expect(hi.x).toBeLessThanOrEqual(1000 - insets.right);
    expect(hi.y).toBeGreaterThanOrEqual(0);
    expect(lo.x).toBeGreaterThanOrEqual(0);
  });

  it('fills the whole view without insets', () => {
    const { ed, camera } = setup(null);
    ed.zoomExtents();
    const lo = camera.toScreen(0, 0);
    expect(lo.y).toBeGreaterThan(800 - 60);
  });
});
