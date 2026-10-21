import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';
import { linkData, linkedLevel, linkFrame, linkPoint } from '../src/core/links.js';

function linked() {
  const other = project();
  other.wall([0, 0], [5000, 0]);
  other.wall([5000, 0], [5000, 4000]);
  return other.doc;
}

describe('linked projects', () => {
  it('places the linked model by origin, rotation and elevation', () => {
    const { doc, add } = project();
    const el = add({ kind: 'link', name: 'Shell', data: linkData(linked()), at: [10000, 0], rotation: 90, z: 500 });
    const scene = new Scene(doc);
    const m = scene.mesh(el);
    expect(m.pos.length).toBeGreaterThan(0);
    // A wall along +X from the link origin now runs along +Y from (10000, 0).
    // ...and the wall along +Y now runs along -X, to x = 10000 - 4000.
    expect(m.bounds.min[0]).toBeGreaterThan(5500);
    expect(m.bounds.max[0]).toBeLessThan(10300);
    expect(m.bounds.max[1]).toBeGreaterThan(4900);
    expect(m.bounds.min[2]).toBeCloseTo(500, 0);
    const p = linkPoint(linkFrame(el), [5000, 0]);
    expect(p[0]).toBeCloseTo(10000);
    expect(p[1]).toBeCloseTo(5000);
  });

  it('draws the linked level that matches each plan', () => {
    const { doc, add, L1 } = project();
    const other = linked();
    const el = add({ kind: 'link', name: 'Shell', data: linkData(other), at: [0, 0], rotation: 0, z: 0 });
    expect(linkedLevel(other, el, L1.elevation).id).toBe(other.levels()[0].id);
    const scene = new Scene(doc);
    const p1 = doc.all('plan').find((v) => v.levelId === L1.id);
    expect(scene.planOf(p1, el).lines.length).toBeGreaterThan(0);
    // Raised far above this project, no linked level is cut by its plans.
    const high = add({ kind: 'link', name: 'High', data: linkData(other), at: [0, 0], rotation: 0, z: 100000 });
    expect(scene.planOf(p1, high).lines.length).toBe(0);
  });

  it('survives a snapshot that cannot be read', () => {
    const { doc, add } = project();
    const el = add({ kind: 'link', name: 'Broken', data: '{oops', at: [0, 0], rotation: 0, z: 0 });
    const scene = new Scene(doc);
    expect(scene.mesh(el)).toBeNull();
    expect(scene.planOf(doc.all('plan')[0], el).lines.length).toBe(0);
  });
});
