// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newMeshData, newObject, newMaterial } from '../../src/data/defaults';
import type { MeshData, ObjectData } from '../../src/data/types';
import { addObjectToScene } from '../../src/ops/object';
import '../../src/ops/data';
import '../../src/object/index';
import * as prim from '../../src/mesh/primitives';
import { edgeChains, flipSideName, levelWeights, mirrorShapeKey, mirrorVertexGroups, mirrorVertexMap, mixShapeKeys, quantizeWeights, sortedGroupOrder, surfaceCenter, uniqueIn, volumeCenter } from '../../src/object/core';
import { PointGrid } from '../../src/object/nearest';
import { growSelection, shrinkSelection } from '../../src/object/select';
import { mix, transferData } from '../../src/object/transfer';

beforeEach(() => setApp(new App(startupDocument())));

const cube = () => Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
const meshOf = (o: ObjectData) => app.doc.meshes[o.data!];
const near = (a: ArrayLike<number>, b: number[], eps = 1e-5) => b.every((v, i) => Math.abs(a[i] - v) < eps);

function select(...obs: ObjectData[]) {
  for (const o of Object.values(app.doc.objects)) o.select = false;
  for (const o of obs) o.select = true;
  app.doc.scene.active_object = obs[0]?.id ?? null;
  app.graph.evaluate(app.doc, false);
}

function addCube(name: string, loc: [number, number, number] = [0, 0, 0]): ObjectData {
  const me = newMeshData(name, prim.cube(2));
  app.doc.meshes[me.id] = me;
  const ob = newObject(name, 'MESH', me.id);
  addObjectToScene(app.doc, ob, { location: loc });
  return ob;
}

function addEmpty(name: string, parent?: ObjectData): ObjectData {
  const ob = newObject(name, 'EMPTY', null);
  addObjectToScene(app.doc, ob, { location: [0, 0, 0] });
  if (parent) ob.parent = parent.id;
  return ob;
}

function run(op: string, props: Record<string, unknown> = {}) {
  const r = app.run(op, props, { invoke: false });
  app.graph.evaluate(app.doc, false);
  return r;
}

describe('name and math helpers', () => {
  it('flips side markers in names', () => {
    expect(flipSideName('Arm.L')).toBe('Arm.R');
    expect(flipSideName('hand_r')).toBe('hand_l');
    expect(flipSideName('L-foot')).toBe('R-foot');
    expect(flipSideName('Arm.L.001')).toBe('Arm.R.001');
    expect(flipSideName('leftEye')).toBe('rightEye');
    expect(flipSideName('Spine')).toBe('Spine');
    expect(uniqueIn(['Group', 'Group.001'], 'Group')).toBe('Group.002');
  });

  it('finds mirrored vertices across X', () => {
    const map = mirrorVertexMap(new Float32Array([1, 1, 1, -1, 1, 1, 0, 2, 0, 3, 0, 0]));
    expect(Array.from(map)).toEqual([1, 0, 2, -1]);
  });

  it('applies levels and quantize to assigned weights only', () => {
    const w = new Float32Array([0.3, 0.3, 0.8, 0]);
    expect(Array.from(levelWeights(w, 0.1, 2)).map((x) => +x.toFixed(3))).toEqual([0.8, 0.8, 1, 0]);
    expect(Array.from(quantizeWeights(new Float32Array([0.8, 0.3, 0]), 4))).toEqual([0.75, 0.25, 0]);
  });

  it('sorts group names naturally', () => {
    expect(sortedGroupOrder(['b', 'a10', 'a2'], 'NAME')).toEqual([2, 1, 0]);
    expect(sortedGroupOrder(['x', 'Hip', 'Spine'], 'BONE_HIERARCHY', ['Spine', 'Hip'])).toEqual([2, 1, 0]);
  });

  it('computes surface and volume centers', () => {
    const me = newMeshData('c', prim.cube(2));
    // shift so that the centre is not the origin
    me.positions = me.positions.map((v, i) => (i % 3 === 0 ? v + 3 : v));
    expect(near(surfaceCenter(me), [3, 0, 0])).toBe(true);
    expect(near(volumeCenter(me), [3, 0, 0])).toBe(true);
  });

  it('splits mesh edges into chains', () => {
    // a square face plus a loose tail edge 2-4
    const chains = edgeChains([0, 4], [0, 1, 2, 3], 5, [2, 4]);
    const total = chains.reduce((n, c) => n + (c.cyclic ? c.verts.length : c.verts.length - 1), 0);
    expect(total).toBe(5); // four face edges + one loose edge
    const loop = edgeChains([0, 4], [0, 1, 2, 3], 4);
    expect(loop).toEqual([{ verts: [0, 1, 2, 3], cyclic: true }]);
  });

  it('finds nearest points', () => {
    const pts = new Float32Array(300);
    for (let i = 0; i < 100; i++) pts.set([Math.sin(i) * 5, Math.cos(i * 1.3) * 5, (i % 7) - 3], i * 3);
    const g = new PointGrid(pts);
    for (const q of [[0, 0, 0], [10, 10, 10], [-2, 3, 1]]) {
      let best = -1,
        bd = Infinity;
      for (let i = 0; i < 100; i++) {
        const d = (pts[i * 3] - q[0]) ** 2 + (pts[i * 3 + 1] - q[1]) ** 2 + (pts[i * 3 + 2] - q[2]) ** 2;
        if (d < bd) (bd = d), (best = i);
      }
      expect(g.nearest(q[0], q[1], q[2])[0]).toBe(best);
    }
  });

  it('mixes values', () => {
    expect(mix('MIX', 0.5, 0, 1)).toBe(0.5);
    expect(mix('ADD', 0.5, 0.2, 1)).toBeCloseTo(0.7);
    expect(mix('ABOVE_THRESHOLD', 0.5, 0.2, 1)).toBe(0.2);
  });
});

