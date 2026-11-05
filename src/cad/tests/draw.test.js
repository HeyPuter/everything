// @vitest-environment jsdom
/**
 * Edge cases of the drawing commands and the editor's point input, driven
 * like tests/commands.test.js: typed input and picks against a real Editor,
 * Drawing and spatial index, with rendering stubbed.
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

describe('arcs', () => {
  it('rejects a start-end-radius arc whose ends coincide or whose radius is too short', async () => {
    await t.type('ARC', '0,0', 'E', '0,0');
    expect(t.ed.request?.prompt).toBe('End point');
    await t.type('10,0', '2');
    expect(t.ed.request?.prompt).toBe('Radius');
    await t.type('5');
    const [a] = t.all('arc');
    expect(a.r).toBeCloseTo(5);
    expect(a.cx).toBeCloseTo(5);
    expect(a.cy).toBeCloseTo(0);
    expect(t.all()).toHaveLength(1);
  });
});

describe('centre arcs', () => {
  it('asks again instead of drawing a zero-radius arc', async () => {
    await t.type('ARC', 'C', '0,0', '0,0');
    expect(t.ed.request?.prompt).toBe('Start point');
    await t.type('5,0', '0,5');
    expect(t.all()).toHaveLength(1);
    expect(t.all('arc')[0].r).toBeCloseTo(5);
    await t.type('ARC', '5,5', 'C', '5,5');
    expect(t.ed.request?.prompt).toBe('Center point');
    await t.type('0,5', '5,10');
    expect(t.all('arc')).toHaveLength(2);
    expect(t.all('arc')[1].r).toBeCloseTo(5);
  });
});

describe('rectangles', () => {
  it('asks again for a zero length or width from Dimensions', async () => {
    await t.type('RECTANG', '0,0', 'D', '0');
    expect(t.ed.request?.prompt).toMatch(/^Length/);
    await t.type('20', '-1');
    expect(t.ed.request?.prompt).toMatch(/^Width/);
    await t.type('10', '5,5');
    const [p] = t.all('polyline');
    expect(p.pts).toEqual([0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 0]);
  });
});

describe('three-point curves', () => {
  it('asks again when the third point is in line with the first two', async () => {
    await t.type('CIRCLE', '3P', '0,0', '5,0', '10,0');
    expect(t.ed.request?.prompt).toBe('Third point on circle');
    expect(t.logs.at(-1)[0]).toBe('error');
    await t.type('2.5,2.5');
    expect(t.all('circle')[0].r).toBeCloseTo(2.5);
    await t.type('ARC', '0,0', '5,0', '0,0');
    expect(t.ed.request?.prompt).toBe('End point');
    await t.type('10,0');
    expect(t.ed.request?.prompt).toBe('End point');
    await t.type('5,5');
    expect(t.all('arc')).toHaveLength(1);
  });
});

describe('donuts', () => {
  it('asks again for a negative inside or a too small outside diameter', async () => {
    await t.type('DONUT', '-5');
    expect(t.ed.request?.prompt).toMatch(/^Inside diameter/);
    await t.type('10', '5');
    expect(t.ed.request?.prompt).toMatch(/^Outside diameter/);
    expect(t.logs.at(-1)[0]).toBe('error');
    await t.type('20', '0,0', '');
    const [p] = t.all('polyline');
    expect(p.width).toBeCloseTo(5);
    expect(p.pts[3] - p.pts[0]).toBeCloseTo(15);
  });
});

describe('elliptical arcs', () => {
  it('takes typed start and end angles from the first axis end point', async () => {
    t.ed.cursor.fx = 100;
    t.ed.cursor.fy = 0;
    await t.type('ELLIPSE', 'A', '10,0', '-10,0', '5', '90', '180');
    const [e] = t.all('ellipse');
    // Angle 0 is at (10, 0), the first axis end point.
    const at = (u) => {
      const L = Math.hypot(e.mx, e.my);
      const vx = (-e.my / L) * L * e.ratio,
        vy = (e.mx / L) * L * e.ratio;
      return [
        e.cx + e.mx * Math.cos(u) + vx * Math.sin(u),
        e.cy + e.my * Math.cos(u) + vy * Math.sin(u),
      ];
    };
    const [sx, sy] = at(e.start);
    const [ex, ey] = at(e.end);
    expect(sx).toBeCloseTo(0);
    expect(sy).toBeCloseTo(5);
    expect(ex).toBeCloseTo(-10);
    expect(ey).toBeCloseTo(0);
  });

  it('accepts a typed angle of 0', async () => {
    await t.type('ELLIPSE', 'A', 'C', '0,0', '10,0', '5', '0', '90');
    const [e] = t.all('ellipse');
    expect(e.start).toBeCloseTo(0);
    expect(e.end).toBeCloseTo(Math.PI / 2);
  });

  it('still takes picked start and end points by direction', async () => {
    await t.type('ELLIPSE', 'A', 'C', '0,0', '10,0', '5', '0,20', '-30,0');
    const [e] = t.all('ellipse');
    expect(e.start).toBeCloseTo(Math.PI / 2);
    expect(e.end).toBeCloseTo(Math.PI);
  });
});
