import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { delaunay, topoHeightAt, contours, topoBoundary, sampleTopo } from '../src/core/topo.js';
import { mepSize, mepPlan, connected, systemOf } from '../src/core/mep.js';
import { massLevels, massFloorArea } from '../src/core/massing.js';
import { footingOutline, wallFootingOutline, braceHeights, build3D } from '../src/core/build3d.js';
import { WallSolver } from '../src/core/walls.js';
import { byFace } from '../src/editor/site.js';
import { transferStandards, standardCounts } from '../src/core/transfer.js';
import { createProject } from '../src/core/template.js';
import { deleteElements, transformElements } from '../src/core/ops.js';
import { scheduleRows } from '../src/core/schedule.js';
import { Scene } from '../src/core/scene.js';

const square = [
  [0, 0, 0],
  [10000, 0, 0],
  [10000, 10000, 1000],
  [0, 10000, 1000],
];

describe('topography', () => {
  it('triangulates points and interpolates heights inside the hull only', () => {
    const tris = delaunay(square);
    expect(tris.length).toBe(2);
    const topo = { points: square };
    expect(topoHeightAt(topo, [5000, 5000])).toBeCloseTo(500, 3);
    expect(topoHeightAt(topo, [2000, 2500])).toBeCloseTo(250, 3);
    expect(topoHeightAt(topo, [20000, 5000])).toBeNull();
  });

  it('draws one contour per interval across a sloping surface', () => {
    const segs = contours({ points: square }, 250);
    const levels = new Set(segs.map((s) => s.z));
    expect([...levels].sort((a, b) => a - b)).toEqual([250, 500, 750]);
  });

  it('finds the outline of a sampled surface', () => {
    const pts = sampleTopo(0, 0, 8000, 6000, 0, 500);
    const hull = topoBoundary({ points: pts });
    const xs = hull.map((p) => p[0]);
    const ys = hull.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(8000);
    expect(Math.max(...ys)).toBe(6000);
  });
});

