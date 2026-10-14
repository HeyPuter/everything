import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';
import { planContext, planGraphics, dimensionGeometry, readableAngle, clipLine } from '../src/core/plan.js';
import { createSampleProject } from '../src/core/sample.js';
import { sectionCuts, viewFrame } from '../src/core/elevation.js';

function ctxFor(doc, scene, patch = {}) {
  const view = { ...doc.all('plan')[0], ...patch };
  return planContext(doc, view, scene.walls, scene.rooms);
}

describe('plan graphics', () => {
  it('fills cut walls and leaves gaps for doors', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [5000, 0]);
    const scene = new Scene(doc);
    const before = planGraphics(ctxFor(doc, scene), doc.get(w.id));
    expect(before.fills.length).toBeGreaterThan(0);
    const faceLines = before.lines.length;
    add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 2500 });
    const scene2 = new Scene(doc);
    const after = planGraphics(ctxFor(doc, scene2), doc.get(w.id));
    // The faces split around the opening and jamb lines appear.
    expect(after.lines.length).toBeGreaterThan(faceLines);
    const door = planGraphics(ctxFor(doc, scene2), doc.all('door')[0]);
    expect(door.lines.length).toBeGreaterThan(10);
  });

  it('draws walls above the cut plane not at all and windows above it as hidden lines', () => {
    const { doc, wall, add } = project();
    const high = wall([0, 0], [4000, 0], { baseOffset: 1500 });
    const w = wall([0, 3000], [4000, 3000]);
    add({ kind: 'window', typeId: 'wnt-awning-36x24', hostId: w.id, t: 2000, sill: 1500 });
    const scene = new Scene(doc);
    const pc = ctxFor(doc, scene);
    expect(planGraphics(pc, doc.get(high.id))).toBeNull();
    const win = planGraphics(pc, doc.all('window')[0]);
    expect(win.lines.every((l) => l.d === 2)).toBe(true);
  });

  it('shows more layers at fine detail than at coarse', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [5000, 0], { typeId: 'wt-ext-brick-stud' });
    const scene = new Scene(doc);
    const coarse = planGraphics(ctxFor(doc, scene, { detail: 'coarse' }), doc.get(w.id));
    const fine = planGraphics(ctxFor(doc, scene, { detail: 'fine' }), doc.get(w.id));
    expect(fine.fills.length).toBeGreaterThan(coarse.fills.length);
    expect(fine.lines.length).toBeGreaterThan(coarse.lines.length);
  });

  it('measures dimensions between wall faces and follows the walls', () => {
    const { doc, wall, add } = project();
    const a = wall([0, 0], [0, 4000]);
    const b = wall([5000, 0], [5000, 4000]);
    const view = doc.all('plan')[0];
    const dim = add({ kind: 'dimension', viewId: view.id, refs: [{ at: [100, 2000], id: a.id, ref: 'left' }, { at: [4900, 2000], id: b.id, ref: 'right' }], dir: [1, 0], line: [0, -1000] });
    const scene = new Scene(doc);
    let g = dimensionGeometry(doc, scene.walls, dim);
    // Left of a wall going +y is -x: a's left face is at x = -100, b's right face at x = 5100.
    expect(Math.abs(g.pos[1] - g.pos[0])).toBeCloseTo(5200, 3);
    doc.transact('Move', () => doc.update(b.id, { a: [6000, 0], b: [6000, 4000] }));
    g = dimensionGeometry(doc, scene.walls, doc.get(dim.id));
    expect(Math.abs(g.pos[1] - g.pos[0])).toBeCloseTo(6200, 3);
    const pg = planGraphics(ctxFor(doc, new Scene(doc)), doc.get(dim.id));
    expect(pg.texts[0].text).toBe('6200');
  });

  it('keeps text upright and clips lines to polygons', () => {
    expect(readableAngle(Math.PI)).toBeCloseTo(0);
    expect(readableAngle(-Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    const sq = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const parts = clipLine([-5, 5], [15, 5], sq);
    expect(parts).toHaveLength(1);
    expect(parts[0][0][0]).toBeCloseTo(0);
    expect(parts[0][1][0]).toBeCloseTo(10);
  });
});

describe('sections', () => {
  it('fills the walls, floor and roof that the section plane cuts', () => {
    const doc = createSampleProject();
    const scene = new Scene(doc);
    const sec = doc.all('section')[0];
    const cuts = sectionCuts(doc, viewFrame(sec), (el) => scene.mesh(el));
    const kinds = new Set(cuts.map((c) => c.kind));
    expect(kinds.has('wall')).toBe(true);
    expect(kinds.has('floor')).toBe(true);
    expect(kinds.has('roof')).toBe(true);
    for (const c of cuts) for (const f of c.g.fills) expect(f.poly.length).toBeGreaterThanOrEqual(3);
  });
});
