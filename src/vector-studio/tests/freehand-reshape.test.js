import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { anchor, flattenPath } from '../src/model/bezier.js';
import { planReshape, applyReshape, remapAlong, span, locate } from '../src/tools/reshape.js';
import { toolSettings } from '../src/features/tool-props/index.js';

const black = { type: 'solid', color: '#000000' };
const REACH = 12;
const FIT = { error: 5.25 ** 2, simplify: 5.25 * 0.5, reach: REACH };

/** A densely sampled stroke through the given points (straight runs between them). */
function stroke(...corners) {
  const out = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[i + 1];
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
    for (let k = i ? 1 : 0; k <= n; k++) out.push({ x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n });
  }
  return out;
}

/** A smooth stroke along a function y(x) from x0 to x1 (either direction). */
function curve(x0, x1, y) {
  const out = [];
  const n = Math.ceil(Math.abs(x1 - x0) / 3);
  for (let k = 0; k <= n; k++) {
    const x = x0 + ((x1 - x0) * k) / n;
    out.push({ x, y: y(x) });
  }
  return out;
}

function reshape(path, pts, opts = {}) {
  const plan = planReshape(path, pts, { reach: REACH, ...opts });
  if (!plan) return { plan: null };
  return { plan, ...applyReshape(path, plan, pts, [], FIT) };
}

const xy = (a) => [Math.round(a.x * 1000) / 1000, Math.round(a.y * 1000) / 1000];
const line4 = () => ({ anchors: [anchor(100, 100), anchor(200, 100), anchor(300, 100), anchor(400, 100)], closed: false });
const square = () => ({ anchors: [anchor(100, 100), anchor(300, 100), anchor(300, 300), anchor(100, 300)], closed: true });
// Open on the right: a C.
const cShape = () => ({ anchors: [anchor(300, 100), anchor(100, 100), anchor(100, 300), anchor(300, 300)], closed: false });
/** Whether any point of the drawn path satisfies `pred`. */
const reaches = (anchors, closed, pred) => flattenPath(anchors, closed, 0.25).some(pred);
const has = (anchors, x, y) => anchors.some((a) => Math.abs(a.x - x) < 1e-6 && Math.abs(a.y - y) < 1e-6);

