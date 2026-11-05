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

describe('revision clouds', () => {
  it('keeps the number of arcs bounded for a tiny arc length', async () => {
    await t.type('REVCLOUD', '0.001', '0,0', '1000,1000');
    const [p] = t.all('polyline');
    expect(p.pts.length / 3).toBeLessThanOrEqual(2004);
    expect(t.logs.some(([k, s]) => k === 'muted' && /Arc length increased/.test(s))).toBe(true);
  });

  it('uses the given arc length when it is reasonable', async () => {
    await t.type('REVCLOUD', '5', '0,0', '100,50');
    const [p] = t.all('polyline');
    expect(p.pts.length / 3).toBe(60);
  });
});

describe('angle lock', () => {
  it('keeps a typed <angle when the cursor snaps to an object', async () => {
    await t.type('LINE', '50,50', '@10,0', '');
    await t.type('LINE', '0,0', '<45');
    const s = t.ed.camera.toScreen(60, 50.5);
    t.ed._updateCursor(s.x, s.y);
    expect(t.ed.snap?.mode).toBe('end');
    t.ed._press({ shiftKey: false }, null);
    await flush();
    const l = t.all('line').at(-1);
    expect(l.x2).toBeCloseTo(55);
    expect(l.y2).toBeCloseTo(55);
  });
});

describe('number prompts', () => {
  it('names the allowed range when a number is out of it', async () => {
    await t.type('POLYGON', '2000');
    expect(t.logs.at(-1)).toEqual(['error', 'Enter a number from 3 to 1024.']);
    await t.type('2');
    expect(t.logs.at(-1)).toEqual(['error', 'Enter a number from 3 to 1024.']);
  });
});

describe('grip editing', () => {
  it('asks again for a zero or negative grip scale factor', async () => {
    await t.type('LINE', '0,0', '10,0', '');
    t.ed.setSelection([...t.drawing.entities.keys()]);
    t.ed._startGripEdit(0, null);
    await flush();
    // Space cycles stretch -> move -> rotate -> scale.
    await t.type('', '', '');
    expect(t.ed.request?.prompt).toMatch(/^Scale factor/);
    await t.type('0');
    expect(t.ed.request?.prompt).toMatch(/^Scale factor/);
    await t.type('-2');
    expect(t.ed.request?.prompt).toMatch(/^Scale factor/);
    await t.type('2');
    const [l] = t.all('line');
    expect([l.x1, l.y1, l.x2, l.y2]).toEqual([0, 0, 20, 0]);
  });
});

describe('shared grips', () => {
  it('stretches every selected object that meets at the picked grip', async () => {
    await t.type('LINE', '0,0', '10,0', '10,10', '');
    await t.type('CIRCLE', '30,30', '5');
    t.ed.setSelection([...t.drawing.entities.keys()]);
    const i = t.ed.grips.findIndex((g) => g.x === 10 && g.y === 0);
    t.ed._startGripEdit(i, null);
    await flush();
    await t.type('12,3');
    const [a, b] = t.all('line');
    expect([a.x2, a.y2]).toEqual([12, 3]);
    expect([b.x1, b.y1]).toEqual([12, 3]);
    expect([a.x1, a.y1, b.x2, b.y2]).toEqual([0, 0, 10, 10]);
    expect(t.all('circle')[0]).toMatchObject({ cx: 30, cy: 30, r: 5 });
    t.drawing.undo();
    expect([t.all('line')[1].x1, t.all('line')[1].y1]).toEqual([10, 0]);
  });
});

describe('grip base point', () => {
  it('stretches by the displacement from a new base point', async () => {
    await t.type('LINE', '0,0', '10,0', '');
    t.ed.setSelection([...t.drawing.entities.keys()]);
    t.ed._startGripEdit(2, null);
    await flush();
    await t.type('B', '5,5', '6,7');
    const [l] = t.all('line');
    expect([l.x1, l.y1, l.x2, l.y2]).toEqual([0, 0, 11, 2]);
  });
});

describe('polyline cancel', () => {
  it('keeps the segments drawn so far when Escape ends the polyline', async () => {
    await t.type('PLINE', '0,0', '10,0', 'A', '20,0');
    t.ed.cancel();
    await flush();
    expect(t.ed.busy).toBe(false);
    const [p] = t.all('polyline');
    expect(p.pts.length / 3).toBe(3);
    expect(p.closed).toBe(false);
    t.drawing.undo();
    expect(t.all()).toHaveLength(0);
  });

  it('draws nothing when Escape comes before a second point', async () => {
    await t.type('PLINE', '0,0');
    t.ed.cancel();
    await flush();
    expect(t.all()).toHaveLength(0);
  });
});

describe('transparent commands', () => {
  it("runs a typed 'ZOOM in the middle of a command and resumes it", async () => {
    await t.type('LINE', '0,0');
    const scale = t.ed.camera.scale;
    await t.type("'Z", 'I');
    expect(t.ed.camera.scale).toBeCloseTo(scale * 2);
    expect(t.ed.request?.prompt).toBe('Next point');
    await t.type('10,0', '');
    expect(t.all('line')).toHaveLength(1);
  });

  it('refuses a typed non-view command inside another command', async () => {
    await t.type('LINE', '0,0', "'CIRCLE");
    expect(t.logs.at(-1)[0]).toBe('error');
    expect(t.ed.request?.prompt).toBe('Next point');
  });
});
