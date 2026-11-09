// @vitest-environment jsdom
/**
 * Command integration tests: commands run in a real Editor against a real
 * Drawing and spatial index, driven by typed input and picks exactly as the
 * command line and canvas would drive them. Rendering is stubbed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '../src/editor/editor.js';
import { Camera } from '../src/render/camera.js';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { buildRegistry } from '../src/editor/commands/index.js';
import { areaOf } from '../src/core/geom/index.js';
import { loopsToRings, pointInRing } from '../src/core/hatch/fill.js';
import { measureDimension } from '../src/core/dims.js';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const drawing = new Drawing();
  const index = new SpatialIndex(drawing);
  drawing.on((c) => index.applyChange(c));
  const logs = [];
  const stub = () => {};
  const renderer = { setSelection: stub, setPreview: stub, setDragMatrix: stub, setHidden: stub, setHover: stub, invalidate: stub, rebuildAll: stub };
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
  const app = { clipboard: null, undo: () => drawing.undo(), redo: () => drawing.redo(), pushView: stub, zoomPrevious: stub };
  const ed = new Editor({ el: document.createElement('canvas'), renderer, camera, overlay: { draw: stub }, ui, commands: buildRegistry(), app });
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

describe('drawing commands', () => {
  it('draws closed lines from typed coordinates and undoes them as one step', async () => {
    await t.type('LINE', '0,0', '@10,0', '@0,10', '@-10,0', 'C');
    expect(t.all('line')).toHaveLength(4);
    expect(t.ed.busy).toBe(false);
    t.drawing.undo();
    expect(t.all()).toHaveLength(0);
  });

  it('leaves no undo step when every segment was taken back with U', async () => {
    t.drawing.markSaved();
    await t.type('LINE', '0,0', '10,0', 'U', '');
    expect(t.all('line')).toHaveLength(0);
    expect(t.drawing.canUndo).toBe(false);
    expect(t.drawing.modified).toBe(false);
    // With an earlier edit unsaved, the drawing stays edited.
    await t.type('CIRCLE', '0,0', '5');
    await t.type('LINE', '0,0', '10,0', 'U', '');
    expect(t.drawing.undoLabel).toBe('Circle');
    expect(t.drawing.modified).toBe(true);
  });

  it('records no step when Match properties changes nothing', async () => {
    await t.type('LINE', '0,0', '10,0', '');
    await t.type('LINE', '0,5', '10,5', '');
    t.drawing.transaction('Color', () => t.drawing.update(t.all('line')[0].id, { color: 1 }));
    const steps = t.drawing.undoStack.length;
    await t.type('MATCHPROP');
    await t.pick(5, 0);
    await t.pick(5, 5);
    await t.pick(5, 5);
    await t.type('');
    expect(t.all('line')[1].color).toBe(1);
    expect(t.drawing.undoStack.length).toBe(steps + 1);
    await t.type('MATCHPROP');
    await t.pick(5, 0);
    await t.pick(5, 5);
    await t.type('');
    expect(t.drawing.undoStack.length).toBe(steps + 1);
  });

  it('accepts aliases and polar input', async () => {
    await t.type('L', '5,5', '@10<90', '');
    const [l] = t.all('line');
    expect(l.x2).toBeCloseTo(5);
    expect(l.y2).toBeCloseTo(15);
  });

  it('undoes the last segment inside the line command', async () => {
    await t.type('LINE', '0,0', '10,0', '10,10', 'U', '');
    expect(t.all('line')).toHaveLength(1);
  });

  it('draws circles by radius and by diameter', async () => {
    await t.type('CIRCLE', '0,0', '5');
    await t.type('C', '20,0', 'D', '10');
    const [a, b] = t.all('circle');
    expect(a.r).toBe(5);
    expect(b.r).toBe(5);
  });

  it('draws three-point circles', async () => {
    await t.type('CIRCLE', '3P', '10,0', '0,10', '-10,0');
    const [c] = t.all('circle');
    expect(c.r).toBeCloseTo(10);
  });

  it('draws rectangles as closed polylines', async () => {
    await t.type('RECTANG', '0,0', '20,10');
    const [p] = t.all('polyline');
    expect(p.closed).toBe(true);
    expect(areaOf(p)).toBeCloseTo(200);
  });

  it('draws rectangles from dimensions', async () => {
    await t.type('REC', '0,0', 'D', '30', '5');
    await t.pick(-1, -1);
    const [p] = t.all('polyline');
    expect(areaOf(p)).toBeCloseTo(150);
    expect(Math.min(...p.pts.filter((_, i) => i % 3 === 0))).toBeCloseTo(-30);
  });

  it('draws regular polygons', async () => {
    await t.type('POLYGON', '6', '0,0', 'I', '10,0');
    const [p] = t.all('polyline');
    expect(p.pts).toHaveLength(18);
    expect(areaOf(p)).toBeCloseTo((3 * Math.sqrt(3) / 2) * 100);
  });

  it('draws a polygon with a typed radius with its bottom edge horizontal', async () => {
    for (const [mode, r] of [['I', 10], ['C', 10]]) {
      await t.type('POLYGON', '4', '50,50', mode, String(r));
      const p = t.all('polyline').at(-1);
      const ys = [];
      for (let i = 1; i < p.pts.length; i += 3) ys.push(p.pts[i]);
      const minY = Math.min(...ys);
      // Two vertices on the bottom edge, at the same height.
      expect(ys.filter((y) => Math.abs(y - minY) < 1e-9)).toHaveLength(2);
      // Inscribed: vertices on the circle; circumscribed: edges touch it.
      expect(minY).toBeCloseTo(mode === 'I' ? 50 - r * Math.SQRT1_2 : 50 - r, 9);
    }
    await t.type('POLYGON', '5', '0,0', 'I', '0');
    expect(t.ed.request?.prompt).toBe('Radius of circle');
    await t.type('-3');
    expect(t.ed.request?.prompt).toBe('Radius of circle');
    await t.type('@0,5');
    expect(t.all('polyline')).toHaveLength(3);
  });

  it('draws three-point circles and arcs precisely far from the origin', async () => {
    const X = 512345.678,
      Y = 4512345.678;
    const P = (dx, dy) => `${X + dx},${Y + dy}`;
    await t.type('CIRCLE', '3P', P(0, 0), P(1, 1), P(2, 0));
    const [c] = t.all('circle');
    expect(c.r).toBeCloseTo(1, 9);
    expect(c.cx - X).toBeCloseTo(1, 9);
    await t.type('ARC', P(0, 0), P(1, 1), P(2, 0));
    const [a] = t.all('arc');
    expect(a.r).toBeCloseTo(1, 9);
    const end = (ang) => [a.cx + a.r * Math.cos(ang) - X, a.cy + a.r * Math.sin(ang) - Y];
    const ends = [end(a.start), end(a.end)].sort((p, q) => p[0] - q[0]);
    expect(ends[0][0]).toBeCloseTo(0, 8);
    expect(ends[1][0]).toBeCloseTo(2, 8);
    expect(ends[0][1]).toBeCloseTo(0, 8);
  });

  it('draws three-point arcs', async () => {
    await t.type('ARC', '10,0', '0,10', '-10,0');
    const [a] = t.all('arc');
    expect(a.r).toBeCloseTo(10);
    expect(a.start).toBeCloseTo(0);
    expect(a.end).toBeCloseTo(Math.PI);
  });

  it('draws polylines with arc segments', async () => {
    await t.type('PLINE', '0,0', '10,0', 'A', '10,10', '');
    const [p] = t.all('polyline');
    expect(p.pts).toHaveLength(9);
    expect(p.pts[5]).toBeCloseTo(1);
  });

  it('draws splines through fit points', async () => {
    await t.type('SPLINE', '0,0', '10,10', '20,0', '');
    const [s] = t.all('spline');
    expect(s.fit).toEqual([0, 0, 10, 10, 20, 0]);
  });

  it('places single line text', async () => {
    await t.type('TEXT', '0,0', '5', '0');
    await flush();
    const [txt] = t.all('text');
    expect(txt.value).toBe('Note');
    expect(txt.h).toBe(5);
  });

  it('gives new text the width factor and obliquing of its style', async () => {
    t.drawing.transaction('Style', () => {
      const st = { name: 'Narrow', font: 'sans', height: 0, widthFactor: 0.7, oblique: 0.2 };
      t.drawing.setTable('textStyles', 'Narrow', st);
      t.drawing.setHeader({ textStyle: 'Narrow' });
    });
    await t.type('TEXT', '0,0', '5', '0');
    await flush();
    const [txt] = t.all('text');
    expect(txt.style).toBe('Narrow');
    expect(txt.widthFactor).toBe(0.7);
    expect(txt.oblique).toBe(0.2);
  });
});

describe('editing commands', () => {
  const square = async () => t.type('RECTANG', '0,0', '10,10');

  it('moves the current selection', async () => {
    await square();
    t.ed.setSelection([t.all()[0].id]);
    await t.type('MOVE', '0,0', '100,50');
    const [p] = t.all('polyline');
    expect(p.pts[0]).toBe(100);
    expect(p.pts[1]).toBe(50);
    expect(t.ed.selection.size).toBe(0);
  });

  it('selects objects when asked and copies them repeatedly', async () => {
    await square();
    await t.type('COPY');
    await t.pick(5, 0);
    await t.type('', '0,0', '20,0', '40,0', '');
    expect(t.all('polyline')).toHaveLength(3);
  });

  it('rotates, scales and mirrors', async () => {
    await t.type('LINE', '0,0', '10,0', '');
    const id = t.all()[0].id;
    t.ed.setSelection([id]);
    await t.type('ROTATE', '0,0', '90');
    expect(t.drawing.get(id).y2).toBeCloseTo(10);
    t.ed.setSelection([id]);
    await t.type('SCALE', '0,0', '2');
    expect(t.drawing.get(id).y2).toBeCloseTo(20);
    t.ed.setSelection([id]);
    await t.type('MIRROR', '-5,0', '-5,10', 'N');
    const lines = t.all('line');
    expect(lines).toHaveLength(2);
    expect(lines[1].x1).toBeCloseTo(-10);
  });

  it('erases everything with the All selection option', async () => {
    await square();
    await t.type('LINE', '0,0', '5,5', '');
    await t.type('ERASE', 'ALL', '');
    expect(t.all()).toHaveLength(0);
  });

  it('offsets a line to the picked side', async () => {
    await t.type('LINE', '0,0', '10,0', '');
    await t.type('OFFSET', '3');
    await t.pick(5, 0);
    await t.pick(5, 10);
    await t.type('');
    const lines = t.all('line');
    expect(lines).toHaveLength(2);
    expect(lines[1].y1).toBeCloseTo(3);
  });

  it('trims a line between two cutting edges', async () => {
    await t.type('LINE', '0,0', '30,0', '');
    await t.type('LINE', '10,-5', '10,5', '');
    await t.type('LINE', '20,-5', '20,5', '');
    await t.type('TRIM');
    await t.pick(15, 0);
    await t.type('');
    const horiz = t.all('line').filter((l) => Math.abs(l.y1) < 1e-9 && Math.abs(l.y2) < 1e-9);
    expect(horiz).toHaveLength(2);
    const xs = horiz.flatMap((l) => [l.x1, l.x2]).sort((a, b) => a - b);
    expect(xs[1]).toBeCloseTo(10);
    expect(xs[2]).toBeCloseTo(20);
  });

  it('fillets two lines with a radius', async () => {
    await t.type('LINE', '0,0', '20,0', '');
    await t.type('LINE', '0,0', '0,20', '');
    await t.type('FILLET', 'R', '4');
    await t.pick(10, 0);
    await t.pick(0, 10);
    const [arc] = t.all('arc');
    expect(arc.r).toBeCloseTo(4);
    expect(arc.cx).toBeCloseTo(4);
    expect(arc.cy).toBeCloseTo(4);
  });

  it('creates rectangular arrays', async () => {
    await t.type('CIRCLE', '0,0', '1');
    t.ed.setSelection([t.all()[0].id]);
    await t.type('ARRAYRECT', '3', '2', '5', '5');
    expect(t.all('circle')).toHaveLength(6);
  });

  it('joins touching lines into one', async () => {
    await t.type('LINE', '0,0', '10,0', '');
    await t.type('LINE', '10,0', '20,0', '');
    t.ed.setSelection(t.all().map((e) => e.id));
    await t.type('JOIN');
    const lines = t.all('line');
    expect(lines).toHaveLength(1);
    expect(Math.abs(lines[0].x2 - lines[0].x1)).toBeCloseTo(20);
  });

  it('explodes polylines into lines', async () => {
    await square();
    t.ed.setSelection([t.all()[0].id]);
    await t.type('EXPLODE');
    expect(t.all('line')).toHaveLength(4);
    expect(t.all('polyline')).toHaveLength(0);
  });

  it('creates a block from objects and inserts it again', async () => {
    await square();
    t.ed.setSelection([t.all()[0].id]);
    await t.type('BLOCK', 'Box', '0,0');
    expect(t.drawing.blocks.get('Box').entities).toHaveLength(1);
    expect(t.all('insert')).toHaveLength(1);
    await t.type('INSERT', 'Box', '50,50');
    expect(t.all('insert')).toHaveLength(2);
  });

  it('treats block names that differ only in letter case as one name', async () => {
    await square();
    t.ed.setSelection([t.all()[0].id]);
    await t.type('BLOCK', 'Box', '0,0');
    await t.type('CIRCLE', '50,0', '3');
    t.ed.setSelection([t.all('circle')[0].id]);
    // DWG and DXF would merge BOX into Box, so it redefines Box instead.
    await t.type('BLOCK', 'BOX', 'Y', '50,0');
    expect([...t.drawing.blocks.keys()]).toEqual(['Box']);
    expect(t.drawing.blocks.get('Box').entities[0].type).toBe('circle');
    await t.type('INSERT', 'box', '80,80');
    expect(t.all('insert').map((e) => e.name)).toEqual(['Box', 'Box', 'Box']);
  });

  it('places linear dimensions horizontally or vertically from the cursor', async () => {
    await t.type('DIMLINEAR', '0,0', '30,10', '15,-10');
    await t.type('DIMLINEAR', '0,0', '30,10', '40,5');
    const [h, v] = t.all('dimension');
    expect(h.rot).toBe(0);
    expect(v.rot).toBeCloseTo(Math.PI / 2);
  });

  it('dimensions the angle between two lines in the quadrant of the location', async () => {
    await t.type('LINE', '0,0', '20,0', '');
    await t.type('LINE', '-10,-10', '10,10', '');
    const angle = async (at) => {
      await t.type('DIMANGULAR');
      await t.pick(15, 0);
      await t.pick(5, 5);
      await t.type(at);
      return (measureDimension(t.all('dimension').at(-1)) * 180) / Math.PI;
    };
    expect(await angle('10,3')).toBeCloseTo(45);
    expect(await angle('0,10')).toBeCloseTo(135);
    expect(await angle('-10,-3')).toBeCloseTo(45);
    expect(await angle('3,-10')).toBeCloseTo(135);
  });

  it('asks again when the first line is picked as the second', async () => {
    await t.type('LINE', '0,0', '20,0', '');
    await t.type('LINE', '-10,-10', '10,10', '');
    await t.type('DIMANGULAR');
    await t.pick(15, 0);
    await t.pick(10, 0);
    expect(t.logs.some(([, m]) => m.includes('parallel'))).toBe(false);
    expect(t.logs.at(-1)).toEqual(['error', 'That line is already picked. Select a different line.']);
    await t.pick(5, 5);
    await t.type('10,3');
    expect((measureDimension(t.all('dimension')[0]) * 180) / Math.PI).toBeCloseTo(45);
  });

  it('dimensions the radius of a polyline arc segment', async () => {
    await t.type('PLINE', '0,0', '10,0', 'A', '10,10', '');
    await t.type('DIMRADIUS');
    await t.pick(15, 5);
    await t.type('20,5');
    const [d] = t.all('dimension');
    expect(d.dimType).toBe('radius');
    expect(d.x1).toBeCloseTo(10);
    expect(d.y1).toBeCloseTo(5);
    expect(Math.hypot(d.x2 - d.x1, d.y2 - d.y1)).toBeCloseTo(5);
  });

  describe('hatch picks', () => {
    // Even-odd area of the hatch at (x, y).
    const filled = (h, x, y) =>
      loopsToRings(h.loops).filter((r) => pointInRing(x, y, r) === 1).length % 2 === 1;
    const plate = async () => {
      await t.type('RECTANG', '0,0', '20,20');
      await t.type('CIRCLE', '10,10', '3');
      await t.type('HATCH');
    };

    it('ignores a second pick in an area already picked', async () => {
      await plate();
      await t.pick(2, 2);
      await t.pick(3, 3);
      await t.type('');
      const [h] = t.all('hatch');
      expect(h.loops).toHaveLength(2);
      expect(filled(h, 2, 2)).toBe(true);
      expect(filled(h, 10, 10)).toBe(false);
    });

    it('merges an island picked after the area around it', async () => {
      await plate();
      await t.pick(2, 2);
      await t.pick(10, 10);
      await t.type('');
      const [h] = t.all('hatch');
      expect(h.loops).toHaveLength(1);
      expect(filled(h, 2, 2)).toBe(true);
      expect(filled(h, 10, 10)).toBe(true);
    });

    it('finds boundaries in block references and construction lines', async () => {
      await t.type('RECTANG', '0,0', '20,20');
      t.ed.setSelection([t.all()[0].id]);
      await t.type('BLOCK', 'Box', '0,0');
      const ins = t.all('insert')[0];
      const turn = { x: 100, rot: Math.PI / 2, sx: 2, sy: 2 };
      t.drawing.transaction('Turn', () => t.drawing.update(ins.id, turn));
      await t.type('HATCH');
      await t.pick(90, 10);
      await t.type('');
      expect(areaOf(t.all('hatch')[0])).toBeCloseTo(1600);
      await t.type('XLINE', '0,-50', '10,-50', '');
      await t.type('LINE', '0,-60', '0,-40', '');
      await t.type('LINE', '30,-60', '30,-40', '');
      await t.type('RAY', '0,-45', '10,-45', '');
      await t.type('HATCH');
      await t.pick(10, -47);
      await t.type('');
      expect(areaOf(t.all('hatch')[1])).toBeCloseTo(150);
    });

    it('keeps the pattern when the typed name is unknown', async () => {
      await plate();
      await t.type('T', 'cross', '2', '0', 'T', 'nosuch', '', '');
      expect(t.ed.hatchSettings.pattern).toBe('CROSS');
      expect(t.ed.hatchSettings.scale).toBe(2);
      expect(t.logs.some(([k, m]) => k === 'error' && m.includes('nosuch'))).toBe(true);
    });

    it('shows Settings typed at the command line in the Hatch Creation tab', async () => {
      const shown = [];
      t.ed.ui.showHatchPanel = (st) => shown.push(st && { ...st });
      await plate();
      await t.type('T', 'cross', '2', '30');
      expect(shown.at(-1)).toMatchObject({ pattern: 'CROSS', scale: 2 });
      expect(shown.at(-1).angle).toBeCloseTo(Math.PI / 6, 12);
      await t.type('');
      expect(shown.at(-1)).toBe(null);
    });

    it('undoes a whole pick, islands included', async () => {
      await plate();
      await t.pick(10, 10);
      await t.pick(2, 2);
      await t.type('U', '');
      const [h] = t.all('hatch');
      expect(h.loops).toHaveLength(1);
      expect(filled(h, 10, 10)).toBe(true);
      expect(filled(h, 2, 2)).toBe(false);
    });
  });

  describe('draw order', () => {
    const ids = () => [...t.drawing.entities.keys()];

    it('marks reordered objects as one group, and undo takes it back', async () => {
      await t.type('LINE', '0,0', '10,0', '');
      await t.type('LINE', '0,5', '10,5', '');
      const [a, b] = t.all('line');
      t.ed.setSelection([a.id]);
      await t.type('DRAWORDER', 'F');
      expect(ids()).toEqual([b.id, a.id]);
      expect(t.drawing.get(a.id).orderGroup).toBeGreaterThan(0);
      expect(t.drawing.get(b.id).orderGroup).toBeUndefined();
      t.drawing.undo();
      expect(ids()).toEqual([a.id, b.id]);
      expect(t.drawing.get(a.id).orderGroup).toBeUndefined();
    });

    it('leaves a new hatch last while the drawing has no draw order set', async () => {
      await t.type('RECTANG', '0,0', '20,20');
      await t.type('HATCH');
      await t.pick(5, 5);
      await t.type('');
      expect(t.drawing.get(ids().at(-1)).type).toBe('hatch');
    });

    it('puts a new hatch behind its boundary when a later band would lift it over', async () => {
      await t.type('RECTANG', '0,0', '20,20');
      await t.type('LINE', '50,0', '60,0', '');
      await t.type('RECTANG', '100,0', '120,20');
      const [rect, rect2] = t.all('polyline');
      const line = t.all('line')[0];
      t.ed.setSelection([line.id]);
      await t.type('DRAWORDER', 'F');
      await t.type('HATCH');
      await t.pick(5, 5);
      await t.type('');
      const h = t.all('hatch')[0];
      expect(ids()).toEqual([h.id, rect.id, rect2.id, line.id]);
      // Select objects mode, and one undo takes back hatch and move together.
      await t.type('HATCH', 'S');
      await t.pick(100, 10);
      await t.type('');
      const h2 = t.all('hatch')[1];
      expect(ids()).toEqual([h.id, rect.id, h2.id, rect2.id, line.id]);
      t.drawing.undo();
      expect(ids()).toEqual([h.id, rect.id, rect2.id, line.id]);
    });
  });
});

describe('command flow', () => {
  it('repeats the last command on an empty Enter', async () => {
    await t.type('CIRCLE', '0,0', '1');
    await t.type('', '5,5', '2');
    expect(t.all('circle')).toHaveLength(2);
  });

  it('cancels a running command and keeps what was already drawn', async () => {
    await t.type('LINE', '0,0', '10,0', '10,10');
    t.ed.cancel();
    await flush();
    expect(t.ed.busy).toBe(false);
    expect(t.all('line')).toHaveLength(2);
  });

  it('reports unknown commands and invalid input', async () => {
    await t.type('NOTACOMMAND');
    expect(t.logs.some(([k]) => k === 'error')).toBe(true);
    await t.type('LINE', 'x,y');
    expect(t.ed.busy).toBe(true);
    expect(t.logs.at(-1)[0]).toBe('error');
    t.ed.cancel();
  });

  it('takes typed snap overrides for the next point only', async () => {
    await t.type('LINE', '0,0', 'END');
    expect(t.ed.busy).toBe(true);
    expect(t.ed.snapOverride).toBe('end');
    await t.type('5,5');
    expect(t.ed.snapOverride).toBeNull();
    expect(t.all('line')).toHaveLength(1);
    t.ed.cancel();
  });

  it('runs a zoom in the middle of a command without cancelling it', async () => {
    await t.type('LINE', '0,0');
    await t.ed.run('ZOOM', { mode: 'in' });
    await t.type('10,0', '');
    expect(t.all('line')).toHaveLength(1);
    expect(t.ed.busy).toBe(false);
  });

  it('lets a window zoom ask its own questions mid-command', async () => {
    await t.type('LINE', '0,0');
    const z = t.ed.run('ZOOM', { mode: 'window' });
    await flush();
    await t.type('-10,-10', '10,10');
    await z;
    await t.type('5,0', '');
    expect(t.all('line')).toHaveLength(1);
    expect(t.ed.window).toBeNull();
  });

  it('clears the previous command state when another command starts', async () => {
    const previews = [];
    t.ed.renderer.setPreview = (p) => previews.push(p.length);
    await t.type('LINE', '0,0');
    const running = t.ed.run('CIRCLE');
    await flush();
    expect(previews.at(-1)).toBe(0);
    expect(t.ed.active.def.name).toBe('CIRCLE');
    t.ed.cancel();
    await running;
  });

  it('keeps TRIM undo inside the command', async () => {
    await t.type('LINE', '0,0', '10,0', '');
    await t.type('TRIM', 'U', '');
    expect(t.all('line')).toHaveLength(1);
  });

  it('gives digit options their own keys', async () => {
    await t.type('CIRCLE', '2P', '0,0', '10,0');
    const [c] = t.all('circle');
    expect(c.r).toBeCloseTo(5);
  });

  it('draws revision cloud scallops outward', async () => {
    await t.type('REVCLOUD', '5', '0,0', '20,20');
    const [p] = t.all('polyline');
    expect(p.pts.filter((_, i) => i % 3 === 2).every((b) => b > 0)).toBe(true);
  });

  it('picks a line drawn over a solid fill', async () => {
    t.drawing.transaction('Add', () => {
      t.drawing.add({ type: 'hatch', layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1, loops: [[0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0]], pattern: 'SOLID', scale: 1, angle: 0 });
    });
    await t.type('LINE', '0,10', '20,10', '');
    const line = t.all('line')[0];
    expect(t.ed._pick(10, 10.1).id).toBe(line.id);
    expect(t.drawing.get(t.ed._pick(5, 5).id).type).toBe('hatch');
  });

  it('does not edit objects on locked layers', async () => {
    await t.type('CIRCLE', '0,0', '5');
    const id = t.all()[0].id;
    t.drawing.transaction('Lock', () => t.drawing.setTable('layers', '0', { ...t.drawing.layers.get('0'), locked: true }));
    await t.type('ERASE', 'ALL', '');
    expect(t.drawing.get(id)).toBeTruthy();
  });
});

describe('transparent commands', () => {
  it('resumes the outer command when a pan is cancelled', async () => {
    await t.type('LINE', '0,0', '10,0');
    t.ed.run('PAN');
    await flush();
    expect(t.ed.request.prompt).toMatch(/pan/i);
    t.ed.cancel();
    await flush();
    expect(t.ed.active.def.name).toBe('LINE');
    await t.type('10,10', '');
    expect(t.all('line')).toHaveLength(2);
    expect(t.drawing.undoStack).toHaveLength(1);
  });

  it("keeps a typed snap override and angle lock across 'ZOOM and 'PAN", async () => {
    await t.type('LINE', '0,0', 'END', '<90');
    await t.type("'Z", 'W', '0,0', '10,10');
    expect(t.ed.active.def.name).toBe('LINE');
    expect(t.ed.snapOverride).toBe('end');
    expect(t.ed.angleLock).toBeCloseTo(Math.PI / 2);
    t.ed.run('PAN');
    await flush();
    expect(t.ed.snapOverride).toBe(null);
    t.ed.cancel();
    await flush();
    expect(t.ed.snapOverride).toBe('end');
    expect(t.ed.angleLock).toBeCloseTo(Math.PI / 2);
    await t.type('5');
    expect(t.all('line')[0]).toMatchObject({ x2: expect.closeTo(0), y2: expect.closeTo(5) });
  });

  it('ends the outer command when another command starts during a pan', async () => {
    await t.type('LINE', '0,0', '10,0', '10,10');
    t.ed.run('PAN');
    await flush();
    const circle = t.ed.run('CIRCLE');
    await flush();
    await flush();
    expect(t.ed.active.def.name).toBe('CIRCLE');
    expect(t.drawing.undoStack).toHaveLength(1);
    await t.type('0,0', '5');
    await circle;
    expect(t.all('circle')).toHaveLength(1);
    expect(t.ed.busy).toBe(false);
  });

  it('stops every command level on detach', async () => {
    const changed = [];
    t.ed.ui.commandChanged = (d) => changed.push(d?.name ?? null);
    t.ed.run('LINE');
    await flush();
    await t.type('0,0', '10,0');
    t.ed.run('PAN');
    await flush();
    t.ed.detach();
    await flush();
    expect(t.ed.active).toBe(null);
    expect(t.ed.request).toBe(null);
    expect(changed.at(-1)).toBe(null);
  });

  it('reports commands that need a drawing when none is open', async () => {
    t.ed.detach();
    await t.ed.run('PURGE');
    expect(t.logs.at(-1)[1]).toMatch(/open or create a drawing/);
  });
});