describe('redrawing part of an open path', () => {
  it('replaces only the stretch between where the stroke starts and ends, exactly on the path', () => {
    const path = line4();
    // Starts and ends a few pixels off the line, as a pen does.
    const pts = curve(150, 350, (x) => 106 - 40 * Math.sin(((x - 150) / 200) * Math.PI));
    pts[0].y = 106;
    pts[pts.length - 1].y = 94;
    const r = reshape(path, pts);
    expect(r.plan.kind).toBe('replace');
    const a = r.anchors;
    expect(a[0]).toEqual(path.anchors[0]);
    expect(a[a.length - 1]).toEqual(path.anchors[3]);
    // The joints are on the original line, at the points nearest the stroke's ends.
    expect(has(a, 150, 100)).toBe(true);
    expect(has(a, 350, 100)).toBe(true);
    // Nothing of the old stretch is left between them.
    expect(a.filter((p) => p.x > 151 && p.x < 349 && Math.abs(p.y - 100) < 1e-6)).toHaveLength(0);
    expect(reaches(a, false, (p) => p.y < 80)).toBe(true);
  });

  it('keeps the path direction when the stroke is drawn the other way', () => {
    const path = line4();
    const r = reshape(path, curve(350, 150, (x) => 100 - 30 * Math.sin(((x - 150) / 200) * Math.PI)));
    expect(xy(r.anchors[0])).toEqual([100, 100]);
    expect(xy(r.anchors.at(-1))).toEqual([400, 100]);
    expect(r.anchors.map((p) => p.x)).toEqual([...r.anchors.map((p) => p.x)].sort((p, q) => p - q));
  });

  it('cuts exactly where it should when both ends fall in one segment', () => {
    const path = { anchors: [anchor(0, 100), anchor(400, 100)], closed: false };
    const r = reshape(path, curve(100, 300, (x) => 100 - 30 * Math.sin(((x - 100) / 200) * Math.PI)));
    expect(xy(r.anchors[0])).toEqual([0, 100]);
    expect(xy(r.anchors.at(-1))).toEqual([400, 100]);
    expect(has(r.anchors, 100, 100)).toBe(true);
    expect(has(r.anchors, 300, 100)).toBe(true);
  });

  it('ending away from the path redraws toward the end the stroke heads for, keeping the other side', () => {
    const path = line4();
    // From the middle, back toward the first anchor and off the path.
    let r = reshape(path, stroke([250, 100], [180, 90], [120, 40]));
    expect(r.plan.kind).toBe('redraw');
    expect(r.anchors.slice(-2)).toEqual([{ ...path.anchors[2] }, path.anchors[3]]);
    expect(has(r.anchors, 250, 100)).toBe(true);
    expect(has(r.anchors, 100, 100)).toBe(false);
    expect(xy(r.anchors[0])).toEqual([120, 40]);
    // And forward, toward the last anchor.
    r = reshape(path, stroke([250, 100], [320, 90], [380, 40]));
    expect(r.anchors.slice(0, 2)).toEqual([path.anchors[0], path.anchors[1]]);
    expect(has(r.anchors, 400, 100)).toBe(false);
    expect(xy(r.anchors.at(-1))).toEqual([380, 40]);
  });

  it('follows the path to tell the direction when the stroke runs along it before leaving', () => {
    const path = line4();
    const r = reshape(path, stroke([250, 100], [180, 101], [170, 160]));
    expect(xy(r.anchors.at(-1))).toEqual([400, 100]);
    expect(has(r.anchors, 100, 100)).toBe(false);
  });

  it('straight off the path redraws the shorter side', () => {
    const path = line4();
    expect(xy(reshape(path, stroke([350, 100], [350, 20])).anchors[0])).toEqual([100, 100]);
    expect(xy(reshape(path, stroke([150, 100], [150, 20])).anchors.at(-1))).toEqual([400, 100]);
  });

  it('a stroke from an end continues the path; from the first anchor it is added before it', () => {
    const path = line4();
    let r = reshape(path, stroke([404, 103], [500, 60]));
    expect(r.plan.kind).toBe('continue');
    expect(r.anchors.slice(0, 3)).toEqual(path.anchors.slice(0, 3));
    expect(xy(r.anchors[3])).toEqual([400, 100]);
    expect(xy(r.anchors.at(-1))).toEqual([500, 60]);
    r = reshape(path, stroke([97, 98], [20, 60]));
    expect(xy(r.anchors[0])).toEqual([20, 60]);
    expect(r.anchors.slice(-3)).toEqual(path.anchors.slice(1));
    expect(r.anchors.some((p) => xy(p).join() === '100,100')).toBe(true);
  });

  it('end to end across the gap closes the path; along the path it redraws it whole', () => {
    let r = reshape(cShape(), stroke([300, 300], [330, 200], [300, 100]));
    expect(r.plan.kind).toBe('close');
    expect(r.closed).toBe(true);
    expect(r.anchors.slice(0, 4).map(xy)).toEqual([[300, 100], [100, 100], [100, 300], [300, 300]]);
    r = reshape(cShape(), stroke([300, 300], [96, 304], [96, 96], [300, 100]));
    expect(r.plan.kind).toBe('replace');
    expect(r.closed).toBe(false);
    expect(xy(r.anchors[0])).toEqual([300, 100]);
    expect(xy(r.anchors.at(-1))).toEqual([300, 300]);
    expect(has(r.anchors, 100, 100)).toBe(false);
  });

  it('a stroke that starts away from every selected path edits nothing', () => {
    expect(planReshape(line4(), stroke([150, 140], [350, 100]), { reach: REACH })).toBeNull();
  });

  it('with editing off only continuing from an end is left', () => {
    expect(planReshape(line4(), curve(150, 350, () => 90), { reach: REACH, edit: false })).toBeNull();
    expect(planReshape(line4(), stroke([402, 100], [480, 50]), { reach: REACH, edit: false, endReach: 8 }).kind).toBe('continue');
  });
});

