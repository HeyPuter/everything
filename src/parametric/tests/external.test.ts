// Geometry projected from the model ("external geometry"): projection,
// relinking after model changes, the solver holding it fixed, and the kernel
// moving dependent sketch geometry when an earlier feature changes.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { ModelBuilder } from '../src/kernel/build';
import { setOc } from '../src/kernel/occ';
import type { EdgeInfo } from '../src/kernel/protocol';
import type { Frame } from '../src/math/vec';
import type { ExtrudeFeature, Feature, SkEntity, SketchFeature } from '../src/model/types';
import { BASE_FRAMES } from '../src/model/planes';
import { dependencies } from '../src/model/features';
import { validSketch } from '../src/model/validate-sketch';
import { DocStore, newDocument } from '../src/model/document';
import {
  edgesAtVertex, externalPointIds, isExternal, projectEdge, projectEdgeInto, projectVertexInto, resolveExternal, unlinkExternal,
} from '../src/sketch/external';
import { PROJECTED_LOCKED, extendAt, filletCorner, idFactory, trimAt } from '../src/sketch/ops';
import { solveSketch } from '../src/sketch/solver';
import { buildProfiles } from '../src/sketch/profiles';
import { extrude, rect, req, sketch } from './helpers';

const front: Frame = BASE_FRAMES.front;
const line = (name: string, a: [number, number, number], b: [number, number, number]) => ({
  name, type: 'line', a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as [number, number, number], length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), faces: [],
});

