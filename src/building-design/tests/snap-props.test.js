import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';
import { snapPoint, snapFeatures } from '../src/editor/snap.js';
import { instanceParams, paramPatch, paramValue, isReadOnly, describe as describeEl, TYPE_PARAMS } from '../src/core/props.js';
import { temporaryDimensions } from '../src/editor/tempdims.js';
import { createSampleProject } from '../src/core/sample.js';

function fakeView(scene, els, mmPerPx = 10) {
  return {
    mmPerPx: () => mmPerPx,
    snapFeaturesNear: () => els.map((el) => snapFeatures(scene, el)),
  };
}

describe('snapping', () => {
  it('prefers endpoints, then midpoints, near the cursor', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0]);
    const scene = new Scene(doc);
    const vc = fakeView(scene, [doc.get(w.id)]);
    expect(snapPoint({ vc }, [30, 40])).toMatchObject({ point: [0, 0], kind: 'endpoint' });
    expect(snapPoint({ vc }, [2010, 60]).kind).toBe('midpoint');
  });

  it('tracks angles and rounds lengths from the previous point', () => {
    const { doc } = project();
    const scene = new Scene(doc);
    const vc = fakeView(scene, []);
    const r = snapPoint({ vc, from: [0, 0], units: doc.units }, [3013, 22]);
    expect(r.kind).toBe('tracking');
    expect(r.point[1]).toBeCloseTo(0);
    expect(r.point[0] % 50).toBeCloseTo(0);
  });

  it('can be turned off', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0]);
    const scene = new Scene(doc);
    const vc = fakeView(scene, [doc.get(w.id)]);
    const r = snapPoint({ vc, settings: { enabled: false, angles: false, alignment: false } }, [30, 40]);
    expect(r.point).toEqual([30, 40]);
  });
});

describe('properties', () => {
  it('has parameters for every element kind of the sample', () => {
    const doc = createSampleProject();
    for (const el of doc.items.values()) {
      if (el.kind.endsWith('Type') || el.kind === 'material' || el.kind === 'project') continue;
      const params = instanceParams(el);
      expect(params.length, el.kind).toBeGreaterThan(0);
      const ctx = { doc, scene: new Scene(doc) };
      for (const p of params) expect(() => paramValue(p, el, ctx)).not.toThrow();
    }
    for (const t of Object.keys(TYPE_PARAMS)) expect(doc.all(t).length, t).toBeGreaterThan(0);
  });

  it('turns edits into patches and knows read-only fields', () => {
    const doc = createSampleProject();
    const roof = doc.all('roof')[0];
    const slope = instanceParams(roof).find((p) => p.key === 'slope');
    expect(paramPatch(slope, roof, 45).slopes.every((s) => s === 45)).toBe(true);
    const wall = doc.all('wall')[0];
    const height = instanceParams(wall).find((p) => p.key === 'height');
    expect(isReadOnly(height, wall, { doc })).toBe(true);
    expect(describeEl(doc, wall)).toMatch(/^Wall: /);
  });
});

describe('temporary dimensions', () => {
  it('moves a door by its distance to the wall end', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [5000, 0]);
    const d = add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 2000 });
    const [left, right] = temporaryDimensions(doc, d);
    expect(left.value).toBeCloseTo(2000 - 915 / 2);
    expect(right.value).toBeCloseTo(5000 - 2000 - 915 / 2);
    doc.transact('Edit', () => left.apply(doc, 1000));
    expect(doc.get(d.id).t).toBeCloseTo(1000 + 915 / 2);
  });

  it('sets a wall length', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [3000, 4000]);
    const [len] = temporaryDimensions(doc, w);
    expect(len.value).toBeCloseTo(5000);
    doc.transact('Edit', () => len.apply(doc, 10000));
    expect(doc.get(w.id).b[0]).toBeCloseTo(6000);
    expect(doc.get(w.id).b[1]).toBeCloseTo(8000);
  });
});