describe('joints', () => {
  it('a stroke leaving the path at a shallow angle joins it smoothly', () => {
    const r = reshape(line4(), curve(150, 350, (x) => 100 - 15 * Math.sin(((x - 150) / 200) * Math.PI)));
    for (const x of [150, 350]) {
      const j = r.anchors.find((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - 100) < 1e-6);
      // The new side's handle lies along the line, like the kept side.
      if (x === 150) expect(j.oy).toBeCloseTo(100, 6);
      else expect(j.iy).toBeCloseTo(100, 6);
    }
    // And the stretch keeps the shape that was drawn.
    expect(reaches(r.anchors, false, (p) => p.y < 88)).toBe(true);
  });

  it('a stroke leaving the path sharply keeps a corner', () => {
    const r = reshape(line4(), stroke([150, 100], [150, 30], [350, 30], [350, 100]));
    const j = r.anchors.find((p) => Math.abs(p.x - 150) < 1e-6 && Math.abs(p.y - 100) < 1e-6);
    const out = Math.hypot(j.ox - j.x, j.oy - j.y) > 1e-6 ? Math.atan2(-(j.oy - j.y), j.ox - j.x) : Math.PI / 2;
    expect(Math.abs(out)).toBeGreaterThan(Math.PI / 6);
  });
});

describe('redrawing part of a closed path', () => {
  it('replaces the side the stroke runs along and keeps every other anchor', () => {
    const path = square();
    const r = reshape(path, curve(150, 250, (x) => 100 - 40 * Math.sin(((x - 150) / 100) * Math.PI)));
    expect(r.closed).toBe(true);
    for (const p of path.anchors) expect(has(r.anchors, p.x, p.y)).toBe(true);
    expect(has(r.anchors, 150, 100)).toBe(true);
    expect(has(r.anchors, 250, 100)).toBe(true);
    expect(reaches(r.anchors, true, (p) => p.y < 80)).toBe(true);
  });

  it('a dent drawn inward replaces the near side too', () => {
    const r = reshape(square(), curve(150, 250, (x) => 100 + 50 * Math.sin(((x - 150) / 100) * Math.PI)));
    for (const p of square().anchors) expect(has(r.anchors, p.x, p.y)).toBe(true);
    expect(reaches(r.anchors, true, (p) => p.y > 130 && p.x > 150 && p.x < 250)).toBe(true);
  });

  it('a stroke running the long way round replaces the long side and keeps the short one', () => {
    const r = reshape(square(), stroke([150, 100], [95, 95], [95, 305], [305, 305], [305, 95], [250, 100]));
    expect(r.closed).toBe(true);
    for (const [x, y] of [[100, 300], [300, 300]]) expect(has(r.anchors, x, y)).toBe(false);
    expect(has(r.anchors, 150, 100)).toBe(true);
    expect(has(r.anchors, 250, 100)).toBe(true);
  });

  it('a loop drawn out from one point of the path is added there', () => {
    const r = reshape(square(), stroke([200, 100], [170, 40], [230, 40], [201, 100]));
    expect(r.closed).toBe(true);
    for (const p of square().anchors) expect(has(r.anchors, p.x, p.y)).toBe(true);
    expect(reaches(r.anchors, true, (p) => p.y < 60)).toBe(true);
  });

  it('a stroke that leaves a closed path without coming back makes a new path', () => {
    expect(planReshape(square(), stroke([200, 100], [200, 20]), { reach: REACH })).toBeNull();
  });
});