describe('projection', () => {
  it('projects lines, end-on lines, circles and arcs parallel to the sketch, and nothing else', () => {
    expect(projectEdge(front, line('e', [0, 0, 5], [10, 0, 5]))).toEqual({ t: 'line', a: [0, 0], b: [10, 0] });
    expect(projectEdge(front, line('e', [3, 4, 0], [3, 4, 10]))).toEqual({ t: 'point', p: [3, 4] });
    const circle = { type: 'circle', a: [5, 0, 2], b: [5, 0, 2], mid: [-5, 0, 2], center: [0, 0, 2], axis: [0, 0, 1], radius: 5 } as const;
    expect(projectEdge(front, { ...circle, a: [5, 0, 2], b: [5, 0, 2], mid: [-5, 0, 2], center: [0, 0, 2], axis: [0, 0, 1] })).toEqual({ t: 'circle', c: [0, 0], r: 5 });
    // A clockwise arc is stored counter-clockwise.
    const arc = projectEdge(front, { type: 'circle', a: [0, 5, 0], b: [5, 0, 0], mid: [3.5355, 3.5355, 0], center: [0, 0, 0], axis: [0, 0, -1], radius: 5 });
    expect(arc).toEqual({ t: 'arc', c: [0, 0], a: [5, 0], b: [0, 5] });
    expect(projectEdge(front, { type: 'circle', a: [5, 0, 0], b: [5, 0, 0], mid: [-5, 0, 0], center: [0, 0, 0], axis: [1, 0, 0], radius: 5 })).toBeNull();
    expect(projectEdge(front, { type: 'bspline', a: [0, 0, 0], b: [1, 1, 0], mid: [0.5, 0.7, 0] })).toBeNull();
  });

  it('shares the end points of projected edges, reuses an edge projected before and never takes over drawn points', () => {
    const sk = sketch('S', [{ id: 'mine', t: 'point', x: 10, y: 0 }]);
    const newId = idFactory(sk);
    const a = projectEdgeInto(sk, front, line('E1:a|E1:b', [0, 0, 0], [10, 0, 0]), newId)!;
    const b = projectEdgeInto(sk, front, line('E1:b|E1:c', [10, 0, 0], [10, 10, 0]), newId)!;
    const la = sk.entities.find((e) => e.id === a) as Extract<SkEntity, { t: 'line' }>;
    const lb = sk.entities.find((e) => e.id === b) as Extract<SkEntity, { t: 'line' }>;
    expect(la.b).toBe(lb.a);
    expect(la.b).not.toBe('mine');
    expect(projectEdgeInto(sk, front, line('E1:a|E1:b', [0, 0, 0], [10, 0, 0]), newId)).toBe(a);
    expect(externalPointIds(sk.entities)).toEqual(new Set([la.a, la.b, lb.b]));
    expect(isExternal(sk, la.a)).toBe(true);
    expect(isExternal(sk, 'mine')).toBe(false);
    expect(validSketch(sk)).toBe(true);
  });

  it('projects a vertex as a point found again from the edges that meet there', () => {
    const edges = [line('A', [0, 0, 0], [10, 0, 0]), line('B', [10, 0, 0], [10, 10, 0]), line('C', [10, 10, 0], [0, 10, 0])];
    expect(edgesAtVertex(edges, [10, 0, 0]).map((x) => x.edge.name).sort()).toEqual(['A', 'B']);
    const sk = sketch('S', []);
    const id = projectVertexInto(sk, front, [10, 0, 0.00001], edges, idFactory(sk))!;
    const p = sk.entities.find((e) => e.id === id)!;
    expect(p).toMatchObject({ t: 'point', x: 10, y: 0, ext: { kind: 'vertex', p: [10, 0, 0] } });
    expect(projectVertexInto(sk, front, [50, 50, 0], edges, idFactory(sk))).toBeNull();
    // The model grows: edge A gets longer and B moves with its end.
    const moved = { A: line('A', [0, 0, 0], [20, 0, 0]), B: line('B', [20, 10, 0], [20, 0, 0]) } as Record<string, ReturnType<typeof line>>;
    const res = resolveExternal(sk, front, (r) => moved[r.name] ?? null);
    expect(res).toEqual({ moved: true, lost: [] });
    expect(p).toMatchObject({ x: 20, y: 0 });
    expect(resolveExternal(sk, front, () => null)).toEqual({ moved: false, lost: [id] });
    expect(p).toMatchObject({ x: 20, y: 0 });
  });

  it('keeps a projected line pointing the same way when the kernel lists its ends the other way round', () => {
    const sk = sketch('S', []);
    const id = projectEdgeInto(sk, front, line('L', [0, 0, 0], [10, 0, 0]), idFactory(sk))!;
    const l = sk.entities.find((e) => e.id === id) as Extract<SkEntity, { t: 'line' }>;
    resolveExternal(sk, front, () => line('L', [12, 0, 0], [0, 0, 0]));
    const pts = Object.fromEntries(sk.entities.filter((e) => e.t === 'point').map((e) => [e.id, [(e as { x: number }).x, (e as { y: number }).y]]));
    expect(pts[l.a]).toEqual([0, 0]);
    expect(pts[l.b]).toEqual([12, 0]);
    // A line seen end-on can no longer drive a line: it is lost, not collapsed.
    expect(resolveExternal(sk, front, () => line('L', [0, 0, 0], [0, 0, 10])).lost).toEqual([id]);
  });

  it('holds projected geometry fixed while the rest of the sketch solves around it', () => {
    const sk = sketch('S', [{ id: 'q', t: 'point', x: 4, y: 3 }]);
    const newId = idFactory(sk);
    const l = projectEdgeInto(sk, front, line('L', [0, 0, 0], [10, 0, 0]), newId)!;
    sk.constraints.push({ id: 'r1', type: 'coincident', refs: ['q', l] });
    const res = solveSketch(sk.entities, sk.constraints, { value: () => 0 });
    expect(res.converged).toBe(true);
    const q = sk.entities.find((e) => e.id === 'q') as { x: number; y: number };
    expect(q.y).toBeCloseTo(0, 9);
    const line0 = sk.entities.filter((e) => e.t === 'point' && e.id !== 'q') as { x: number; y: number }[];
    expect(line0.map((p) => [p.x, p.y])).toEqual([[0, 0], [10, 0]]);
    // Only the point's position along the line is still free.
    expect(res.dof).toBe(1);
    // Unlinked geometry is fixed by an ordinary relation instead.
    expect(unlinkExternal(sk, [l], newId)).toBe(1);
    expect(sk.entities.some((e) => e.ext)).toBe(false);
    expect(sk.constraints.at(-1)).toMatchObject({ type: 'fix', refs: [l] });
    expect(solveSketch(sk.entities, sk.constraints, { value: () => 0 }).dof).toBe(1);
  });

  it('leaves projected geometry to its model edge: no trim, extend or sketch fillet', () => {
    const sk = sketch('S', [{ id: 'u1', t: 'point', x: 5, y: -5 }, { id: 'u2', t: 'point', x: 5, y: 5 }, { id: 'u', t: 'line', a: 'u1', b: 'u2' }]);
    const newId = idFactory(sk);
    const l = projectEdgeInto(sk, front, line('L', [0, 0, 0], [10, 0, 0]), newId)!;
    const m = projectEdgeInto(sk, front, line('M', [10, 0, 0], [10, 10, 0]), newId)!;
    const before = JSON.stringify(sk);
    expect(trimAt(sk, l, [8, 0], newId)).toBe(false);
    expect(extendAt(sk, l, [9, 0], newId)).toBe(false);
    const corner = (sk.entities.find((e) => e.id === l) as Extract<SkEntity, { t: 'line' }>).b;
    expect(filletCorner(sk, corner, 2, newId)).toBe(PROJECTED_LOCKED);
    expect(JSON.stringify(sk)).toBe(before);
    void m;
    // Drawn geometry is still trimmed where it crosses projected geometry.
    expect(trimAt(sk, 'u', [5, 3], newId)).toBe(true);
  });

  it('makes closed profiles from a projected outline', () => {
    const sk = sketch('S', []);
    const newId = idFactory(sk);
    const c: [number, number, number][] = [[0, 0, 0], [10, 0, 0], [10, 5, 0], [0, 5, 0]];
    c.forEach((p, i) => projectEdgeInto(sk, front, line(`e${i}`, p, c[(i + 1) % 4]), newId));
    expect(buildProfiles(sk.entities).regions).toHaveLength(1);
  });

  it('rejects malformed links and records the features a sketch projects from', () => {
    const base = sketch('S2', [{ id: 'p', t: 'point', x: 0, y: 0, ext: { kind: 'edge', edge: { name: 'E1:cap1|E1:side:l3', sig: { type: 'line', m: [0, 0, 0], len: 1 } } } }]);
    expect(validSketch(base)).toBe(true);
    expect(dependencies(base)).toEqual(['E1']);
    expect(validSketch({ ...base, entities: [{ id: 'p', t: 'point', x: 0, y: 0, ext: { kind: 'vertex', edges: [], p: [0, 0, 0] } }] })).toBe(false);
    expect(validSketch({ ...base, entities: [{ id: 's', t: 'spline', pts: ['a', 'b'], ext: { kind: 'edge', edge: { name: 'x', sig: { type: 'line', m: [0, 0, 0], len: 1 } } } } as unknown as SkEntity] })).toBe(false);
  });
});