describe('object selection', () => {
  it('grows and shrinks along parent links', () => {
    const a = addEmpty('A');
    const b = addEmpty('B', a);
    const c = addEmpty('C', b);
    const d = addEmpty('D', c);
    const e = addEmpty('E', a);
    select(c);
    expect(growSelection(app.doc, () => true).sort()).toEqual([b.id, d.id].sort());
    run('object.select_more');
    expect([a, b, c, d, e].filter((o) => o.select).map((o) => o.name)).toEqual(['B', 'C', 'D']);
    select(a, b, c);
    expect(shrinkSelection(app.doc).sort()).toEqual([a.id, c.id].sort());
    run('object.select_less');
    expect([a, b, c, d, e].filter((o) => o.select).map((o) => o.name)).toEqual(['B']);
  });

  it('selects by collection, hooks and linked data', () => {
    const c1 = cube();
    const c2 = addCube('Other');
    c2.data = c1.data;
    select(c1);
    run('object.select_linked', { type: 'OBDATA' });
    expect(c2.select).toBe(true);
    select(c1);
    run('object.select_same_collection', { collection: 'Collection' });
    expect(app.doc.objects[app.doc.scene.camera!].select).toBe(true);
  });
});

describe('vertex groups', () => {
  function withGroups() {
    const ob = cube();
    select(ob);
    const me = meshOf(ob);
    run('object.vertex_group_add');
    run('object.vertex_group_add');
    me.vertex_groups[0].name = 'Arm.L';
    me.vertex_groups[1].name = 'Arm.R';
    return { ob, me };
  }

  it('copies, moves, sorts and locks groups', () => {
    const { ob, me } = withGroups();
    me.weights[0] = new Float32Array(8).fill(0.5);
    ob.vertex_group_active_index = 0;
    run('object.vertex_group_copy');
    expect(me.vertex_groups.map((g) => g.name)).toEqual(['Arm.L', 'Arm.R', 'Arm.L_copy']);
    expect(me.weights[2][0]).toBe(0.5);
    run('object.vertex_group_move', { direction: 'UP' });
    expect(me.vertex_groups.map((g) => g.name)).toEqual(['Arm.L', 'Arm.L_copy', 'Arm.R']);
    expect(ob.vertex_group_active_index).toBe(1);
    run('object.vertex_group_sort', { sort_type: 'NAME' });
    expect(me.vertex_groups.map((g) => g.name)).toEqual(['Arm.L', 'Arm.L_copy', 'Arm.R']);
    run('object.vertex_group_lock', { action: 'LOCK', mask: 'ALL' });
    expect(me.vertex_groups.every((g) => g.lock_weight)).toBe(true);
    run('object.vertex_group_lock', { action: 'UNLOCK', mask: 'SELECTED' });
    expect(me.vertex_groups.map((g) => !!g.lock_weight)).toEqual([true, false, true]);
    run('object.vertex_group_remove', { all_unlocked: true });
    expect(me.vertex_groups.map((g) => g.name)).toEqual(['Arm.L', 'Arm.R']);
    run('object.vertex_group_remove', { all: true });
    expect(me.vertex_groups).toEqual([]);
  });

  it('mirrors weights and swaps left/right groups', () => {
    const { ob, me } = withGroups();
    const P = me.positions;
    const left = Array.from({ length: 8 }, (_, i) => i).filter((i) => P[i * 3] > 0);
    const w = new Float32Array(8);
    for (const i of left) w[i] = 0.7;
    me.weights[0] = w;
    ob.vertex_group_active_index = 0;
    run('object.vertex_group_mirror');
    // Arm.R now holds the mirrored weights on the -X side, Arm.L got the (empty) mirror of Arm.R
    for (let i = 0; i < 8; i++) expect(me.weights[1][i]).toBeCloseTo(P[i * 3] < 0 ? 0.7 : 0);
    expect(Math.max(...me.weights[0])).toBe(0);
    // single group without a partner mirrors onto itself and gets renamed
    const m2: MeshData = { ...me, vertex_groups: [{ name: 'Leg.L' }], weights: [w] };
    mirrorVertexGroups(m2, 0, { mirror_weights: true, flip_group_names: true, all_groups: false });
    expect(m2.vertex_groups[0].name).toBe('Leg.R');
    for (let i = 0; i < 8; i++) expect(m2.weights[0][i]).toBeCloseTo(P[i * 3] < 0 ? 0.7 : 0);
  });

  it('applies levels and quantize via operators and respects locks', () => {
    const { ob, me } = withGroups();
    me.weights[0] = new Float32Array(8).fill(0.3);
    me.weights[1] = new Float32Array(8).fill(0.3);
    me.vertex_groups[1].lock_weight = true;
    ob.vertex_group_active_index = 0;
    run('object.vertex_group_levels', { group_select_mode: 'ALL', offset: 0.1, gain: 2 });
    expect(me.weights[0][0]).toBeCloseTo(0.8);
    expect(me.weights[1][0]).toBeCloseTo(0.3);
    run('object.vertex_group_quantize', { steps: 2 });
    expect(me.weights[0][0]).toBeCloseTo(1);
  });

  it('copies groups to selected meshes with matching vertex counts', () => {
    const { ob, me } = withGroups();
    me.weights[1] = new Float32Array(8).fill(0.25);
    const other = addCube('Other', [3, 0, 0]);
    select(ob, other);
    run('object.vertex_group_copy_to_selected');
    expect(meshOf(other).vertex_groups.map((g) => g.name)).toEqual(['Arm.L', 'Arm.R']);
    expect(meshOf(other).weights[1][3]).toBe(0.25);
  });
});

