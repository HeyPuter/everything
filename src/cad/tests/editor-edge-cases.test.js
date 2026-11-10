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
