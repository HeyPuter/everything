// @vitest-environment jsdom
/**
 * Editing command regression tests (modify, explode, stretch, join, ...),
 * driven headlessly like tests/commands.test.js.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '../src/editor/editor.js';
import { Camera } from '../src/render/camera.js';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { buildRegistry } from '../src/editor/commands/index.js';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const drawing = new Drawing();
  const index = new SpatialIndex(drawing);
  drawing.on((c) => index.applyChange(c));
  const logs = [];
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
  camera.state = { cx: 0, cy: 0, scale: 4 };
  const ui = {
    prompt: stub,
    log: (t, k) => logs.push([k, t]),
    coords: stub,
    input: () => '',
    setInput: stub,
    contextMenu: stub,
    toast: stub,
  };
  const app = {
    clipboard: null,
    undo: () => drawing.undo(),
    redo: () => drawing.redo(),
    pushView: stub,
    zoomPrevious: stub,
  };
  const ed = new Editor({
    el: document.createElement('canvas'),
    renderer,
    camera,
    overlay: { draw: stub },
    ui,
    commands: buildRegistry(),
    app,
  });
  ed.attach({ drawing, index, selection: new Set(), viewStack: [] });
  // The text editor answers once, then an empty entry ends the command.
  const texts = ['Note'];
  ed.editText = async () => texts.shift() ?? null;
  const type = async (...inputs) => {
    for (const s of inputs) {
      ed.submit(s);
      await flush();
    }
  };
  const pick = async (x, y) => {
    const r = ed.request;
    if (!r) throw new Error('No request to answer');
    if (r.kind === 'select') {
      const hit = ed._pick(x, y);
      if (!hit) throw new Error(`Nothing at ${x},${y}`);
      ed.addToSelection([hit.id]);
      return;
    }
    if (r.kind === 'entity') {
      const hit = ed._pick(x, y);
      if (!hit) throw new Error(`Nothing at ${x},${y}`);
      ed._resolve({ id: hit.id, ent: drawing.get(hit.id), x, y });
    } else ed._resolve({ x, y });
    await flush();
  };
  const all = (type) => [...drawing.entities.values()].filter((e) => !type || e.type === type);
  return { ed, drawing, logs, type, pick, all };
}

let t;
beforeEach(() => {
  t = setup();
});

const base = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };
const add = (e) => t.drawing.transaction('Add', () => t.drawing.add({ ...base, ...e }));

describe('LENGTHEN', () => {
  it('refuses a zero-length line instead of writing NaN coordinates', async () => {
    add({ type: 'line', x1: 5, y1: 5, x2: 5, y2: 5 });
    await t.type('LENGTHEN', 'D', '1');
    t.ed._resolve({ id: 1, ent: t.drawing.get(1), x: 5, y: 5 });
    await flush();
    await t.type('');
    expect(t.drawing.get(1)).toMatchObject({ x1: 5, y1: 5, x2: 5, y2: 5 });
    expect(t.logs.some(([k]) => k === 'error')).toBe(true);
  });
});

describe('FILLET and CHAMFER', () => {
  it('rejects negative chamfer distances and fillet radii', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 20, y2: 0 });
    add({ type: 'line', x1: 0, y1: 0, x2: 0, y2: 20 });
    await t.type('CHAMFER', 'D', '-3');
    expect(t.ed.chamferD).toBeUndefined();
    await t.type('D', '2', '-3');
    expect(t.ed.chamferD).toBeUndefined();
    t.ed.cancel();
    await flush();
    await t.type('FILLET', 'R', '-2');
    expect(t.ed.filletR).toBeUndefined();
    expect(t.logs.filter(([k]) => k === 'error')).toHaveLength(3);
    t.ed.cancel();
    await flush();
    expect(t.all()).toHaveLength(2);
  });
});

describe('JOIN', () => {
  it('does not bridge visible gaps far from the origin', async () => {
    add({ type: 'line', x1: 4e6, y1: 5e5, x2: 4e6 + 10, y2: 5e5 });
    add({ type: 'line', x1: 4e6 + 10.5, y1: 5e5, x2: 4e6 + 20, y2: 5e5 });
    t.ed.setSelection([1, 2]);
    await t.type('JOIN');
    expect(t.all('line')).toHaveLength(2);
  });

  it('joins touching lines far from the origin', async () => {
    add({ type: 'line', x1: 4e6, y1: 5e5, x2: 4e6 + 10, y2: 5e5 });
    add({ type: 'line', x1: 4e6 + 10, y1: 5e5, x2: 4e6 + 10, y2: 5e5 + 10 });
    t.ed.setSelection([1, 2]);
    await t.type('JOIN');
    expect(t.all('polyline')).toHaveLength(1);
  });
});

describe('STRETCH', () => {
  it('moves the vertex of an angular dimension with its rays', async () => {
    add({
      type: 'dimension',
      dimType: 'angular',
      x1: 10,
      y1: 0,
      x2: 0,
      y2: 10,
      x3: 0,
      y3: 0,
      x4: 0,
      y4: 0,
      lx: 5,
      ly: 5,
      style: 'Standard',
      text: '',
    });
    await t.type('STRETCH', '-1,-1', '11,11', '0,0', '100,0');
    expect(t.drawing.get(1)).toMatchObject({ x1: 110, x2: 100, x3: 100, y3: 0, lx: 105, ly: 5 });
  });

  it('moves only the angular vertex when only it is inside', async () => {
    add({
      type: 'dimension',
      dimType: 'angular',
      x1: 10,
      y1: 0,
      x2: 0,
      y2: 10,
      x3: 0,
      y3: 0,
      x4: 0,
      y4: 0,
      lx: 5,
      ly: 5,
      style: 'Standard',
      text: '',
    });
    await t.type('STRETCH', '-1,-1', '6,6', '0,0', '-2,-2');
    expect(t.drawing.get(1)).toMatchObject({ x1: 10, y1: 0, x2: 0, y2: 10, x3: -2, y3: -2, lx: 5 });
  });

  it('stretches hatch boundary vertices inside the window only', async () => {
    const loop = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0];
    add({ type: 'hatch', pattern: 'SOLID', scale: 1, angle: 0, loops: [loop] });
    // The window holds only the first vertex.
    await t.type('STRETCH', '-1,-1', '1,1', '0,0', '-5,0');
    expect(t.drawing.get(1).loops[0]).toEqual([-5, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
  });
});
