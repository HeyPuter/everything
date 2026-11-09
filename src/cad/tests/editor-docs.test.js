// @vitest-environment jsdom
/**
 * Editor state that belongs to a drawing must not leak into another one
 * when the user switches drawing tabs (ids restart at 1 in every drawing).
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '../src/editor/editor.js';
import { Camera } from '../src/render/camera.js';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { buildRegistry } from '../src/editor/commands/index.js';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
const flush = () => new Promise((r) => setTimeout(r, 0));

const base = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };

function makeDoc(lines) {
  const drawing = new Drawing();
  const index = new SpatialIndex(drawing);
  drawing.on((c) => index.applyChange(c));
  drawing.transaction('Add', () => {
    for (let i = 0; i < lines; i++) drawing.add({ ...base, type: 'line', x1: 0, y1: i * 10, x2: 5, y2: i * 10 });
  });
  return { drawing, index, selection: new Set(), viewStack: [] };
}

function setup() {
  const stub = () => {};
  const renderer = { setSelection: stub, setPreview: stub, setDragMatrix: stub, setHidden: stub, setHover: stub, invalidate: stub, rebuildAll: stub };
  const camera = new Camera();
  camera.setSize(1000, 800);
  camera.state = { cx: 0, cy: 0, scale: 4 };
  const ui = { prompt: stub, log: stub, coords: stub, input: () => '', setInput: stub, contextMenu: stub, toast: stub };
  const app = { clipboard: null, pushView: stub, zoomPrevious: stub };
  const ed = new Editor({ el: document.createElement('canvas'), renderer, camera, overlay: { draw: stub }, ui, commands: buildRegistry(), app });
  const type = async (...inputs) => {
    for (const s of inputs) {
      ed.submit(s);
      await flush();
    }
  };
  return { ed, type };
}

describe('editor state per drawing', () => {
  it('keeps the Previous selection with its drawing', async () => {
    const { ed, type } = setup();
    const A = makeDoc(2);
    const B = makeDoc(3);
    ed.attach(A);
    ed.addToSelection([1, 2]);
    await type('MOVE', '0,0', '1,0');
    expect(A.drawing.get(1).x1).toBe(1);
    ed.attach(B);
    await type('ERASE', 'P', '');
    expect(B.drawing.entities.size).toBe(3);
    // Back in A, Previous is still A's last selection.
    ed.attach(A);
    await type('ERASE', 'P', '');
    expect(A.drawing.entities.size).toBe(0);
  });
});
