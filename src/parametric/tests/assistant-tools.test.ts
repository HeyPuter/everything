// The assistant's modeling tools against the real kernel: what a model would
// call, checked by the resulting geometry.
import { beforeAll, describe, expect, it } from 'vitest';
import init from 'replicad-opencascadejs';
import { setOc } from '../src/kernel/occ';
import type { SketchFeature } from '../src/model/types';
import { TestHost } from './assistant-host';
import { toolSpecs } from '../src/assistant/tools';

beforeAll(async () => {
  setOc(await init());
});

/** A 80 x 50 x 10 plate on the top plane, centred on the origin. */
async function plate() {
  const h = new TestHost();
  await h.call('create_sketch', { plane: 'top', shapes: [{ type: 'rectangle', id: 'base', center: [0, 0], width: 80, height: 50 }] });
  const r = await h.call('add_extrude', { sketch: 's1', depth: 10, name: 'Plate' });
  return { h, r };
}

describe('assistant tools', () => {
  it('sketches a rectangle and extrudes it, reporting faces and volume', async () => {
    const { h, r } = await plate();
    expect(await h.volume()).toBeCloseTo(80 * 50 * 10, 3);
    expect(r.content).toContain('Volume 40000 mm³');
    // The top face is named after the extrude and points up (+Y).
    const top = h.faces.find((f) => f.name.endsWith(':cap1'))!;
    expect(top.normal![1]).toBeCloseTo(1);
    expect(r.content).toContain(top.name);
    const sk = h.store.feature<SketchFeature>('s1')!;
    expect(sk.entities.filter((e) => e.t === 'line').map((e) => e.id).sort()).toEqual(['base_d0', 'base_d1', 'base_l0', 'base_l1', 'base_l2', 'base_l3']);
  });

  it('offers no thin (wall) option, which the kernel does not build, and refuses one', async () => {
    for (const name of ['add_extrude', 'add_revolve']) {
      const spec = toolSpecs().find((t) => t.function.name === name)!;
      expect(Object.keys((spec.function.parameters as { properties: object }).properties)).not.toContain('thin');
    }
    const h = new TestHost();
    await h.call('create_sketch', { plane: 'top', shapes: [{ type: 'circle', center: [0, 0], radius: 10 }] });
    const r = await h.call('add_extrude', { sketch: 's1', depth: 10, thin: { thickness: 1 } }, false);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/thin \(wall\) features are not supported/);
    expect(h.store.doc.features).toHaveLength(1);
  });

  it('drills holes on a face at world points and patterns nothing it should not', async () => {
    const { h } = await plate();
    const top = h.faces.find((f) => f.name.endsWith(':cap1'))!.name;
    const pts = [[-30, 10, -15], [30, 10, -15], [30, 10, 15], [-30, 10, 15]];
    const r = await h.call('add_hole', { on: top, points: pts, diameter: 6 });
    expect(r.content).toContain('position sketch');
    expect(await h.volume()).toBeCloseTo(40000 - 4 * Math.PI * 9 * 10, 1);
  });

  it('finds the vertical edges and fillets them', async () => {
    const { h } = await plate();
    const list = await h.call('find_geometry', { kind: 'edges', direction: [0, 1, 0] });
    const names = [...list.content.matchAll(/^- (\S+) \| line/gm)].map((m) => m[1]);
    expect(names).toHaveLength(4);
    await h.call('add_fillet', { edges: names, radius: 5 });
    expect(await h.volume()).toBeCloseTo(40000 - 4 * (25 - (Math.PI * 25) / 4) * 10, 1);
  });

  it('undoes a step that fails to rebuild and says why', async () => {
    const { h } = await plate();
    const n = h.store.doc.features.length;
    const edge = h.edges[0].name;
    const r = await h.call('add_fillet', { edges: [edge], radius: 100 }, false);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/undone/);
    expect(h.store.doc.features).toHaveLength(n);
    expect(await h.volume()).toBeCloseTo(40000, 3);
  });

  it('rejects unknown names with suggestions', async () => {
    const { h } = await plate();
    const r = await h.call('add_fillet', { edges: ['nope'], radius: 1 }, false);
    expect(r.content).toMatch(/no edge named "nope".*Similar names/);
  });

  it('revolves a profile about a centerline', async () => {
    const h = new TestHost();
    await h.call('create_sketch', {
      plane: 'front',
      shapes: [{ type: 'centerline', from: [0, 0], to: [0, 30] }, { type: 'rectangle', corner1: [10, 0], corner2: [20, 25] }],
    });
    await h.call('add_revolve', { sketch: 's1', angle: 360 });
    expect(await h.volume()).toBeCloseTo(Math.PI * (400 - 100) * 25, 0);
  });

  it('drives sizes from dimensions, variables and expressions', async () => {
    const h = new TestHost();
    await h.call('set_variables', { set: [{ name: 'Width', value: 60 }, { name: 'Depth', value: 'Width / 4' }] });
    await h.call('create_sketch', {
      plane: 'front',
      shapes: [{ type: 'rectangle', id: 'r', corner1: [0, 0], corner2: [50, 20] }],
      dimensions: [{ refs: ['r_l0'], value: '=Width' }, { refs: ['r_l1'], value: 20 }],
    });
    await h.call('add_extrude', { sketch: 's1', depth: '=Depth' });
    expect(await h.volume()).toBeCloseTo(60 * 20 * 15, 2);
    await h.call('set_variables', { set: [{ name: 'Width', value: 80 }] });
    expect(await h.volume()).toBeCloseTo(80 * 20 * 20, 2);
    await h.call('edit_sketch', { sketch: 's1', set_dimensions: [{ dimension: 'D2', value: 30 }] });
    expect(await h.volume()).toBeCloseTo(80 * 30 * 20, 2);
  });

  it('refuses a sketch edit that over-defines the sketch', async () => {
    const h = new TestHost();
    await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'rectangle', id: 'r', corner1: [0, 0], corner2: [50, 20] }], dimensions: [{ refs: ['r_l0'], value: 50 }] });
    const r = await h.call('edit_sketch', { sketch: 's1', dimensions: [{ refs: ['r_l2'], value: 50 }] }, false);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/over-defined/);
    expect(h.store.feature<SketchFeature>('s1')!.constraints.filter((c) => c.type === 'distance')).toHaveLength(1);
  });

  it('patterns a hole around an axis and shells the part', async () => {
    const h = new TestHost();
    await h.call('create_sketch', { plane: 'top', shapes: [{ type: 'circle', center: [0, 0], radius: 40 }] });
    await h.call('add_extrude', { sketch: 's1', depth: 8 });
    const top = h.faces.find((f) => f.name.endsWith(':cap1'))!.name;
    await h.call('add_hole', { on: top, points: [[30, 8, 0]], diameter: 5 });
    const hole = h.store.doc.features.at(-1)!.id;
    await h.call('add_circular_pattern', { features: [hole], axis: 'y', count: 6 });
    expect(await h.volume()).toBeCloseTo(Math.PI * 1600 * 8 - 6 * Math.PI * 6.25 * 8, 0);
  });

  it('works in the part\'s units', async () => {
    const h = new TestHost();
    await h.call('set_part', { units: 'IPS', material: 'Aluminum 6061' });
    await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'rectangle', corner1: [0, 0], corner2: [2, 1] }] });
    const r = await h.call('add_extrude', { sketch: 's1', depth: '0.5in' });
    expect(await h.volume()).toBeCloseTo(2 * 1 * 0.5 * 25.4 ** 3, 0);
    expect(r.content).toContain('size 2 × 1 × 0.5 in');
    const m = await h.call('mass_properties', {});
    expect(m.content).toMatch(/Mass 0\.0975\d* lb/);
  });

  it('edits a feature, reads it back and deletes with dependents', async () => {
    const { h } = await plate();
    const f = h.store.doc.features[1].id;
    await h.call('edit_feature', { feature: 'Plate', params: { depth: 20, end: 'mid_plane' } });
    expect(h.bbox!.min[1]).toBeCloseTo(-10);
    const model = await h.call('get_model', { features: [f] });
    expect(model.content).toContain('"end":"mid_plane"');
    expect(model.content).toContain('"depth":20');
    const del = await h.call('delete_features', { features: ['s1'] }, false);
    expect(del.content).toMatch(/depend/);
    await h.call('delete_features', { features: ['s1'], with_dependents: true });
    expect(h.store.doc.features).toHaveLength(0);
  });

  it('describes a sketch with coordinates, status and profiles', async () => {
    const h = new TestHost();
    await h.call('create_sketch', {
      plane: 'front',
      shapes: [{ type: 'slot', id: 'sl', center: [0, 0], length: 40, width: 10 }, { type: 'point', id: 'pin', at: [0, 20] }],
    });
    const r = await h.call('get_sketch', { sketch: 's1' });
    expect(r.content).toContain('sl_l0 line');
    expect(r.content).toMatch(/Closed profiles: 1 region/);
    expect(r.content).toContain('Stand-alone points (hole centres): pin(0, 20)');
  });

  it('turns a step into a sketch fillet and an offset', async () => {
    const h = new TestHost();
    await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'rectangle', id: 'r', corner1: [0, 0], corner2: [40, 20] }] });
    await h.call('edit_sketch', { sketch: 's1', fillets: [{ point: 'r_p2', radius: 5 }] });
    await h.call('add_extrude', { sketch: 's1', depth: 10 });
    expect(await h.volume()).toBeCloseTo((800 - (25 - (Math.PI * 25) / 4)) * 10, 1);
  });

  it('refuses arguments a tool does not take instead of skipping them', async () => {
    const { h } = await plate();
    // A misspelt depth left the plate as it was and reported "Updated".
    const typo = await h.call('edit_feature', { feature: 'f2', params: { depht: 20 } }, false);
    expect(typo.ok).toBe(false);
    expect(typo.content).toMatch(/f2 \(extrude\) does not take params\.depht\. It takes: sketch, cut, end, depth/);
    const text = await h.call('edit_feature', { feature: 'f2', params: '{"depth": 20}' }, false);
    expect(text.content).toMatch(/params: an object/);
    const add = await h.call('add_extrude', { sketch: 's1', depth: 5, revrse: true }, false);
    expect(add.content).toMatch(/add_extrude does not take revrse/);
    expect(h.store.doc.features).toHaveLength(2);
    // Unset optional arguments are fine.
    await h.call('edit_feature', { feature: 'f2', params: { depth: 20 }, note: null });
    expect(await h.volume()).toBeCloseTo(80000, 3);
  });

  it('refuses a sketch relation or fillet that names nothing, instead of reporting it done', async () => {
    const h = new TestHost();
    await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'rectangle', id: 'r', corner1: [0, 0], corner2: [40, 20] }] });
    const rel = await h.call('edit_sketch', { sketch: 's1', relations: [{ type: 'horizontal', refs: [] }] }, false);
    expect(rel.content).toMatch(/relations\[0\]\.refs: give the entity ids/);
    const fil = await h.call('edit_sketch', { sketch: 's1', fillets: [{ radius: 2 }] }, false);
    expect(fil.content).toMatch(/fillets\[0\]\.point: give the corner point id/);
  });

  it('says when a variable in a shape size or coordinate was used as a value, not linked', async () => {
    const h = new TestHost();
    await h.call('set_variables', { set: [{ name: 'R', value: 7 }] });
    const r = await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'circle', id: 'c', center: [0, 0], radius: '=R' }] });
    expect(r.content).toMatch(/shapes\[0\] \(circle\)\.radius: "=R" was used as its value now, 7 mm.*add a dimension with value "=R"/);
    const hole = await h.call('add_extrude', { sketch: 's1', depth: 5 });
    expect(hole.ok).toBe(true);
    const top = h.faces.find((f) => f.name.endsWith(':cap1'))!.name;
    const holes = await h.call('add_hole', { on: top, points: [['=R/2', 0]], diameter: 2 });
    expect(holes.content).toMatch(/points\[0\]\[0\]: "=R\/2" was used as its value now, 3\.5 mm/);
  });

  it('reports metre coordinates to the same precision as millimetre ones', async () => {
    const h = new TestHost();
    await h.call('set_part', { units: 'MKS' });
    // 12.345 mm: shown as 0.01235 m, a line drawn to the reported point missed the corner by 5 µm.
    const r = await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'rectangle', id: 'r', corner1: [0, 0], corner2: [0.012345, 0.02] }] });
    expect(r.content).toContain('r_p1(0.012345, 0)');
    // A 12.345 x 20 x 10 mm block: its volume in m³ was reported as 0.
    const x = await h.call('add_extrude', { sketch: 's1', depth: 0.01 });
    expect(x.content).toContain('Volume 0.000002469 m³');
    expect((await h.call('mass_properties', {})).content).toMatch(/surface area 0\.00\d+ m²/);
  });
});
