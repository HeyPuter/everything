// @vitest-environment jsdom
/**
 * Edge cases of commands, prompts and grips (degenerate picks, extreme
 * counts, state after cancel), driven headlessly like tests/commands.test.js.
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

/** Mouse events on the canvas, at a world position. */
const mouse = (type, x, y, init = {}) => {
  const s = t.ed.camera.toScreen(x, y);
  const e = new MouseEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true, ...init });
  t.ed.el.dispatchEvent(e);
};
const click = async (x, y, init) => {
  mouse('pointermove', x, y, init);
  mouse('pointerdown', x, y, init);
  mouse('pointerup', x, y, init);
  await flush();
};

const base = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };
const add = (e) => t.drawing.transaction('Add', () => t.drawing.add({ ...base, ...e }));

describe('ALIGN', () => {
  it('asks again for a second point on the first instead of scaling by zero or infinity', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    add({ type: 'circle', cx: 5, cy: 0, r: 2 });
    t.ed.setSelection([1, 2]);
    await t.type('ALIGN', '0,0', '5,5', '0,0');
    expect(t.logs.at(-1)).toEqual(['error', 'The second source point must differ from the first.']);
    await t.type('10,0', '5,5');
    expect(t.logs.at(-1)).toEqual([
      'error',
      'The second destination point must differ from the first.',
    ]);
    await t.type('5,25', 'Y');
    expect(t.ed.busy).toBe(false);
    const l = t.drawing.get(1);
    expect([l.x1, l.y1, l.x2, l.y2].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 5, 5, 25]);
    const c = t.drawing.get(2);
    expect(c.r).toBeCloseTo(4);
    expect(c.cx).toBeCloseTo(5);
    expect(c.cy).toBeCloseTo(15);
  });
});

describe('array sizes', () => {
  const TOO_MANY = ['error', 'That array would create too many objects (limit 200,000).'];
  const lines = (n) => {
    for (let i = 0; i < n; i++) add({ type: 'line', x1: i, y1: 0, x2: i, y2: 10 });
    t.ed.setSelection(t.all().map((e) => e.id));
  };

  it('refuses a COPY Array that would create too many objects and asks again', async () => {
    lines(30);
    await t.type('COPY', '0,0', 'A', '10000');
    expect(t.logs.at(-1)).toEqual(TOO_MANY);
    expect(t.ed.busy).toBe(true);
    await t.type('A', '3', '0,20', '');
    expect(t.ed.busy).toBe(false);
    expect(t.all()).toHaveLength(90);
  });

  it('refuses a polar array that would create too many objects', async () => {
    lines(30);
    await t.type('ARRAYPOLAR', '0,-50', '10000');
    expect(t.logs.at(-1)).toEqual(TOO_MANY);
    expect(t.ed.busy).toBe(false);
    expect(t.all()).toHaveLength(30);
  });
});

describe('TRIM with chosen cutting edges', () => {
  it('leaves an object that does not cross them instead of erasing it', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    add({ type: 'line', x1: 50, y1: -5, x2: 50, y2: 5 });
    add({ type: 'line', x1: 5, y1: -5, x2: 5, y2: 5 });
    await t.type('TRIM', 'E');
    await t.pick(50, 0);
    await t.type('');
    const steps = t.drawing.undoStack.length;
    // Line 3 crosses line 1 but is not a cutting edge; the edge is far away.
    await t.pick(2, 0);
    expect(t.logs.at(-1)).toEqual(['error', 'That object does not cross a cutting edge.']);
    expect(t.drawing.get(1)).toMatchObject({ x1: 0, x2: 10 });
    expect(t.drawing.undoStack.length).toBe(steps);
    expect(t.ed.busy).toBe(true);
    await t.type('U');
    expect(t.logs.at(-1)).toEqual(['muted', 'Nothing to undo in this command.']);
    await t.type('');
    expect(t.all('line')).toHaveLength(3);
  });

  it('still erases an object nothing crosses when every object is a cutting edge', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    await t.type('TRIM');
    await t.pick(2, 0);
    await t.type('');
    expect(t.all()).toHaveLength(0);
  });
});

describe('selection window', () => {
  it('does not stay on screen when a command is typed after its first corner', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    await click(50, 50);
    expect(t.ed.window).not.toBeNull();
    await t.type('LINE');
    expect(t.ed.window).toBeNull();
    await click(20, 20);
    expect(t.ed.request.prompt).toBe('Next point');
    expect(t.ed.window).toBeNull();
  });
});

describe('double click on a grip', () => {
  const text = {
    type: 'text',
    x: 0,
    y: 0,
    h: 5,
    rot: 0,
    value: 'Hello',
    style: 'Standard',
    halign: 'left',
    valign: 'baseline',
    widthFactor: 1,
    oblique: 0,
  };

  it('opens a text double clicked at its insertion point instead of dragging its grip', async () => {
    add(text);
    const opened = [];
    t.ed.ui.editEntity = (id) => opened.push(id);
    const steps = t.drawing.undoStack.length;
    // The first click selects the text; the second lands on the grip that appeared.
    await click(0.5, 0.5);
    expect([...t.ed.selection]).toEqual([1]);
    await click(0.5, 0.5);
    mouse('dblclick', 0.5, 0.5);
    await flush();
    expect(opened).toEqual([1]);
    expect(t.ed.busy).toBe(false);
    expect(t.drawing.undoStack.length).toBe(steps);
  });

  it('opens a selected object without recording a grip edit', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    const opened = [];
    t.ed.ui.editEntity = (id) => opened.push(id);
    t.ed.setSelection([1]);
    const steps = t.drawing.undoStack.length;
    await click(10, 0);
    expect(t.ed.active?.def.name).toBe('GRIPEDIT');
    await click(10, 0);
    mouse('dblclick', 10, 0);
    await flush();
    expect(opened).toEqual([1]);
    expect(t.ed.busy).toBe(false);
    expect(t.drawing.undoStack.length).toBe(steps);
  });

  it('still places a grip with a second click somewhere else', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    t.ed.settings.polar = false;
    t.ed.setSelection([1]);
    await click(10, 0);
    await click(20, 5);
    expect(t.ed.busy).toBe(false);
    expect(t.drawing.get(1)).toMatchObject({ x2: 20, y2: 5 });
  });
});
