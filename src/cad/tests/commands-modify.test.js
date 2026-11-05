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
import { layoutText, layoutMText } from '../src/core/text/layout.js';

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

describe('EXPLODE', () => {
  const strokes = (list) =>
    list
      .map((s) => s.map((v) => v.toFixed(6)).join(','))
      .sort()
      .join('|');

  it('explodes mtext into texts drawn exactly where its lines were', async () => {
    const mt = {
      type: 'mtext',
      x: 3,
      y: 4,
      h: 2,
      rot: 0.3,
      value: 'Hello wide world\\Pbar\n\nlast line',
      style: 'Standard',
      width: 14,
      attach: 'mc',
      lineSpacing: 1.2,
    };
    add(mt);
    const before = strokes(layoutMText({ ...base, ...mt }).strokes);
    t.ed.setSelection([1]);
    await t.type('EXPLODE');
    const texts = t.all('text');
    expect(t.all('mtext')).toHaveLength(0);
    expect(texts.map((e) => e.value)).toEqual(['Hello wide', 'world', 'bar', 'last line']);
    expect(texts.every((e) => e.halign === 'center' && e.attach === undefined)).toBe(true);
    expect(strokes(texts.flatMap((e) => layoutText(e).strokes))).toBe(before);
  });
});

describe('SELECTSIMILAR', () => {
  it('matches block names, styles and patterns as well as type and layer', async () => {
    const box = (name) => ({
      name,
      bx: 0,
      by: 0,
      entities: [{ ...base, id: 1, type: 'circle', cx: 0, cy: 0, r: 1 }],
    });
    t.drawing.transaction('Blocks', () => {
      t.drawing.setBlock('A', box('A'));
      t.drawing.setBlock('B', box('B'));
    });
    const ins = (name, x) => add({ type: 'insert', name, x, y: 0, sx: 1, sy: 1, rot: 0 });
    ins('A', 0);
    ins('B', 10);
    ins('A', 20);
    const hatch = (pattern, x) =>
      add({
        type: 'hatch',
        pattern,
        scale: 1,
        angle: 0,
        loops: [[x, 50, 0, x + 5, 50, 0, x + 5, 55, 0]],
      });
    hatch('SOLID', 0);
    hatch('ANSI31', 10);
    t.ed.setSelection([1, 4]);
    await t.type('SELECTSIMILAR');
    expect([...t.ed.selection].sort()).toEqual([1, 3, 4]);
  });
});

describe('cancelling', () => {
  it('leaves no picked object selected after Esc', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 20, y2: 0 });
    add({ type: 'line', x1: 0, y1: 0, x2: 0, y2: 20 });
    for (const cmd of [['FILLET'], ['OFFSET', '2'], ['BREAK'], ['BREAKATPOINT'], ['MATCHPROP']]) {
      await t.type(...cmd);
      await t.pick(10, 0);
      expect(t.ed.selection.size).toBe(1);
      t.ed.cancel();
      await flush();
      expect(t.ed.busy).toBe(false);
      expect(t.ed.selection.size).toBe(0);
    }
    await t.type('STRETCH', '-1,-1', '1,1');
    expect(t.ed.selection.size).toBe(2);
    t.ed.cancel();
    await flush();
    expect(t.ed.selection.size).toBe(0);
    expect(t.drawing.undoStack).toHaveLength(2);
  });
});

describe('undo grouping', () => {
  it('keeps a change made outside a running command out of its undo step', async () => {
    await t.type('LINE', '0,0', '10,0', '10,10');
    // The layer palette edits the drawing while LINE is still running.
    const layer = t.drawing.layers.get('0');
    t.drawing.transaction('Layer color', () =>
      t.drawing.setTable('layers', '0', { ...layer, color: 1 }),
    );
    await t.type('0,10', '');
    expect(t.all('line')).toHaveLength(3);
    t.drawing.undo();
    expect(t.all('line')).toHaveLength(2);
    expect(t.drawing.layers.get('0').color).toBe(1);
    t.drawing.undo();
    expect(t.drawing.layers.get('0').color).toBe(layer.color);
    t.drawing.undo();
    expect(t.all('line')).toHaveLength(0);
  });

  it('does not absorb a redo made before the command changed anything', async () => {
    await t.type('CIRCLE', '0,0', '5');
    t.drawing.undo();
    await t.type('LINE', '0,0');
    t.drawing.redo();
    await t.type('10,0', '');
    t.drawing.undo();
    expect(t.all('line')).toHaveLength(0);
    expect(t.all('circle')).toHaveLength(1);
  });
});

