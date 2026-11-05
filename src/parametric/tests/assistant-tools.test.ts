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

const topFace = (h: TestHost) => h.faces.find((f) => f.name.endsWith(':cap1'))!.name;

describe('assistant tools', () => {
  it.each([0, 1e9])('constructs an arc through the requested points at coordinate offset %s', async (offset) => {
    const h = new TestHost();
    await h.call('create_sketch', { plane: 'front', auto_relations: false, shapes: [
      { type: 'arc', id: 'arc', start: [offset + 5, offset], through: [offset, offset + 5], end: [offset - 5, offset] },
    ] });
    const sk = h.store.feature<SketchFeature>('s1')!;
    const center = sk.entities.find((e) => e.id === 'arc_c');
    expect(center).toMatchObject({ t: 'point', x: offset, y: offset });
    const points = sk.entities.flatMap((e) => e.t === 'point' && e.id !== 'arc_c' ? [[e.x, e.y]] : []);
    expect(points).toEqual(expect.arrayContaining([[offset + 5, offset], [offset - 5, offset]]));
  });

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

  it('refuses a collapsed mirror axis and allows retry after restoring its endpoints', async () => {
    const h = new TestHost();
    await h.call('create_sketch', { plane: 'front', auto_relations: false, shapes: [
      { type: 'centerline', id: 'axis', from: [0, -10], to: [0, 10] },
      { type: 'line', id: 'source', from: [3, 1], to: [6, 4] },
    ] });
    await h.call('edit_sketch', { sketch: 's1', move_points: [{ point: 'axis_a', to: [0, 0] }, { point: 'axis_b', to: [0, 0] }] });
    const before = structuredClone(h.store.feature<SketchFeature>('s1'));
    const undo = h.store.undoLabel;
    const r = await h.call('edit_sketch', { sketch: 's1', mirrors: [{ entities: ['source'], axis: 'axis' }] }, false);
    expect(r.ok).toBe(false);
    expect(r.content).toContain('choose a line with distinct endpoints');
    expect(h.store.feature('s1')).toEqual(before);
    expect(h.store.undoLabel).toBe(undo);
    await h.call('edit_sketch', { sketch: 's1', move_points: [{ point: 'axis_a', to: [0, -10] }, { point: 'axis_b', to: [0, 10] }], mirrors: [{ entities: ['source'], axis: 'axis' }] });
    const points = h.store.feature<SketchFeature>('s1')!.entities.filter((e) => e.t === 'point').map((e) => [e.x, e.y]);
    expect(points).toEqual(expect.arrayContaining([[-3, 1], [-6, 4]]));
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

  it('cuts and drills to a depth that is given, also when changing a through-all one', async () => {
    const { h } = await plate();
    await h.call('create_sketch', { plane: topFace(h), shapes: [{ type: 'circle', center: [10, 10, 5], radius: 5 }] });
    await h.call('add_extrude', { sketch: h.store.doc.features.at(-1)!.id, cut: true, depth: 3 });
    expect(await h.volume()).toBeCloseTo(40000 - Math.PI * 25 * 3, 1);
    const cut = h.store.doc.features.at(-1)!.id;
    await h.call('edit_feature', { feature: cut, params: { end: 'through_all' } });
    expect(await h.volume()).toBeCloseTo(40000 - Math.PI * 25 * 10, 1);
    await h.call('edit_feature', { feature: cut, params: { depth: 4 } });
    expect(await h.volume()).toBeCloseTo(40000 - Math.PI * 25 * 4, 1);
    await h.call('add_hole', { on: topFace(h), points: [[-20, 10, 0]], diameter: 6 });
    const hole = h.store.doc.features.at(-1)!.id;
    expect(await h.volume()).toBeCloseTo(40000 - Math.PI * 25 * 4 - Math.PI * 9 * 10, 1);
    await h.call('edit_feature', { feature: hole, params: { depth: 3 } });
    expect(await h.volume()).toBeCloseTo(40000 - Math.PI * 25 * 4 - Math.PI * 9 * 3, 1);
  });

  it('refuses hole centres it would drop, instead of drilling elsewhere and reporting it done', async () => {
    const { h } = await plate();
    await h.call('create_sketch', { plane: 'top', shapes: [{ type: 'point', at: [0, 0] }] });
    const sk = h.store.doc.features.at(-1)!.id;
    const r = await h.call('add_hole', { sketch: sk, points: [[10, 10], [20, 10]], diameter: 4 }, false);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/not both.*edit_sketch/);
    await h.call('add_hole', { on: topFace(h), points: [[-30, 10, -15]], diameter: 6 });
    const hole = h.store.doc.features.at(-1)!.id;
    const e = await h.call('edit_feature', { feature: hole, params: { on: topFace(h), points: [[30, 10, 15]] } }, false);
    expect(e.ok).toBe(false);
    expect(e.content).toMatch(/stand-alone points of its sketch s\d+: move or add them with edit_sketch/);
    expect(await h.volume()).toBeCloseTo(40000 - Math.PI * 9 * 10, 1);
  });

  it('gives a revolve\'s arguments in a form edit_feature takes back', async () => {
    const h = new TestHost();
    await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'centerline', from: [0, 0], to: [0, 30] }, { type: 'rectangle', corner1: [10, 0], corner2: [20, 25] }] });
    await h.call('add_revolve', { sketch: 's1', angle: 360 });
    const m = await h.call('get_model', { features: ['f2'] });
    const args = JSON.parse(/Arguments: (.*)/.exec(m.content)![1]);
    expect(args.axis).toBeNull();
    await h.call('edit_feature', { feature: 'f2', params: { ...args, angle: 180 } });
    expect(await h.volume()).toBeCloseTo((Math.PI * (400 - 100) * 25) / 2, 0);
  });

  it('says when relations put a moved point back', async () => {
    const { h } = await plate();
    // A centre at the face's origin gets a coincident-with-origin relation.
    await h.call('create_sketch', { plane: topFace(h), shapes: [{ type: 'circle', id: 'c', center: [0, 10, 0], radius: 5 }, { type: 'point', id: 'free', at: [5, 10, 5] }] });
    const sk = h.store.doc.features.at(-1)!.id;
    const r = await h.call('edit_sketch', { sketch: sk, move_points: [{ point: 'c_c', to: [20, 10, 0] }, { point: 'free', to: [10, 10, 10] }] });
    const c = h.store.feature<SketchFeature>(sk)!.entities.find((e) => e.id === 'c_c') as { x: number; y: number };
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(0, 9);
    expect(r.content).toMatch(/move_points: c_c was moved to .*but its relations or dimensions put it back/);
    expect(r.content).not.toMatch(/free was moved/);
  });

  it('reports a warning the change leaves on another feature', async () => {
    const { h } = await plate();
    await h.call('create_sketch', { plane: topFace(h), shapes: [{ type: 'circle', id: 'c', center: [10, 10, 5], radius: 5 }] });
    const sk = h.store.doc.features.at(-1)!.id;
    await h.call('add_extrude', { sketch: sk, cut: true });
    const cut = h.store.doc.features.at(-1)!.id;
    const r = await h.call('edit_sketch', { sketch: sk, move_points: [{ point: 'c_c', to: [200, 10, 0] }] });
    expect(r.content).toMatch(new RegExp(`New warnings on other features: ${cut}: .*does not remove any material`));
    // Unchanged warnings are not repeated.
    const again = await h.call('edit_sketch', { sketch: sk, name: 'Moved' });
    expect(again.content).not.toMatch(/New warnings/);
  });

  it('keeps the precision of a small part\'s mass in kilograms and pounds', async () => {
    const h = new TestHost();
    await h.call('set_part', { units: 'MKS', material: 'Aluminum 6061' });
    await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'rectangle', corner1: [0, 0], corner2: [0.01, 0.01] }] });
    await h.call('add_extrude', { sketch: 's1', depth: 0.0012345 });
    // 1.2345e-7 m³ × 2700 kg/m³ = 0.000333315 kg (it read 0.0003 kg).
    expect((await h.call('mass_properties', {})).content).toMatch(/Mass 0\.000333315 kg/);
    await h.call('set_part', { units: 'MMGS' });
    expect((await h.call('mass_properties', {})).content).toMatch(/Mass 0\.333315 g/);
  });

  it('gives feature arguments in metres to the precision results use', async () => {
    const h = new TestHost();
    await h.call('set_part', { units: 'MKS' });
    await h.call('create_sketch', { plane: 'front', shapes: [{ type: 'rectangle', corner1: [0, 0], corner2: [0.01, 0.01] }] });
    await h.call('add_extrude', { sketch: 's1', depth: 0.0012345 });
    // It read 0.001234: a model copying the arguments back moved the geometry.
    expect((await h.call('get_model', { features: ['f2'] })).content).toContain('"depth":0.0012345');
    await h.call('set_part', { units: 'MMGS' });
    expect((await h.call('get_model', { features: ['f2'] })).content).toContain('"depth":1.2345');
  });

  it('sizes a counterbore from a diameter given as a variable', async () => {
    const h = new TestHost();
    await h.call('set_part', { units: 'IPS' });
    await h.call('set_variables', { set: [{ name: 'D', value: 0.5 }] });
    await h.call('create_sketch', { plane: 'top', shapes: [{ type: 'rectangle', center: [0, 0], width: 3, height: 2 }] });
    await h.call('add_extrude', { sketch: 's1', depth: 1 });
    // The defaults came from a 5 mm hole, so the counterbore was smaller than the 12.7 mm hole.
    const r = await h.call('add_hole', { on: topFace(h), points: [[0, 1, 0]], diameter: '=D', kind: 'counterbore' });
    expect(r.ok).toBe(true);
    const hole = h.store.doc.features.at(-1) as { diameter: unknown; cbDiameter: number };
    expect(hole.diameter).toBe('=D');
    expect(hole.cbDiameter).toBeCloseTo(12.7 * 1.8, 6);
  });

  it('measures the angle between an edge and a face as the edge\'s angle to the face', async () => {
    const { h } = await plate();
    const top = topFace(h);
    const inTop = h.edges.find((x) => x.dir && Math.abs(x.dir[0]) > 0.99 && x.a[1] > 9)!.name;
    const upright = h.edges.find((x) => x.dir && Math.abs(x.dir[1]) > 0.99)!.name;
    expect((await h.call('measure', { a: top, b: inTop })).content).toMatch(/Angle between the edge and the face's plane: 0°/);
    expect((await h.call('measure', { a: upright, b: top })).content).toMatch(/Angle between the edge and the face's plane: 90°/);
    expect((await h.call('measure', { a: inTop, b: upright })).content).toMatch(/Angle between their directions: 90°/);
  });

  it('lists what find_geometry was asked for, and refuses a face that does not exist', async () => {
    const { h } = await plate();
    expect((await h.call('find_geometry', { kind: 'edge' })).content).toMatch(/^12 of 12 edges match/);
    expect((await h.call('find_geometry', { kind: 'vertices' }, false)).content).toMatch(/kind: "faces" or "edges"/);
    const r = await h.call('find_geometry', { kind: 'edges', of_face: 'nope' }, false);
    expect(r.ok).toBe(false);
    expect(r.content).not.toMatch(/edges match/);
    expect((await h.call('find_geometry', { kind: 'edges', of_face: topFace(h) })).content).toMatch(/^4 of 12 edges match/);
  });

  it('names add_hole\'s own argument when a hole centre is malformed', async () => {
    const { h } = await plate();
    const r = await h.call('add_hole', { on: topFace(h), points: [0, 10, 0], diameter: 6 }, false);
    expect(r.content).toMatch(/^Error: points\[0\]: expected/);
  });
});