describe('ducts and pipes', () => {
  it('reads sizes from the type unless overridden, and colours by system', () => {
    const { doc, add, L1 } = project();
    const d = add({ kind: 'duct', typeId: 'dct-rect', levelId: L1.id, a: [0, 0], b: [4000, 0], offset: 2700, system: 'supply' });
    const r = add({ kind: 'duct', typeId: 'dct-round', levelId: L1.id, a: [0, 0], b: [0, 3000], offset: 2700, system: 'return' });
    expect(mepSize(doc, d).round).toBeFalsy();
    expect(mepSize(doc, r).round).toBe(true);
    const big = add({ kind: 'duct', typeId: 'dct-rect', levelId: L1.id, a: [0, 0], b: [1000, 0], offset: 2700, width: 800, height: 300 });
    expect(mepSize(doc, big)).toMatchObject({ w: 800, h: 300 });
    expect(systemOf(d).label).not.toBe(systemOf(r).label);
  });

  it('knows which runs meet and extends plan graphics into the joint', () => {
    const { doc, add, L1 } = project();
    const a = add({ kind: 'duct', typeId: 'dct-rect', levelId: L1.id, a: [0, 0], b: [4000, 0], offset: 2700 });
    const b = add({ kind: 'duct', typeId: 'dct-rect', levelId: L1.id, a: [4000, 0], b: [4000, 3000], offset: 2700 });
    expect(connected(doc, a, a.b)).toBe(true);
    expect(connected(doc, a, a.a)).toBe(false);
    expect(b.id).toBeTruthy();
    const plan = mepPlan(doc, a);
    expect(plan.b[0]).toBeGreaterThan(4000);
    expect(plan.a[0]).toBe(0);
  });

  it('builds a mesh and appears in its schedule', () => {
    const { doc, add, L1 } = project();
    const p = add({ kind: 'pipe', typeId: 'pt-copper', levelId: L1.id, a: [0, 0], b: [2500, 0], offset: 2600, system: 'cold' });
    const mesh = build3D({ doc, walls: new WallSolver(doc), material: (id) => doc.get(id) }, p);
    expect(mesh.pos.length).toBeGreaterThan(0);
    // Centred on its middle elevation.
    expect(mesh.bounds.max[2] - 2600).toBeCloseTo(mepSize(doc, p).w / 2, 0);
    const rows = scheduleRows({ doc, scene: new Scene(doc) }, { kind: 'schedule', category: 'pipe', fields: ['system', 'length', 'count'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].values.length).toBeCloseTo(2500);
  });
});

describe('foundations and braces', () => {
  it('sizes footings from their type and wall footings from their wall', () => {
    const { doc, add, wall, L1 } = project();
    const f = add({ kind: 'footing', typeId: 'fdt-pad-1200', levelId: L1.id, at: [1000, 1000], rotation: 0, offset: 0 });
    const o = footingOutline(doc, f);
    expect(Math.max(...o.map((p) => p[0])) - Math.min(...o.map((p) => p[0]))).toBeCloseTo(1200, 3);
    const w = wall([0, 0], [5000, 0]);
    const wf = add({ kind: 'wallFooting', typeId: 'wft-600', wallId: w.id });
    const wo = wallFootingOutline(doc, wf);
    const ys = wo.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(600, 3);
    // Deleting the wall takes its foundation with it.
    doc.transact('del', () => deleteElements(doc, [w.id]));
    expect(doc.get(wf.id)).toBeUndefined();
  });

  it('runs braces from their base level up to the top level', () => {
    const { doc, add, L1, L2 } = project();
    const b = add({ kind: 'brace', typeId: doc.all('beamType')[0].id, levelId: L1.id, a: [0, 0], b: [4000, 0], baseOffset: 0, topLevelId: L2.id, topOffset: 0 });
    const { z0, z1 } = braceHeights(doc, b);
    expect(z0).toBe(L1.elevation);
    expect(z1).toBe(L2.elevation);
  });
});

describe('masses', () => {
  const fakeApp = (doc) => ({ doc, commit: (l, f) => doc.transact(l, f), currentType: (k) => doc.all(`${k}Type`)[0], toast() {} });

  it('reports floors at each level it crosses, and makes floors and walls from them', () => {
    const { doc, add, L1 } = project();
    const m = add({ kind: 'mass', levelId: L1.id, boundary: [[0, 0], [10000, 0], [10000, 5000], [0, 5000]], holes: [], height: 9000, baseOffset: 0 });
    const lv = massLevels(doc, m);
    expect(lv.length).toBeGreaterThanOrEqual(2);
    expect(massFloorArea(doc, m)).toBeCloseTo(lv.length * 50e6, 0);
    const app = fakeApp(doc);
    byFace(app, m, 'floor');
    expect(doc.all('floor').filter((f) => f.massId === m.id)).toHaveLength(lv.length);
    byFace(app, m, 'wall');
    expect(doc.all('wall').filter((w) => w.massId === m.id)).toHaveLength(lv.length * 4);
  });
});

describe('toposurface edits', () => {
  it('moves points with the surface and keeps their elevations', () => {
    const { doc, add } = project();
    const t = add({ kind: 'topo', points: square, thickness: 1000, contour: 500 });
    doc.transact('move', () => transformElements(doc, [t.id], { point: (p) => [p[0] + 100, p[1] + 200] }));
    expect(doc.get(t.id).points[2]).toEqual([10100, 10200, 1000]);
  });
});

describe('transfer project standards', () => {
  it('copies new types with their materials and skips identical ones', () => {
    const src = createProject({ system: 'metric' });
    const doc = createProject({ system: 'metric' });
    const mat = src.transact('m', () => src.add({ kind: 'material', name: 'Rammed Earth', color: '#a0784f' }));
    const wt = src.transact('t', () => src.add({ kind: 'wallType', name: 'Earth 450', layers: [{ function: 'structure', thickness: 450, materialId: mat.id }] }));
    expect(standardCounts(src).types).toBeGreaterThan(10);
    let r;
    doc.transact('x', () => (r = transferStandards(src, doc, ['types'])));
    expect(r.added).toBe(2);
    expect(r.skipped).toBeGreaterThan(10);
    expect(doc.get(wt.id).layers[0].materialId).toBe(mat.id);
    expect(doc.get(mat.id).name).toBe('Rammed Earth');
  });

  it('brings changed items in as renamed copies', () => {
    const src = createProject({ system: 'metric' });
    const doc = createProject({ system: 'metric' });
    const t = src.all('wallType')[0];
    src.transact('e', () => src.update(t.id, { name: t.name, layers: t.layers.map((l) => ({ ...l, thickness: l.thickness + 10 })) }));
    doc.transact('x', () => transferStandards(src, doc, ['types']));
    const copies = doc.all('wallType').filter((x) => x.name === `${t.name} (transferred)`);
    expect(copies).toHaveLength(1);
    expect(doc.get(t.id).layers[0].thickness).toBe(t.layers[0].thickness);
  });
});