describe('values along the path', () => {
  it('stay with the kept parts and blend across a redrawn stretch with none of its own', () => {
    const path = { anchors: [anchor(0, 100), anchor(400, 100)], closed: false };
    const r = reshape(path, curve(100, 300, (x) => 100 - 20 * Math.sin(((x - 100) / 200) * Math.PI)));
    const rows = remapAlong(r, [[0, 0.1], [0.25, 0.1], [0.75, 0.9], [1, 0.9]], null, [0.5]);
    expect(rows[0]).toEqual([0, 0.1]);
    expect(rows.at(-1)).toEqual([1, 0.9]);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i][0]).toBeGreaterThanOrEqual(rows[i - 1][0]);
      expect(rows[i][1]).toBeGreaterThanOrEqual(rows[i - 1][1] - 1e-9);
    }
    // The kept first quarter of the old path (100 of 400 units) stays at 0.1.
    const total = r.pieces.reduce((s, p) => s + p.len, 0);
    expect(rows.filter((row) => row[0] <= 100 / total + 1e-6).every((row) => row[1] === 0.1)).toBe(true);
  });

  it('take the stroke\'s own values where it has some, in the path\'s direction', () => {
    const path = line4();
    const r = reshape(path, curve(350, 150, (x) => 100 - 30 * Math.sin(((x - 150) / 200) * Math.PI)));
    const rows = remapAlong(r, null, [[0, 1], [1, 0]], [0.5]);
    expect(rows[0][1]).toBe(0.5);
    expect(rows.at(-1)[1]).toBe(0.5);
    // Drawn right to left from pressure 1 to 0: along the path it rises from 0 to 1.
    const mid = rows.filter((row) => row[1] !== 0.5);
    expect(mid[0][1]).toBeLessThan(mid.at(-1)[1]);
  });

  it('span cuts a stretch exactly', () => {
    const list = [anchor(0, 0, 0, 0, 0, 50), anchor(100, 100, 50, 100, 100, 100), anchor(200, 100)];
    const s = span(list, 0.5, 1.5);
    expect(s).toHaveLength(3);
    expect(xy(s[1])).toEqual([100, 100]);
    expect(s[0].ix).toBe(s[0].x);
    expect(s.at(-1).ox).toBe(s.at(-1).x);
    const near = locate(list, false, s[0].x, s[0].y);
    expect(near.u).toBeCloseTo(0.5, 4);
  });
});

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

function draw(app, pts, extra = () => ({})) {
  const tool = app.tool;
  tool.onPointerDown(ev(app, pts[0].x, pts[0].y, extra(0)));
  for (let i = 1; i < pts.length; i++) tool.onPointerMove(ev(app, pts[i].x, pts[i].y, extra(i)));
  tool.onPointerUp(ev(app, pts.at(-1).x, pts.at(-1).y, extra(pts.length - 1)));
}

async function setup() {
  const app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  return app;
}

function addPath(app, anchors, closed = false, style = {}) {
  const doc = app.editor.doc;
  const n = createPath(anchors, closed, { fill: null, stroke: black, strokeWidth: 1, ...style });
  doc.transact('add', () => doc.insert(n, app.editor.targetLayer().id));
  return n.id;
}

const bump = (x0, x1, h) => curve(x0, x1, (x) => 100 - h * Math.sin(((x - x0) / (x1 - x0)) * Math.PI));