describe('EXPLODE hatches', () => {
  it('breaks a pattern hatch into its pattern lines', async () => {
    const loop = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0];
    add({ type: 'hatch', pattern: 'LINES', scale: 1, angle: 0, loops: [loop], color: 3 });
    t.ed.setSelection([1]);
    await t.type('EXPLODE');
    const lines = t.all('line');
    expect(t.all('hatch')).toHaveLength(0);
    expect(t.all('polyline')).toHaveLength(0);
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) {
      expect(l).toMatchObject({ color: 3, linetype: 'Continuous', layer: '0' });
      // 45 degree lines inside the square.
      expect(Math.abs(Math.abs(l.x2 - l.x1) - Math.abs(l.y2 - l.y1))).toBeLessThan(1e-9);
      for (const v of [l.x1, l.y1, l.x2, l.y2]) {
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(20 + 1e-9);
      }
    }
    t.drawing.undo();
    expect(t.all()).toEqual([expect.objectContaining({ type: 'hatch', id: 1 })]);
  });

  it('breaks mirrored and imported pattern hatches into their own lines', async () => {
    const loop = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0];
    add({ type: 'hatch', pattern: 'LINES', scale: 1, angle: 0, loops: [loop], mirror: true });
    const fam = { angle: 0, x: 0, y: 0, dx: 0, dy: 3, dashes: [] };
    add({
      type: 'hatch',
      pattern: 'ANSI31',
      scale: 1,
      angle: Math.PI / 2,
      loops: [loop],
      families: [fam],
    });
    t.ed.setSelection([1, 2]);
    await t.type('EXPLODE');
    expect(t.all('polyline')).toHaveLength(0);
    const lines = t.all('line');
    // the mirrored LINES run at -45 degrees, the imported family vertically
    const diag = lines.filter((l) => Math.abs(l.x2 - l.x1 + (l.y2 - l.y1)) < 1e-9 && l.x1 !== l.x2);
    const vert = lines.filter((l) => Math.abs(l.x2 - l.x1) < 1e-9);
    expect(diag.length).toBeGreaterThan(5);
    expect(vert.length).toBeGreaterThan(5);
    expect(diag.length + vert.length).toBe(lines.length);
  });

  it('breaks a solid fill into its boundary', async () => {
    add({
      type: 'hatch',
      pattern: 'SOLID',
      scale: 1,
      angle: 0,
      loops: [[0, 0, 0, 5, 0, 0, 5, 5, 0]],
    });
    t.ed.setSelection([1]);
    await t.type('EXPLODE');
    expect(t.all()).toEqual([expect.objectContaining({ type: 'polyline', closed: true })]);
  });
});

describe('EXTEND', () => {
  it('reaches a boundary outside the view, like TRIM finds off-screen edges', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    add({ type: 'line', x1: 1000, y1: -5, x2: 1000, y2: 5 });
    await t.type('EXTEND');
    await t.pick(8, 0);
    await t.type('');
    expect(t.drawing.get(1).x2).toBeCloseTo(1000);
  });

  it('prefers the nearest boundary when one is in view', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    add({ type: 'line', x1: 50, y1: -5, x2: 50, y2: 5 });
    add({ type: 'line', x1: 1000, y1: -5, x2: 1000, y2: 5 });
    await t.type('EXTEND');
    await t.pick(8, 0);
    await t.type('');
    expect(t.drawing.get(1).x2).toBeCloseTo(50);
  });
});

describe('ARRAYPOLAR', () => {
  it('asks again instead of stacking copies for a zero angle to fill', async () => {
    add({ type: 'circle', cx: 10, cy: 0, r: 1 });
    t.ed.setSelection([1]);
    await t.type('ARRAYPOLAR', '0,0', '4', '0');
    expect(t.all('circle')).toHaveLength(1);
    expect(t.ed.busy).toBe(true);
    await t.type('-180', 'Y');
    const ys = t.all('circle').map((c) => Math.round(c.cy * 1000) / 1000 + 0);
    expect(ys).toEqual([0, -8.66, -8.66, 0]);
  });
});

describe('LENGTHEN percent', () => {
  it('asks for a plain percentage, not a length in architectural units', async () => {
    t.drawing.transaction('Units', () =>
      t.drawing.setHeader({ units: 'in', linearFormat: 'architectural' }),
    );
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    const prompts = [];
    t.ed.ui.prompt = (p) => p && prompts.push(p);
    await t.type('LENGTHEN', 'P');
    expect(prompts.at(-1)).toBe('Percent of current length <100>');
    await t.type('150');
    await t.pick(9, 0);
    await t.type('');
    expect(t.drawing.get(1).x2).toBeCloseTo(15);
  });
});

describe('SCALE', () => {
  it('shows the default scale factor as a number in architectural units', async () => {
    t.drawing.transaction('Units', () =>
      t.drawing.setHeader({ units: 'in', linearFormat: 'architectural' }),
    );
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    const prompts = [];
    t.ed.ui.prompt = (p) => p && prompts.push(p);
    t.ed.setSelection([1]);
    await t.type('SCALE', '0,0', '0.5');
    t.ed.setSelection([1]);
    await t.type('SCALE', '0,0');
    expect(prompts.at(-1)).toBe('Scale factor <0.5>');
    await t.type('');
    expect(t.drawing.get(1).x2).toBeCloseTo(2.5);
  });
});
