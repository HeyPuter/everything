import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { cloudPoints, spotElevationAt, radialTarget, legendEntries } from '../src/core/annotate.js';
import { planGraphics, planContext, tagText } from '../src/core/plan.js';
import { transformPatch, mirrorAcross, rotation } from '../src/core/ops.js';
import { revisionsOnSheet, newRevision } from '../src/core/revisions.js';
import { pointInPolygon } from '../src/core/geom.js';
import { WallSolver } from '../src/core/walls.js';
import { RoomSolver } from '../src/core/rooms.js';

const square = [
  [0, 0],
  [4000, 0],
  [4000, 4000],
  [0, 4000],
];

describe('revision clouds', () => {
  it('scallops bulge outward for either winding', () => {
    for (const loop of [square, square.slice().reverse()]) {
      const pts = cloudPoints(loop, 1000);
      expect(pts.length).toBeGreaterThan(16);
      // Every scallop point lies on or outside the outline.
      expect(pts.filter((p) => pointInPolygon(p, [[1, 1], [3999, 1], [3999, 3999], [1, 3999]])).length).toBe(0);
    }
  });

  it('lists the revisions clouded on a sheet or its views', () => {
    const { doc, add } = project();
    const plan = doc.all('plan')[0];
    const sheet = add({ kind: 'sheet', number: 'A101', name: 'Plan', size: 'A1' });
    add({ kind: 'viewport', viewId: sheet.id, placedId: plan.id, at: [300, 300] });
    let r1;
    let r2;
    doc.transact('revs', () => {
      r1 = doc.add(newRevision(doc));
      r2 = doc.add(newRevision(doc));
    });
    expect(r2.seq).toBe(2);
    add({ kind: 'revisionCloud', viewId: plan.id, boundary: square, revisionId: r2.id });
    expect(revisionsOnSheet(doc, sheet).map((r) => r.id)).toEqual([r2.id]);
    add({ kind: 'revisionCloud', viewId: sheet.id, boundary: square, revisionId: r1.id });
    expect(revisionsOnSheet(doc, sheet).map((r) => r.id)).toEqual([r1.id, r2.id]);
  });
});

describe('spot elevations', () => {
  it('read the floor under the point, or the level', () => {
    const { doc, add, L1, L2 } = project();
    const plan2 = doc.all('plan').find((v) => v.levelId === L2.id);
    expect(spotElevationAt(doc, plan2, [500, 500])).toBe(L2.elevation);
    add({ kind: 'floor', typeId: 'ft-generic', levelId: L2.id, boundary: square, holes: [], offset: -50 });
    expect(spotElevationAt(doc, plan2, [500, 500])).toBe(L2.elevation - 50);
    void L1;
  });
});

describe('annotation graphics', () => {
  it('draws every new kind in a plan', () => {
    const { doc, add } = project();
    const view = doc.all('plan')[0];
    const pc = planContext(doc, view, new WallSolver(doc), new RoomSolver(doc, new WallSolver(doc)));
    const arc = add({ kind: 'detailArc', viewId: view.id, c: [0, 0], r: 500, a0: 0, a1: Math.PI * 2 });
    const els = [
      arc,
      add({ kind: 'angularDim', viewId: view.id, c: [0, 0], r: 1000, a0: 0, a1: 1 }),
      add({ kind: 'radialDim', viewId: view.id, targetId: arc.id, angle: 0, diameter: true }),
      add({ kind: 'spot', viewId: view.id, mode: 'elevation', at: [0, 0], leader: [500, 500] }),
      add({ kind: 'spot', viewId: view.id, mode: 'coordinate', at: [0, 0], leader: [500, 500] }),
      add({ kind: 'insulation', viewId: view.id, a: [0, 0], b: [2000, 0], width: 100 }),
      add({ kind: 'detailItem', viewId: view.id, family: 'steelI', at: [0, 0], w: 150, h: 300 }),
      add({ kind: 'symbol', viewId: view.id, family: 'north', at: [0, 0] }),
      add({ kind: 'symbol', viewId: view.id, family: 'scale', at: [0, 0] }),
      add({ kind: 'colorLegend', viewId: view.id, at: [0, 0] }),
      add({ kind: 'revisionCloud', viewId: view.id, boundary: square }),
    ];
    for (const el of els) {
      const g = planGraphics(pc, el);
      expect(g, el.kind).toBeTruthy();
      expect(g.picks.length + g.lines.length, el.kind).toBeGreaterThan(0);
    }
    expect(radialTarget(doc, els[2]).r).toBe(500);
  });

  it('tags show marks, types, materials and keynotes', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [4000, 0]);
    doc.transact('kn', () => doc.update('wt-generic', { mark: 'W1', keynote: '04 22 00' }));
    expect(tagText(doc, doc.get(w.id), 'type')).toBe('W1');
    expect(tagText(doc, doc.get(w.id), 'keynote')).toBe('04 22 00');
    expect(tagText(doc, doc.get(w.id), 'material')).toBe('Default');
    const d = add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 1000, mark: '7' });
    expect(tagText(doc, d)).toBe('7');
  });

  it('legend entries follow the colour scheme of the view', () => {
    const { doc, add, L1 } = project();
    const view = doc.all('plan').find((v) => v.levelId === L1.id);
    add({ kind: 'room', levelId: L1.id, at: [0, 0], name: 'Office', department: 'Admin' });
    add({ kind: 'room', levelId: L1.id, at: [9000, 0], name: 'Lab', department: 'Admin' });
    expect(legendEntries(doc, view).map((e) => e[0])).toEqual(['Lab', 'Office']);
    expect(legendEntries(doc, { ...view, roomFillBy: 'department' }).map((e) => e[0])).toEqual(['Admin']);
  });
});

describe('transforming annotations', () => {
  it('rotates arcs and keeps their sweep when mirrored', () => {
    const arc = { kind: 'detailArc', c: [0, 0], r: 100, a0: 0, a1: Math.PI / 2 };
    const r = transformPatch(arc, rotation([0, 0], Math.PI / 2));
    expect(r.a0).toBeCloseTo(Math.PI / 2);
    expect(r.a1).toBeCloseTo(Math.PI);
    const m = transformPatch(arc, mirrorAcross([0, 0], [0, 1]));
    expect(m.a1 - m.a0).toBeCloseTo(Math.PI / 2);
    // Mirrored across the y axis the quarter arc spans the second quadrant.
    expect(Math.cos((m.a0 + m.a1) / 2)).toBeLessThan(0);
  });
});
