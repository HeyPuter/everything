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

  it('continues dimensions only from a dimension of the same drawing', async () => {
    const { ed, type } = setup();
    const A = makeDoc(0);
    const B = makeDoc(0);
    B.drawing.transaction('Add', () =>
      B.drawing.add({ ...base, type: 'dimension', dimType: 'linear', x1: 50, y1: 50, x2: 60, y2: 50, x3: 0, y3: 0, x4: 0, y4: 0, lx: 55, ly: 55, rot: 0, style: 'Standard', text: '' }),
    );
    ed.attach(A);
    await type('DIMLINEAR', '0,0', '10,0', '5,5');
    expect(A.drawing.get(1).type).toBe('dimension');
    ed.attach(B);
    await type('DIMCONTINUE');
    expect(ed.request.kind).toBe('entity');
    ed.cancel();
    await flush();
    // In A, it continues from A's dimension without asking.
    ed.attach(A);
    await type('DIMCONTINUE');
    expect(ed.request.kind).toBe('point');
    ed.cancel();
    await flush();
  });

  it('leaves the selection of the drawing switched to alone when a command is cancelled', async () => {
    const { ed, type } = setup();
    const A = makeDoc(1);
    const B = makeDoc(2);
    B.selection = new Set([1, 2]);
    ed.attach(A);
    await type('BREAKATPOINT');
    ed._resolve({ id: 1, ent: A.drawing.get(1), x: 2, y: 0 });
    await flush();
    expect(ed.request?.prompt).toBe('Break point');
    expect([...A.selection]).toEqual([1]);
    ed.attach(B);
    await flush();
    await flush();
    expect([...B.selection]).toEqual([1, 2]);
    expect(A.selection.size).toBe(0);
  });
});