describe('Pencil and Paintbrush', () => {
  it('the Pencil redraws part of a selected path, in one undo step', async () => {
    const app = await setup();
    const id = addPath(app, line4().anchors);
    app.editor.select([id]);
    app.setTool('pencil');
    expect(app.tool.editSelected).toBe(true);
    const doc = app.editor.doc;
    const steps = doc.undoStack.length;
    draw(app, bump(150, 350, 40));
    expect(doc.leaves()).toHaveLength(1);
    const a = doc.get(id).anchors;
    expect(a[0]).toMatchObject({ x: 100, y: 100 });
    expect(a.at(-1)).toMatchObject({ x: 400, y: 100 });
    expect(reaches(a, false, (p) => p.y < 80)).toBe(true);
    expect(doc.undoStack.length).toBe(steps + 1);
    doc.undo();
    expect(doc.get(id).anchors).toHaveLength(4);
  });

  it('with Edit selected paths off the Pencil draws a new path, and the setting is kept', async () => {
    const app = await setup();
    const id = addPath(app, line4().anchors);
    app.editor.select([id]);
    app.setTool('pencil');
    const s = toolSettings(app);
    expect(s.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['editSelected', 'within']));
    s.set('editSelected', false);
    expect(app.prefs.get('pencilEditSelected')).toBe(false);
    draw(app, bump(150, 350, 40));
    expect(app.editor.doc.leaves()).toHaveLength(2);
    expect(app.editor.doc.get(id).anchors).toHaveLength(4);
    s.set('editSelected', true);
    s.set('within', 4);
    expect(app.tool.within).toBe(4);
    app.prefs.set('pencilWithin', 12);
  });

  it('the Pencil options dialog has Edit selected paths and Within', async () => {
    const app = await setup();
    app.setTool('pencil');
    let fields;
    app.dialogs.form = async (spec) => {
      fields = spec.fields;
      return { ...Object.fromEntries(spec.fields.filter((f) => f.key).map((f) => [f.key, f.value])), editSelected: false, within: 6 };
    };
    await app.tool.openOptions();
    expect(fields.map((f) => f.label)).toEqual(expect.arrayContaining(['Edit selected paths', 'Within (pixels)']));
    expect(app.tool.editSelected).toBe(false);
    expect(app.tool.within).toBe(6);
    app.prefs.set('pencilEditSelected', true);
    app.prefs.set('pencilWithin', 12);
  });

  it('edits the selected path the stroke starts on, not just the first selected', async () => {
    const app = await setup();
    const other = addPath(app, [anchor(100, 300), anchor(400, 300)]);
    const id = addPath(app, line4().anchors);
    app.editor.select([other, id]);
    app.setTool('pencil');
    draw(app, bump(150, 350, 40));
    expect(app.editor.doc.get(other).anchors).toHaveLength(2);
    expect(reaches(app.editor.doc.get(id).anchors, false, (p) => p.y < 80)).toBe(true);
  });

  it('leaves a locked path alone', async () => {
    const app = await setup();
    const id = addPath(app, line4().anchors);
    app.editor.select([id]);
    app.editor.doc.transact('lock', () => app.editor.doc.update(id, { locked: true }));
    app.setTool('pencil');
    draw(app, bump(150, 350, 40));
    expect(app.editor.doc.get(id).anchors).toHaveLength(4);
  });

  it('the Pencil reshapes a closed path', async () => {
    const app = await setup();
    const id = addPath(app, square().anchors, true);
    app.editor.select([id]);
    app.setTool('pencil');
    draw(app, curve(150, 250, (x) => 100 - 40 * Math.sin(((x - 150) / 100) * Math.PI)));
    const n = app.editor.doc.get(id);
    expect(n.closed).toBe(true);
    for (const p of square().anchors) expect(has(n.anchors, p.x, p.y)).toBe(true);
    expect(app.editor.doc.leaves()).toHaveLength(1);
  });

  it('the Paintbrush keeps the brush pressure of the parts it does not redraw', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(0, 100), anchor(400, 100)], false, { brush: { id: 'def.basic', seed: 1 }, brushPressure: [[0, 0.2], [1, 0.2]] });
    app.editor.select([id]);
    app.setTool('paintbrush');
    draw(app, bump(100, 300, 30));
    const n = app.editor.doc.get(id);
    expect(n.brushPressure.length).toBeGreaterThan(1);
    expect(n.brushPressure.every((r) => r[1] === 0.2)).toBe(true);
    expect(n.brush).toMatchObject({ id: 'def.basic', seed: 1 });
  });

  it('the Paintbrush gives a redrawn stretch widths from the pen pressure and the rest none', async () => {
    const app = await setup();
    const id = addPath(app, [anchor(0, 100), anchor(400, 100)]);
    app.editor.select([id]);
    app.setTool('paintbrush');
    const pts = bump(100, 300, 30);
    draw(app, pts, (i) => ({ pointerType: 'pen', pressure: 0.2 + (0.8 * i) / (pts.length - 1) }));
    const prof = app.editor.doc.get(id).widthProfile;
    expect(prof[0]).toMatchObject({ t: 0, l: 1, r: 1 });
    expect(prof.at(-1)).toMatchObject({ t: 1, l: 1, r: 1 });
    expect(prof.some((p) => p.l < 0.7)).toBe(true);
    expect(prof.some((p) => p.l > 1.5)).toBe(true);
  });

  it('the Paintbrush continues a selected path from its end', async () => {
    const app = await setup();
    const id = addPath(app, line4().anchors);
    app.editor.select([id]);
    app.setTool('paintbrush');
    draw(app, stroke([402, 101], [500, 60]));
    const a = app.editor.doc.get(id).anchors;
    expect(a.slice(0, 3)).toEqual(line4().anchors.slice(0, 3).map((p) => expect.objectContaining({ x: p.x, y: p.y })));
    expect(a.at(-1)).toMatchObject({ x: 500, y: 60 });
    expect(app.editor.doc.leaves()).toHaveLength(1);
  });
});