describe('shape keys', () => {
  function withKeys() {
    const ob = cube();
    select(ob);
    const me = meshOf(ob);
    run('object.shape_key_add');
    run('object.shape_key_add');
    run('object.shape_key_add');
    const d1 = new Float32Array(me.shape_keys[0].data);
    d1[0] += 1;
    me.shape_keys[1] = { ...me.shape_keys[1], data: d1, value: 0.5 };
    const d2 = new Float32Array(me.shape_keys[0].data);
    d2[2] += 2;
    me.shape_keys[2] = { ...me.shape_keys[2], data: d2, value: 1 };
    return { ob, me, x0: me.positions[0], z0: me.positions[2] };
  }

  it('mixes, adds from mix and clears values', () => {
    const { me, x0, z0 } = withKeys();
    const mixed = mixShapeKeys(me);
    expect(mixed[0]).toBeCloseTo(x0 + 0.5);
    expect(mixed[2]).toBeCloseTo(z0 + 2);
    run('object.shape_key_add', { from_mix: true });
    expect(me.shape_keys.at(-1)!.data[0]).toBeCloseTo(x0 + 0.5);
    run('object.shape_key_clear');
    expect(me.shape_keys.every((k) => k.value === 0)).toBe(true);
  });

  it('duplicates and moves keys, keeping the basis first', () => {
    const { me } = withKeys();
    me.active_shape_key_index = 1;
    run('object.shape_key_copy');
    expect(me.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Key 1', 'Key 1.001', 'Key 2']);
    expect(me.active_shape_key_index).toBe(2);
    run('object.shape_key_move', { type: 'BOTTOM' });
    expect(me.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Key 1', 'Key 2', 'Key 1.001']);
    run('object.shape_key_move', { type: 'TOP' });
    expect(me.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Key 1.001', 'Key 1', 'Key 2']);
  });

  it('makes a key the basis and applies a key to the basis', () => {
    const { me, x0, z0 } = withKeys();
    me.active_shape_key_index = 1;
    run('object.shape_key_apply_to_basis');
    expect(me.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Key 2']);
    expect(me.positions[0]).toBeCloseTo(x0 + 0.5);
    expect(me.shape_keys[1].data[0]).toBeCloseTo(x0 + 0.5);
    expect(me.shape_keys[1].data[2]).toBeCloseTo(z0 + 2);
    me.active_shape_key_index = 1;
    run('object.shape_key_make_basis');
    expect(me.shape_keys[0].name).toBe('Key 2');
    expect(me.shape_keys[1].relative_key).toBe('Key 2');
    expect(me.positions[2]).toBeCloseTo(z0 + 2);
  });

  it('applies or deletes all keys', () => {
    const { me, x0 } = withKeys();
    run('object.shape_key_remove', { all: true, apply_mix: true });
    expect(me.shape_keys).toEqual([]);
    expect(me.positions[0]).toBeCloseTo(x0 + 0.5);
  });

  it('mirrors a key across X', () => {
    const rel = new Float32Array([1, 0, 0, -1, 0, 0]);
    const data = new Float32Array([1.5, 0.2, 0, -1, 0, 0]);
    const out = mirrorShapeKey(data, rel, mirrorVertexMap(rel));
    expect(Array.from(out).map((v) => +v.toFixed(3))).toEqual([1, 0, 0, -1.5, 0.2, 0]);
  });

  it('creates and updates keys from other objects', () => {
    const ob = cube();
    const other = addCube('Target', [4, 0, 0]);
    const om = meshOf(other);
    om.positions = om.positions.map((v, i) => (i === 2 ? v + 3 : v));
    select(ob, other);
    run('object.join_shapes');
    const me = meshOf(ob);
    expect(me.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Target']);
    expect(me.shape_keys[1].data[2]).toBeCloseTo(om.positions[2]);
    om.positions = om.positions.map((v, i) => (i === 2 ? v + 1 : v));
    app.graph.evaluate(app.doc, false);
    run('object.update_shapes');
    expect(me.shape_keys[1].data[2]).toBeCloseTo(om.positions[2]);
  });
});

describe('material slots', () => {
  it('moves slots, removes unused slots and copies slots to selected objects', () => {
    const ob = cube();
    select(ob);
    const me = meshOf(ob);
    const m1 = newMaterial('A'),
      m2 = newMaterial('B');
    app.doc.materials[m1.id] = m1;
    app.doc.materials[m2.id] = m2;
    me.materials = [m1.id, m2.id, null];
    me.material_index = new Uint16Array(6).fill(0);
    me.material_index[5] = 1;
    ob.active_material_index = 1;
    run('object.material_slot_move', { direction: 'UP' });
    expect(me.materials).toEqual([m2.id, m1.id, null]);
    expect(Array.from(me.material_index!)).toEqual([1, 1, 1, 1, 1, 0]);
    run('object.material_slot_remove_unused');
    expect(me.materials).toEqual([m2.id, m1.id]);
    const other = addCube('Other');
    select(ob, other);
    run('object.material_slot_copy');
    expect(meshOf(other).materials).toEqual([m2.id, m1.id]);
    run('object.material_slot_remove_all');
    expect(me.materials).toEqual([]);
    expect(meshOf(other).materials).toEqual([]);
  });
});

describe('modifiers and hooks', () => {
  it('moves, clears, copies and applies a deform modifier as a shape key', () => {
    const ob = cube();
    select(ob);
    run('object.modifier_add', { type: 'SUBSURF' });
    run('object.modifier_add', { type: 'SIMPLE_DEFORM' });
    const [a, b] = ob.modifiers;
    run('object.modifier_move_up', { modifier: b.name });
    expect(ob.modifiers.map((m) => m.type)).toEqual(['SIMPLE_DEFORM', 'SUBSURF']);
    run('object.modifier_move_down', { modifier: b.id });
    expect(ob.modifiers[1]).toBe(ob.modifiers.find((m) => m.type === 'SIMPLE_DEFORM'));
    void a;
    const other = addCube('Other');
    select(ob, other);
    run('object.modifiers_copy_to_selected');
    expect(other.modifiers.map((m) => m.type)).toEqual(['SUBSURF', 'SIMPLE_DEFORM']);
    expect(other.modifiers[0].id).not.toBe(ob.modifiers[0].id);
    select(ob);
    run('object.modifier_apply_as_shapekey', { modifier: ob.modifiers[1].id, keep_modifier: true });
    const me = meshOf(ob);
    expect(me.shape_keys.map((k) => k.name)).toEqual(['Basis', 'Simple Deform']);
    expect(me.shape_keys[1].data.some((v, i) => Math.abs(v - me.shape_keys[0].data[i]) > 1e-3)).toBe(true);
    expect(ob.modifiers.length).toBe(2);
    select(ob, other);
    run('object.modifiers_clear');
    expect(ob.modifiers).toEqual([]);
    expect(other.modifiers).toEqual([]);
  });

  it('hooks vertices to a selected object and manages the hook', () => {
    const ob = cube();
    const target = addEmpty('Handle');
    target.location = [1, 1, 1];
    app.graph.evaluate(app.doc, false);
    select(ob, target);
    app.doc.scene.active_object = ob.id;
    run('object.mode_set', { mode: 'EDIT' });
    const me = meshOf(ob);
    me.select_vert = new Uint8Array(8);
    me.select_vert[0] = 1;
    run('object.hook_add_selob');
    const hook = ob.modifiers.find((m) => m.type === 'HOOK')!;
    expect(hook.object).toBe(target.id);
    expect(hook.vertex_indices).toEqual([0]);
    me.select_vert = new Uint8Array(8);
    me.select_vert[1] = me.select_vert[2] = 1;
    run('object.hook_assign', { modifier: hook.id });
    expect(hook.vertex_indices).toEqual([1, 2]);
    me.select_vert = new Uint8Array(8);
    run('object.hook_select', { modifier: hook.id });
    expect(Array.from(me.select_vert!)).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);
    run('object.mode_set', { mode: 'OBJECT' });
    // moving the handle deforms the hooked vertices; resetting makes the new place the rest
    target.location = [1, 1, 3];
    app.graph.evaluate(app.doc, false);
    const ev = () => app.graph.get(ob.id)!.mesh!.positions;
    expect(ev()[1 * 3 + 2]).toBeCloseTo(me.positions[1 * 3 + 2] + 2);
    select(ob);
    run('object.hook_reset', { modifier: hook.id });
    expect(ev()[1 * 3 + 2]).toBeCloseTo(me.positions[1 * 3 + 2]);
    app.doc.scene.cursor.location = [0, 0, 5];
    run('object.hook_recenter', { modifier: hook.id });
    expect(hook.center).toEqual([0, 0, 5]);
    run('object.hook_remove', { modifier: hook.id });
    expect(ob.modifiers.some((m) => m.type === 'HOOK')).toBe(false);
  });
});

describe('relations', () => {
  it('makes data and materials single user', () => {
    const ob = cube();
    const other = addCube('Other');
    other.data = ob.data;
    const me = meshOf(ob);
    const ma = newMaterial('Shared');
    app.doc.materials[ma.id] = ma;
    me.materials = [ma.id];
    select(other);
    run('object.make_single_user', { obdata: true, material: true });
    expect(other.data).not.toBe(ob.data);
    expect(meshOf(other).materials[0]).not.toBe(ma.id);
    expect(app.doc.materials[meshOf(other).materials[0]!].name).toBe('Shared.001');
  });

  it('links collections and instance collections, copies UVs', () => {
    const ob = cube();
    const other = addCube('Other');
    const col = Object.values(app.doc.collections).find((c) => c.objects.includes(ob.id))!;
    for (const c of Object.values(app.doc.collections)) c.objects = c.objects.filter((x) => x !== other.id);
    app.doc.collections[app.doc.scene.collection].objects.push(other.id);
    select(ob, other);
    run('object.make_links_data', { type: 'GROUPS' });
    expect(col.objects).toContain(other.id);
    meshOf(ob).uvs = meshOf(ob).uvs.map(() => 0.25);
    run('object.join_uvs');
    expect(meshOf(other).uvs[3]).toBe(0.25);
  });

  it('moves rotation and scale into deltas', () => {
    const ob = cube();
    select(ob);
    ob.rotation_euler = [0.5, 0, 0];
    ob.scale = [2, 2, 2];
    run('object.transforms_to_deltas', { mode: 'ROT' });
    expect(ob.rotation_euler).toEqual([0, 0, 0]);
    expect(ob.delta_rotation_euler[0]).toBeCloseTo(0.5);
    run('object.transforms_to_deltas', { mode: 'SCALE', reset_values: false });
    expect(ob.delta_scale).toEqual([2, 2, 2]);
    expect(ob.scale).toEqual([2, 2, 2]);
  });

  it('adds a lattice around the selection with deform modifiers', () => {
    const ob = cube();
    ob.location = [2, 0, 0];
    app.graph.evaluate(app.doc, false);
    select(ob);
    run('object.lattice_add_to_selected', { margin: 0.5, resolution_u: 3 });
    const lt = app.activeObject!;
    expect(lt.type).toBe('LATTICE');
    expect(lt.location.map((v) => +v.toFixed(4))).toEqual([2, 0, 0]);
    expect(lt.scale.map((v) => +v.toFixed(4))).toEqual([3, 3, 3]);
    expect(app.doc.lattices[lt.data!].points_u).toBe(3);
    expect(ob.modifiers.some((m) => m.type === 'LATTICE' && m.object === lt.id)).toBe(true);
    // undeformed lattice leaves the mesh in place
    app.graph.evaluate(app.doc, false);
    expect(near(app.graph.get(ob.id)!.mesh!.positions, Array.from(meshOf(ob).positions), 1e-4)).toBe(true);
  });

  it('converts a mesh to a curve made of its edges', () => {
    const ob = cube();
    select(ob);
    run('object.convert', { target: 'CURVE' });
    expect(ob.type).toBe('CURVE');
    const cu = app.doc.curves[ob.data!];
    const edges = cu.splines.reduce((n, s) => n + (s.use_cyclic_u ? s.points.length : s.points.length - 1), 0);
    expect(edges).toBe(12);
  });

  it('parents with a lattice deform modifier', () => {
    const ob = cube();
    run('object.add', { type: 'LATTICE', location: [0, 0, 0] });
    const lt = app.activeObject!;
    select(lt, ob);
    run('object.parent_set', { type: 'LATTICE' });
    expect(ob.parent).toBe(lt.id);
    expect(ob.modifiers.some((m) => m.type === 'LATTICE' && m.object === lt.id)).toBe(true);
  });

  it('transfers weights by nearest vertex', () => {
    const src = cube();
    const dst = addCube('Dst');
    const S = meshOf(src),
      D = meshOf(dst);
    S.vertex_groups = [{ name: 'G' }];
    S.weights = [Float32Array.from({ length: 8 }, (_, i) => i / 10)];
    // shuffle the destination vertex order so index matching would be wrong
    const n = transferData({ me: S, positions: S.positions, activeGroup: 0 }, { me: D, positions: new Float32Array(D.positions).reverse(), activeGroup: 0 }, { data_type: 'VGROUP_WEIGHTS', mapping: 'NEAREST', use_create: true, layers_select_src: 'ACTIVE', layers_select_dst: 'NAME', mix_mode: 'REPLACE', mix_factor: 1, max_distance2: Infinity });
    expect(n).toBe(1);
    expect(D.vertex_groups[0].name).toBe('G');
    expect(D.weights[0].some((w) => w > 0)).toBe(true);
    // through the operator, by topology
    select(src, dst);
    D.vertex_groups = [];
    D.weights = [];
    run('object.data_transfer', { data_type: 'VGROUP_WEIGHTS', vert_mapping: 'TOPOLOGY', layers_select_dst: 'NAME' });
    expect(Array.from(D.weights[0]).map((v) => +v.toFixed(2))).toEqual(Array.from(S.weights[0]).map((v) => +v.toFixed(2)));
  });

  it('removes from a collection and isolates collections', () => {
    const ob = cube();
    const col = Object.values(app.doc.collections).find((c) => c.objects.includes(ob.id))!;
    select(ob);
    run('collection.create', { name: 'Extra' });
    const extra = Object.values(app.doc.collections).find((c) => c.name === 'Extra')!;
    run('collection.objects_remove', { collection: col.id });
    expect(col.objects).not.toContain(ob.id);
    expect(extra.objects).toContain(ob.id);
    const idx = Object.values(app.doc.collections[app.doc.scene.collection].children).indexOf(extra.id);
    run('object.hide_collection', { collection_index: idx + 1 });
    expect(extra.hide).toBe(false);
    expect(col.hide).toBe(true);
  });

  it('sets collection instance offsets', () => {
    const ob = cube();
    select(ob);
    app.doc.scene.cursor.location = [1, 2, 3];
    run('object.instance_offset_from_cursor');
    const col = Object.values(app.doc.collections).find((c) => c.objects.includes(ob.id))!;
    expect(col.instance_offset).toEqual([1, 2, 3]);
  });
});

describe('instancing', () => {
  it('lists collection instances with the collection offset and nesting', async () => {
    const { objectDuplis } = await import('../../src/object/instancing');
    const ob = cube();
    select(ob);
    run('collection.create', { name: 'Inst' });
    const col = Object.values(app.doc.collections).find((c) => c.name === 'Inst')!;
    col.instance_offset = [1, 0, 0];
    run('object.collection_instance_add', { collection: col.id, location: [5, 0, 0], rotation: [0, 0, 0] });
    const inst = app.activeObject!;
    app.graph.evaluate(app.doc, false);
    const d = objectDuplis(app.doc, app.graph, inst);
    expect(d.map((x) => x.source)).toEqual([ob.id]);
    expect(near(d[0].matrix.elements.slice(12, 15), [4, 0, 0])).toBe(true);
    // an instance of a collection holding an instance
    run('collection.create', { name: 'Outer' });
    const outer = Object.values(app.doc.collections).find((c) => c.name === 'Outer')!;
    run('object.collection_instance_add', { collection: outer.id, location: [0, 10, 0], rotation: [0, 0, 0] });
    app.graph.evaluate(app.doc, false);
    const nested = objectDuplis(app.doc, app.graph, app.activeObject!);
    expect(nested.length).toBe(1);
    expect(near(nested[0].matrix.elements.slice(12, 15), [4, 10, 0])).toBe(true);
  });

  it('instances children on vertices and faces', async () => {
    const { objectDuplis } = await import('../../src/object/instancing');
    const parent = cube();
    const kid = addCube('Kid Mesh');
    kid.parent = parent.id;
    parent.instance_type = 'VERTS';
    app.graph.evaluate(app.doc, false);
    expect(objectDuplis(app.doc, app.graph, parent).length).toBe(8);
    parent.instance_type = 'FACES';
    expect(objectDuplis(app.doc, app.graph, parent).length).toBe(6);
  });

  it('adds instances to the render scene with the source materials', async () => {
    const { RenderScene } = await import('../../src/render/final/renderscene');
    const ob = cube();
    select(ob);
    run('collection.create', { name: 'Inst' });
    const col = Object.values(app.doc.collections).find((c) => c.name === 'Inst')!;
    run('object.collection_instance_add', { collection: col.id, location: [5, 0, 0], rotation: [0, 0, 0] });
    run('object.collection_instance_add', { collection: col.id, location: [-5, 0, 0], rotation: [0, 0, 0] });
    app.graph.evaluate(app.doc, false);
    const rs = new RenderScene('raster');
    rs.build(app, { mode: 'raster', final: true });
    const counts: number[] = [];
    rs.scene.traverse((o) => {
      const im = o as unknown as { isInstancedMesh?: boolean; count: number };
      if (im.isInstancedMesh) counts.push(im.count);
    });
    expect(counts).toEqual([1, 1]);
  });
});

describe('make instances real', () => {
  it('creates real objects from collection and vertex instances', () => {
    const ob = cube();
    select(ob);
    run('collection.create', { name: 'Inst' });
    const col = Object.values(app.doc.collections).find((c) => c.name === 'Inst')!;
    run('object.collection_instance_add', { collection: col.id, location: [5, 0, 0], rotation: [0, 0, 0] });
    const inst = app.activeObject!;
    const before = Object.keys(app.doc.objects).length;
    select(inst);
    run('object.duplicates_make_real');
    expect(Object.keys(app.doc.objects).length).toBe(before + 1);
    const made = app.activeObject!;
    expect(made.data).toBe(ob.data);
    expect(made.location.map((v) => +v.toFixed(4))).toEqual([5, 0, 0]);
    expect(inst.instance_type).toBe('NONE');
  });
});

describe('vertex parent', () => {
  it('follows one vertex or a triangle of the parent mesh and keeps the child in place', () => {
    const ob = cube();
    const kid = addEmpty('Kid');
    kid.location = [3, 0, 0];
    select(ob, kid);
    app.doc.scene.active_object = ob.id;
    run('object.mode_set', { mode: 'EDIT' });
    const me = meshOf(ob);
    me.select_vert = new Uint8Array(8);
    me.select_vert[0] = 1;
    run('object.vertex_parent_set');
    run('object.mode_set', { mode: 'OBJECT' });
    expect(kid.parent).toBe(ob.id);
    expect(kid.parent_type).toBe('VERTEX');
    const pos = () => Array.from(app.graph.get(kid.id)!.world.elements.slice(12, 15)).map((v) => +v.toFixed(4));
    expect(pos()).toEqual([3, 0, 0]);
    // moving that vertex moves the child
    const P = new Float32Array(me.positions);
    P[2] += 1;
    me.positions = P;
    app.graph.evaluate(app.doc, false);
    expect(pos()).toEqual([3, 0, 1]);
    // moving another vertex does not
    const Q = new Float32Array(me.positions);
    Q[5] += 1;
    me.positions = Q;
    app.graph.evaluate(app.doc, false);
    expect(pos()).toEqual([3, 0, 1]);
  });

  it('refuses two selected vertices', () => {
    const ob = cube();
    const kid = addEmpty('Kid');
    select(ob, kid);
    app.doc.scene.active_object = ob.id;
    run('object.mode_set', { mode: 'EDIT' });
    meshOf(ob).select_vert = Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 0]);
    expect(run('object.vertex_parent_set')).toBe('CANCELLED');
  });
});

describe('vertex weights and global transform', () => {
  it('copies, pastes, normalizes and deletes weights of the reference vertex', () => {
    const ob = cube();
    select(ob);
    run('object.vertex_group_add');
    run('object.vertex_group_add');
    const me = meshOf(ob);
    me.weights[0] = Float32Array.from([0.6, 0, 0, 0, 0, 0, 0, 0]);
    me.weights[1] = Float32Array.from([0.2, 0, 0, 0, 0, 0, 0, 0]);
    run('object.mode_set', { mode: 'EDIT' });
    me.select_vert = Uint8Array.from([1, 1, 1, 0, 0, 0, 0, 0]);
    run('object.vertex_weight_paste', { weight_group: 0 });
    expect(Array.from(me.weights[0].slice(0, 3)).map((v) => +v.toFixed(2))).toEqual([0.6, 0.6, 0.6]);
    run('object.vertex_weight_copy');
    expect(+me.weights[1][2].toFixed(2)).toBe(0.2);
    run('object.vertex_weight_normalize_active_vertex');
    expect(me.weights[0][0] + me.weights[1][0]).toBeCloseTo(1);
    run('object.vertex_weight_delete', { weight_group: 1 });
    expect(me.weights[1][0]).toBe(0);
    run('object.mode_set', { mode: 'OBJECT' });
  });

  it('copies and pastes world transforms', () => {
    const ob = cube();
    ob.location = [1, 2, 3];
    ob.rotation_euler = [0, 0, 1];
    select(ob);
    run('object.copy_global_transform');
    const e = addEmpty('Target');
    const parent = addEmpty('Parent');
    parent.location = [5, 0, 0];
    e.parent = parent.id;
    select(e);
    run('object.paste_transform');
    const w = app.graph.get(e.id)!.world.elements;
    const src = app.graph.get(ob.id)!.world.elements;
    expect(near(w, Array.from(src), 1e-4)).toBe(true);
  });
});

describe('make instance face', () => {
  it('turns objects sharing a mesh into faces instancing one copy', async () => {
    const { objectDuplis } = await import('../../src/object/instancing');
    const a = cube();
    a.location = [1, 0, 0];
    a.scale = [0.5, 0.5, 0.5];
    const b = addCube('B');
    b.data = a.data;
    b.location = [4, 0, 0];
    b.rotation_euler = [0, 0, 0.5];
    b.scale = [0.5, 0.5, 0.5];
    select(a, b);
    run('object.make_dupli_face');
    const inst = app.activeObject!;
    expect(inst.instance_type).toBe('FACES');
    expect(meshOf(inst).offsets.length - 1).toBe(2);
    app.graph.evaluate(app.doc, false);
    const d = objectDuplis(app.doc, app.graph, inst);
    expect(d.length).toBe(2);
    const worlds = [a, b].map((o) => Array.from(app.graph.get(o.id)!.world.elements));
    for (const x of d) expect(worlds.some((w) => near(x.matrix.elements, w, 1e-3))).toBe(true);
  });
});

describe('rigid body mass', () => {
  it('computes mass from the collision shape volume', async () => {
    const { shapeVolume } = await import('../../src/object/rigidmass');
    const { Vector3 } = await import('three');
    const ob = cube();
    app.graph.evaluate(app.doc, false);
    const m = app.graph.get(ob.id)!.mesh!;
    expect(shapeVolume('BOX', m, new Vector3(1, 1, 1))).toBeCloseTo(8);
    expect(shapeVolume('MESH', m, new Vector3(2, 1, 1))).toBeCloseTo(16);
    expect(shapeVolume('SPHERE', m, new Vector3(1, 1, 1))).toBeCloseTo((4 / 3) * Math.PI);
    ob.rigid_body = { type: 'ACTIVE', enabled: true, kinematic: false, mass: 1, friction: 0.5, restitution: 0, collision_shape: 'CONVEX_HULL', collision_margin: 0.04, linear_damping: 0.04, angular_damping: 0.1 };
    select(ob);
    run('rigidbody.mass_calculate', { material: 'WATER' });
    expect(ob.rigid_body.mass).toBeCloseTo(8000);
  });
});

describe('convert to point cloud', () => {
  it('keeps only the vertices', () => {
    const ob = cube();
    select(ob);
    run('object.convert', { target: 'POINTCLOUD' });
    const me = meshOf(ob);
    expect(me.positions.length).toBe(24);
    expect(me.offsets.length).toBe(1);
  });
});

describe('object collections panel ops', () => {
  it('links, removes, unlinks and selects', () => {
    const ob = cube();
    select(ob);
    const col = Object.values(app.doc.collections).find((c) => c.objects.includes(ob.id))!;
    run('object.collection_add');
    const fresh = Object.values(app.doc.collections).find((c) => c.name === 'Collection.001')!;
    expect(fresh.objects).toEqual([ob.id]);
    // removing from the only scene collection is refused
    expect(run('object.collection_remove', { collection: col.id })).toBe('CANCELLED');
    run('collection.create', { name: 'Two' });
    const two = Object.values(app.doc.collections).find((c) => c.name === 'Two')!;
    run('object.collection_remove', { collection: col.id });
    expect(col.objects).not.toContain(ob.id);
    run('object.collection_link', { collection: col.id });
    expect(col.objects).toContain(ob.id);
    run('object.collection_unlink', { collection: two.id });
    expect(Object.values(app.doc.collections).some((c) => c.children.includes(two.id))).toBe(false);
    run('object.select_all', { action: 'DESELECT' });
    run('object.collection_objects_select', { collection: col.id });
    expect(ob.select).toBe(true);
  });
});

describe('shape key pinning', () => {
  it('shows only the active key at full strength', () => {
    const ob = cube();
    select(ob);
    run('object.shape_key_add');
    run('object.shape_key_add');
    run('object.shape_key_add');
    const me = meshOf(ob);
    const d1 = new Float32Array(me.shape_keys[0].data);
    d1[0] += 1;
    const d2 = new Float32Array(me.shape_keys[0].data);
    d2[2] += 1;
    me.shape_keys[1] = { ...me.shape_keys[1], data: d1, value: 0.2 };
    me.shape_keys[2] = { ...me.shape_keys[2], data: d2, value: 0.5 };
    me.active_shape_key_index = 1;
    ob.show_only_shape_key = true;
    app.graph.evaluate(app.doc, false);
    const P = app.graph.get(ob.id)!.mesh!.positions;
    expect(P[0]).toBeCloseTo(me.positions[0] + 1);
    expect(P[2]).toBeCloseTo(me.positions[2]);
    ob.show_only_shape_key = false;
    app.graph.evaluate(app.doc, false);
    const Q = app.graph.get(ob.id)!.mesh!.positions;
    expect(Q[0]).toBeCloseTo(me.positions[0] + 0.2);
  });
});
