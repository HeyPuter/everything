import { describe, it, expect } from 'vitest';
import { createSampleProject } from '../src/core/sample.js';
import { Scene, MODEL_KINDS } from '../src/core/scene.js';
import { planContext } from '../src/core/plan.js';
import { project } from './helpers.js';

describe('sample project', () => {
  const doc = createSampleProject();
  const scene = new Scene(doc);

  it('builds a 3D mesh for every model element', () => {
    for (const k of MODEL_KINDS) {
      for (const el of doc.all(k)) {
        const m = scene.mesh(el);
        expect(m, `${k} ${el.id}`).toBeTruthy();
        expect(m.pos.length % 9, `${k} triangles`).toBe(0);
        expect(m.pos.length + m.edges.length).toBeGreaterThan(0);
        for (const v of m.pos) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('draws the first floor plan', () => {
    const view = doc.all('plan')[0];
    const pc = planContext(doc, view, scene.walls, scene.rooms);
    const shown = scene.planCandidates(view).map((el) => [el, scene.planOf(view, el, pc)]);
    const drawn = shown.filter(([, g]) => g);
    const kinds = new Set(drawn.map(([el]) => el.kind));
    for (const k of ['wall', 'door', 'window', 'floor', 'component', 'room', 'grid', 'dimension', 'section', 'elevation']) expect(kinds.has(k), k).toBe(true);
    // Every room in the sample is enclosed.
    for (const r of doc.all('room')) expect(scene.rooms.room(r), r.name).not.toBeNull();
  });

  it('caches meshes until an input changes', () => {
    const wall = doc.all('wall')[0];
    const a = scene.mesh(wall);
    expect(scene.mesh(wall)).toBe(a);
    const door = doc.all('door').find((d) => d.hostId === wall.id) || doc.all('door')[0];
    doc.transact('Move door', () => doc.update(door.id, { t: door.t + 100 }));
    const host = doc.get(door.hostId);
    const before = scene.meshes.get(host.id)?.mesh;
    expect(scene.mesh(host)).not.toBe(before);
    doc.undo();
  });
});

describe('scene invalidation', () => {
  it('re-solves joins when a neighbor wall moves', () => {
    const { doc, wall } = project();
    const scene = new Scene(doc);
    const a = wall([0, 0], [4000, 0]);
    const b = wall([4000, 0], [4000, 3000]);
    expect(scene.walls.wall(a.id).ends[1].kind).toBe('corner');
    doc.transact('Move', () => doc.update(b.id, { a: [5000, 0], b: [5000, 3000] }));
    expect(scene.walls.wall(a.id).ends[1].kind).toBe('free');
  });

  it('gives stable small indices to element ids', () => {
    const { doc } = project();
    const scene = new Scene(doc);
    const i = scene.indexOf('x');
    expect(scene.indexOf('x')).toBe(i);
    expect(scene.idAt(i)).toBe('x');
    expect(scene.idAt(0)).toBeNull();
  });
});