describe('linked geometry in the kernel', () => {
  beforeAll(async () => {
    setOc(await init());
  });

  /** A box from the front plane, and a second sketch on its top face projecting one edge with a circle on its end. */
  async function setup() {
    const b = new ModelBuilder();
    const box: Feature[] = [sketch('S1', rect(0, 0, 30, 20, 'r')), extrude('E1', 'S1', 10)];
    const first = await b.build(req(box));
    const top = first.faces.find((f) => f.name === 'E1:cap1')!;
    const fr = top.frame!;
    const edge = first.edges.find((e: EdgeInfo) => Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6 && Math.abs(e.a[1] - 20) < 1e-6 && Math.abs(e.b[1] - 20) < 1e-6)!;
    const s2 = sketch('S2', [], { kind: 'face', face: { name: top.name, sig: { type: top.type, c: top.center, n: top.normal, area: top.area } } });
    const newId = idFactory(s2);
    const l = projectEdgeInto(s2, fr, edge, newId, { construction: true })!;
    const ln = s2.entities.find((e) => e.id === l) as Extract<SkEntity, { t: 'line' }>;
    // A circle centred on the end of the edge at x = 30, held there by a coincident relation.
    const end = [ln.a, ln.b].find((id) => {
      const p = s2.entities.find((e) => e.id === id) as { x: number; y: number };
      return Math.abs(fr.o[0] + p.x * fr.x[0] + p.y * fr.y[0] - 30) < 1e-6;
    })!;
    const pe = s2.entities.find((e) => e.id === end) as { x: number; y: number };
    s2.entities.push({ id: 'cc', t: 'point', x: pe.x + 1, y: pe.y + 1 }, { id: 'circ', t: 'circle', c: 'cc', r: 3 });
    s2.constraints.push({ id: 'k', type: 'coincident', refs: ['cc', end] }, { id: 'd', type: 'diameter', refs: ['circ'], value: 6, at: [0, 0], name: 'D1' });
    solveSketch(s2.entities, s2.constraints, { value: (d) => d.value as number });
    const features: Feature[] = [...box, s2, extrude('E2', 'S2', 5)];
    return { b, features, s2, fr };
  }

  const circleCentre = (res: Awaited<ReturnType<ModelBuilder['build']>>, fr: Frame) => {
    const ents = res.sketches!.S2.entities;
    const c = ents.find((e) => e.id === 'cc') as { x: number; y: number };
    return [fr.o[0] + c.x * fr.x[0] + c.y * fr.y[0], fr.o[1] + c.x * fr.x[1] + c.y * fr.y[1]];
  };

  it('moves projected geometry, and what is constrained to it, when an earlier feature changes', async () => {
    const { b, features, fr } = setup2(await setup());
    const res = await b.build(req(features));
    expect(res.status.every((s) => s.ok && !s.warning)).toBe(true);
    expect(circleCentre(res, fr)[0]).toBeCloseTo(30, 6);
    // Widen the box from 30 to 45: the stored sketch still has the old geometry.
    const wider = structuredClone(features);
    const s1 = wider[0] as SketchFeature;
    for (const e of s1.entities) if (e.t === 'point' && e.x === 30) e.x = 45;
    const res2 = await b.build(req(wider));
    expect(res2.status.every((s) => s.ok && !s.warning)).toBe(true);
    expect(circleCentre(res2, fr)[0]).toBeCloseTo(45, 6);
    expect(circleCentre(res2, fr)[1]).toBeCloseTo(20, 6);
    // The boss on the circle moved with it: its centre of mass is at x = 45 now.
    const boss = res2.faces.filter((f) => f.feature === 'E2' && f.type === 'cylinder');
    expect(boss.length).toBeGreaterThan(0);
    expect(boss[0].axis!.p[0]).toBeCloseTo(45, 4);
  });

  it('keeps projected geometry in place with a warning when its edge is gone', async () => {
    const { b, features } = setup2(await setup());
    // A different first sketch: a circle has no straight edges to find.
    const changed = structuredClone(features);
    (changed[0] as SketchFeature).entities = [{ id: 'cp', t: 'point', x: 15, y: 10 }, { id: 'ci', t: 'circle', c: 'cp', r: 8 }];
    const res = await b.build(req(changed));
    const s2 = res.status.find((s) => s.id === 'S2')!;
    expect(s2.ok).toBe(true);
    expect(s2.warning).toMatch(/lost its model edge/);
    expect(res.sketches!.S2.lost).toHaveLength(1);
  });

  it('solves a linked sketch whose dimensions are expressions with their evaluated values', async () => {
    const { features } = setup2(await setup());
    const doc = newDocument('Linked');
    doc.features = structuredClone(features);
    doc.variables = [{ id: 'v', name: 'Dia', expr: '8' }];
    const s2 = doc.features.find((f) => f.id === 'S2') as SketchFeature;
    (s2.constraints.find((c) => c.id === 'd') as { value: number | string }).value = '=Dia';
    const resolved = new DocStore(doc).resolve();
    const r2 = resolved.features.find((f) => f.id === 'S2') as SketchFeature;
    expect((r2.constraints.find((c) => c.id === 'd') as { value: number }).value).toBe(8);
    expect(resolved.errors.size).toBe(0);
    const b = new ModelBuilder();
    const res = await b.build(req(resolved.features));
    expect(res.status.every((s) => s.ok)).toBe(true);
    const circ = res.sketches!.S2.entities.find((e) => e.id === 'circ') as { r: number };
    expect(circ.r).toBeCloseTo(4, 9);
  });
});

/** Extrudes go up from the top face so the second boss is on the box. */
function setup2<T extends { features: Feature[] }>(s: T): T {
  (s.features[3] as ExtrudeFeature).flip = false;
  return s;
}
