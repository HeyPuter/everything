// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument, emptyDocument, newMaterial, newObject, newCollection, newMeshData } from '../../src/data/defaults';
import { cube } from '../../src/mesh/primitives';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { catalogTree, newCatalog, ensureCatalogPath, renameCatalog, moveCatalog, deleteCatalog, mergeCatalogs, catalogAndChildren, cleanName, simpleName } from '../../src/assets/catalogs';
import { importAsset, copyDatablocks, placeCollection, addCollectionInstance, duplicateObjectData, collectionObjects } from '../../src/assets/importer';
import { essentialsDocument } from '../../src/assets/essentials';
import { assetsOf, decodeTargets, encodeTarget, newMetaData, type AssetCatalog, type AssetMetaData } from '../../src/assets/types';
import { copyAssetsInto, purgeLibrary, parseAssetRef, assetRef } from '../../src/assets/library';
import { poseToAction, applyPoseAsset, isPoseAction, poseBones, modifyPose } from '../../src/assets/poselib';
import '../../src/assets/index';
import { bpy } from '../../src/scripting/api';

type Meta = { asset_data?: AssetMetaData };
const named = <T extends { name: string }>(t: Record<string, T>, n: string) => Object.values(t).find((x) => x.name === n)!;

describe('asset catalogs', () => {
  it('creates every level of a path and keeps sibling names unique', () => {
    const cats: AssetCatalog[] = [];
    const id = ensureCatalogPath(cats, 'Materials/Metal');
    expect(cats.map((c) => c.path).sort()).toEqual(['Materials', 'Materials/Metal']);
    expect(cats.find((c) => c.id === id)!.path).toBe('Materials/Metal');
    expect(ensureCatalogPath(cats, 'Materials/Metal')).toBe(id);
    const a = newCatalog(cats, 'Materials');
    const b = newCatalog(cats, 'Materials');
    expect([a.path, b.path]).toEqual(['Materials/Catalog', 'Materials/Catalog.001']);
    expect(newCatalog(cats, '', 'a/b').path).toBe('a-b');
    expect(cleanName(' x/y ')).toBe('x-y');
    expect(simpleName('A/B/C')).toBe('A-B-C');
  });

  it('builds a sorted tree', () => {
    const cats: AssetCatalog[] = [];
    ensureCatalogPath(cats, 'Zeta');
    ensureCatalogPath(cats, 'Alpha/Two');
    ensureCatalogPath(cats, 'Alpha/One');
    const tree = catalogTree(cats);
    expect(tree.map((n) => n.name)).toEqual(['Alpha', 'Zeta']);
    expect(tree[0].children.map((n) => n.path)).toEqual(['Alpha/One', 'Alpha/Two']);
  });

  it('renames, moves and deletes catalogs with their sub-catalogs', () => {
    const cats: AssetCatalog[] = [];
    const leaf = ensureCatalogPath(cats, 'A/B/C');
    const a = cats.find((c) => c.path === 'A')!.id;
    const b = cats.find((c) => c.path === 'A/B')!.id;
    expect(renameCatalog(cats, b, 'Bee')).toBe('A/Bee');
    expect(cats.find((c) => c.id === leaf)!.path).toBe('A/Bee/C');
    const other = ensureCatalogPath(cats, 'Other');
    expect(moveCatalog(cats, b, other)).toBe(true);
    expect(cats.find((c) => c.id === leaf)!.path).toBe('Other/Bee/C');
    // not into its own child
    expect(moveCatalog(cats, b, leaf)).toBe(false);
    expect(moveCatalog(cats, b, '')).toBe(true);
    expect(cats.find((c) => c.id === b)!.path).toBe('Bee');
    expect(catalogAndChildren(cats, b)).toEqual(new Set([b, leaf]));
    const gone = deleteCatalog(cats, b);
    expect(gone).toEqual(new Set([b, leaf]));
    expect(cats.map((c) => c.id).sort()).toEqual([a, other].sort());
  });

  it('merges catalogs by id and by path', () => {
    const into: AssetCatalog[] = [{ id: 'x', path: 'Shared' }];
    const map = mergeCatalogs(into, [
      { id: 'y', path: 'Shared' },
      { id: 'z', path: 'New/Deep' },
    ]);
    expect(map.get('y')).toBe('x');
    expect(map.get('z')).toBe('z');
    expect(into.map((c) => c.path).sort()).toEqual(['New', 'New/Deep', 'Shared']);
  });
});

function libraryWithCube(): { lib: DocumentData; ob: ObjectData } {
  const lib = emptyDocument();
  const ma = newMaterial('Gold');
  lib.materials[ma.id] = ma;
  const me = newMeshData('Box', cube());
  me.materials = [ma.id];
  lib.meshes[me.id] = me;
  const ob = newObject('Box', 'MESH', me.id);
  ob.location = [5, 5, 5];
  lib.objects[ob.id] = ob;
  lib.object_order.push(ob.id);
  lib.collections[lib.scene.collection].objects.push(ob.id);
  (ob as ObjectData & Meta).asset_data = newMetaData();
  (ma as typeof ma & Meta).asset_data = newMetaData();
  return { lib, ob };
}

describe('importing assets', () => {
  it('appends copies every time and reuses data with Append (Reuse Data)', () => {
    const { lib } = libraryWithCube();
    const target = startupDocument();
    const gold = named(lib.materials, 'Gold');
    const a = importAsset(target, lib, 'L', 'materials', gold.id, 'APPEND')!;
    const b = importAsset(target, lib, 'L', 'materials', gold.id, 'APPEND')!;
    expect(a.id).not.toBe(b.id);
    expect(target.materials[b.id].name).toBe('Gold.001');
    const c = importAsset(target, lib, 'L', 'materials', gold.id, 'APPEND_REUSE')!;
    expect(c.created).toBe(false);
    expect([a.id, b.id]).toContain(c.id);
    // appended data is not an asset of the file
    expect((target.materials[a.id] as Meta).asset_data).toBeUndefined();
  });

  it('always adds a new object but can share its data', () => {
    const { lib, ob } = libraryWithCube();
    const target = emptyDocument();
    const a = importAsset(target, lib, 'L', 'objects', ob.id, 'APPEND_REUSE')!;
    const b = importAsset(target, lib, 'L', 'objects', ob.id, 'APPEND_REUSE')!;
    expect(a.id).not.toBe(b.id);
    expect(target.objects[a.id].data).toBe(target.objects[b.id].data);
    expect(Object.keys(target.materials)).toHaveLength(1);
    const c = importAsset(target, lib, 'L', 'objects', ob.id, 'APPEND')!;
    expect(target.objects[c.id].data).not.toBe(target.objects[a.id].data);
    expect(Object.keys(target.materials)).toHaveLength(2);
  });

  it('places a collection so its origin lands on the point, or instances it', () => {
    const lib = emptyDocument();
    const col = newCollection('Set');
    lib.collections[col.id] = col;
    lib.collections[lib.scene.collection].children.push(col.id);
    const parent = newObject('Parent', 'EMPTY', null);
    parent.location = [1, 0, 0];
    const child = newObject('Child', 'EMPTY', null);
    child.parent = parent.id;
    child.location = [0, 1, 0];
    for (const o of [parent, child]) {
      lib.objects[o.id] = o;
      lib.object_order.push(o.id);
      col.objects.push(o.id);
    }
    const target = emptyDocument();
    const res = importAsset(target, lib, 'L', 'collections', col.id, 'APPEND')!;
    expect(res.objects).toEqual([]);
    expect(collectionObjects(target, res.id)).toHaveLength(2);
    placeCollection(target, res.id, target.scene.collection, [10, 0, 0]);
    const p = named(target.objects, 'Parent'),
      c = named(target.objects, 'Child');
    expect(p.location).toEqual([11, 0, 0]);
    // children keep their offset from the parent
    expect(c.location).toEqual([0, 1, 0]);
    expect(target.collections[target.scene.collection].children).toContain(res.id);
    const inst = addCollectionInstance(target, res.id, target.scene.collection, [0, 0, 2])!;
    expect(target.objects[inst].instance_collection).toBe(res.id);
    expect(target.objects[inst].location).toEqual([0, 0, 2]);
  });

  it('copies blocks with a source stamp and without the asset mark of dependencies', () => {
    const { lib, ob } = libraryWithCube();
    const target = emptyDocument();
    const r = copyDatablocks(target, lib, [{ table: 'objects', id: ob.id }], { stamp: 'L' });
    const nob = target.objects[r.map.get(ob.id)!] as ObjectData & Meta & { asset_source?: string };
    expect(nob.asset_data).toBeTruthy();
    expect(nob.asset_source).toBe(`L/${ob.id}`);
    const ma = Object.values(target.materials)[0] as Meta;
    expect(ma.asset_data).toBeUndefined();
  });

  it('duplicates objects of the same file with their own data', () => {
    const doc = startupDocument();
    const cubeOb = named(doc.objects, 'Cube');
    const id = duplicateObjectData(doc, cubeOb.id)!;
    expect(doc.objects[id].name).toBe('Cube.001');
    expect(doc.objects[id].data).not.toBe(cubeOb.data);
    expect(doc.meshes[doc.objects[id].data!].materials).toEqual(doc.meshes[cubeOb.data!].materials);
  });
});

describe('user libraries', () => {
  it('copies assets with their data, catalogs, and replaces same-named assets', () => {
    const src = startupDocument();
    const cubeOb = named(src.objects, 'Cube') as ObjectData & Meta;
    cubeOb.asset_data = newMetaData();
    cubeOb.asset_data.catalog_id = ensureCatalogPath((src.asset_catalogs = []), 'Props/Boxes');
    const mat = named(src.materials, 'Material') as Meta;
    mat.asset_data = newMetaData();
    const lib = emptyDocument();
    lib.asset_catalogs = [];
    expect(copyAssetsInto(lib, src, [{ table: 'objects', id: cubeOb.id }])).toBe(1);
    expect(assetsOf(lib).map((a) => a.block.name)).toEqual(['Cube']);
    // the material came along as plain data
    expect(Object.values(lib.materials).map((m) => m.name)).toEqual(['Material']);
    expect(lib.asset_catalogs.map((c) => c.path).sort()).toEqual(['Props', 'Props/Boxes']);
    const copied = assetsOf(lib)[0].block.asset_data!;
    expect(lib.asset_catalogs.find((c) => c.id === copied.catalog_id)!.path).toBe('Props/Boxes');
    // copying again replaces the old copy instead of adding "Cube.001"
    copyAssetsInto(lib, src, [{ table: 'objects', id: cubeOb.id }]);
    expect(assetsOf(lib).map((a) => a.block.name)).toEqual(['Cube']);
    expect(Object.keys(lib.meshes)).toHaveLength(1);
    expect(lib.collections[lib.scene.collection].objects).toHaveLength(1);
  });

  it('purges data no asset uses', () => {
    const { lib, ob } = libraryWithCube();
    delete (lib.objects[ob.id] as Meta).asset_data;
    purgeLibrary(lib);
    expect(Object.keys(lib.objects)).toHaveLength(0);
    expect(Object.keys(lib.meshes)).toHaveLength(0);
    // the material is still an asset
    expect(Object.keys(lib.materials)).toHaveLength(1);
  });

  it('encodes asset references', () => {
    expect(parseAssetRef(assetRef({ library: 'lib_1', table: 'node_groups', id: 'ng_x' }))).toEqual({ library: 'lib_1', table: 'node_groups', id: 'ng_x' });
    expect(parseAssetRef('bad')).toBeNull();
    expect(decodeTargets([encodeTarget('materials', 'ma_1'), encodeTarget('meshes', 'me_1')].join('|'))).toEqual([{ table: 'materials', id: 'ma_1' }]);
  });
});

describe('Essentials library', () => {
  it('holds original assets of every kind in catalogs, with fixed ids', () => {
    const doc = essentialsDocument();
    const assets = assetsOf(doc);
    const kinds = new Set(assets.map((a) => a.table));
    for (const k of ['materials', 'node_groups', 'worlds', 'objects', 'collections', 'actions', 'brushes']) expect(kinds.has(k as never)).toBe(true);
    expect(assets.length).toBeGreaterThanOrEqual(18);
    const cats = new Set((doc.asset_catalogs ?? []).map((c) => c.id));
    for (const a of assets) {
      expect(cats.has(a.block.asset_data!.catalog_id)).toBe(true);
      expect(a.block.id.startsWith('ess_')).toBe(true);
      expect(a.block.asset_data!.description.length).toBeGreaterThan(10);
    }
    // node groups are wired (every group has its output connected)
    for (const g of Object.values(doc.node_groups)) {
      const out = g.tree.nodes.find((n) => n.type === 'NodeGroupOutput')!;
      expect(g.tree.links.some((l) => l.to_node === out.id)).toBe(true);
    }
    // materials reference only data inside the library
    const target = startupDocument();
    const steel = named(doc.materials, 'Brushed Steel');
    const r = importAsset(target, doc, 'ESSENTIALS', 'materials', steel.id, 'APPEND')!;
    expect(target.materials[r.id].tree.nodes.length).toBe(steel.tree.nodes.length);
    expect(essentialsDocument()).toBe(doc);
  });
});

describe('pose assets', () => {
  it('stores the selected bones and applies them back (with blending)', () => {
    const ob = newObject('Rig', 'ARMATURE', null);
    const pb = () => ({ location: [0, 0, 0], rotation_mode: 'QUATERNION', rotation_quaternion: [1, 0, 0, 0], rotation_euler: [0, 0, 0], rotation_axis_angle: [0, 0, 1, 0], scale: [1, 1, 1], constraints: [] }) as never;
    ob.pose = { Arm: pb(), Leg: pb() };
    ob.pose.Arm.location = [1, 2, 3];
    ob.pose.Arm.select = true;
    const act = poseToAction(ob, 'Wave')!;
    expect(isPoseAction(act)).toBe(true);
    expect(poseBones(act)).toEqual(['Arm']);
    ob.pose.Arm.location = [0, 0, 0];
    ob.pose.Arm.select = false;
    expect(applyPoseAsset(emptyDocument(), ob, act, 0.5)).toBe(1);
    expect(ob.pose.Arm.location).toEqual([0.5, 1, 1.5]);
    applyPoseAsset(emptyDocument(), ob, act, 1);
    expect(ob.pose.Arm.location).toEqual([1, 2, 3]);
    expect(ob.pose.Leg.location).toEqual([0, 0, 0]);
    // add, remove and replace bones of the pose
    ob.pose.Leg.select = true;
    ob.pose.Leg.location = [0, 0, 5];
    expect(modifyPose(act, ob, 'ADD')).toBe(true);
    expect(poseBones(act).sort()).toEqual(['Arm', 'Leg']);
    expect(modifyPose(act, ob, 'REMOVE')).toBe(true);
    expect(poseBones(act)).toEqual(['Arm']);
    ob.pose.Leg.select = false;
    expect(modifyPose(act, ob, 'ADD')).toBe(false);
    expect(modifyPose(act, ob, 'REPLACE')).toBe(true);
    expect(poseBones(act).sort()).toEqual(['Arm', 'Leg']);
  });
});

describe('asset operators', () => {
  beforeEach(() => setApp(new App(startupDocument())));

  it('marks selected objects and clears them with or without a fake user', () => {
    const cubeOb = named(app.doc.objects, 'Cube');
    expect(app.run('asset.mark', {}, { area: null })).toBe('FINISHED');
    expect((app.doc.objects[cubeOb.id] as Meta).asset_data).toBeTruthy();
    const mat = named(app.doc.materials, 'Material');
    app.run('asset.mark', { targets: encodeTarget('materials', mat.id) }, { area: null });
    expect((app.doc.materials[mat.id] as Meta).asset_data).toBeTruthy();
    expect(app.doc.materials[mat.id].use_fake_user).toBe(true);
    app.run('asset.clear', { targets: encodeTarget('materials', mat.id), set_fake_user: true }, { area: null });
    expect((app.doc.materials[mat.id] as Meta).asset_data).toBeUndefined();
    expect(app.doc.materials[mat.id].use_fake_user).toBe(true);
    app.run('asset.mark', { targets: encodeTarget('materials', mat.id) }, { area: null });
    app.run('asset.clear', { targets: encodeTarget('materials', mat.id) }, { area: null });
    expect(app.doc.materials[mat.id].use_fake_user).toBe(false);
  });

  it('adds Essentials assets: objects at a point, materials on objects, worlds, geometry node modifiers', () => {
    const ess = essentialsDocument();
    const ref = (table: string, name: string) => `ESSENTIALS|${table}:${named((ess as unknown as Record<string, Record<string, { name: string }>>)[table], name).id}`;
    expect(app.run('object.add_named', { asset: ref('objects', 'Pedestal'), location: [1, 2, 0] }, { invoke: false, area: null })).toBe('FINISHED');
    const ped = named(app.doc.objects, 'Pedestal');
    expect(ped.location).toEqual([1, 2, 0]);
    expect(app.doc.scene.active_object).toBe(ped.id);
    const cubeOb = named(app.doc.objects, 'Cube');
    app.run('object.drop_named_material', { asset: ref('materials', 'Polished Gold'), object: cubeOb.id }, { invoke: false, area: null });
    expect(app.doc.materials[app.doc.meshes[cubeOb.data!].materials[0]!].name).toBe('Polished Gold');
    // reuse: the same material again is not copied twice
    app.run('object.drop_named_material', { asset: ref('materials', 'Polished Gold'), object: ped.id, import_method: 'APPEND_REUSE' }, { invoke: false, area: null });
    expect(Object.values(app.doc.materials).filter((m) => m.name.startsWith('Polished Gold'))).toHaveLength(1);
    app.run('world.drop_named', { asset: ref('worlds', 'Night Blue') }, { invoke: false, area: null });
    expect(app.doc.worlds[app.doc.scene.world!].name).toBe('Night Blue');
    app.run('object.drop_geometry_nodes', { asset: ref('node_groups', 'Inflate'), object: cubeOb.id }, { invoke: false, area: null });
    const mod = cubeOb.modifiers.find((m) => m.type === 'NODES') as unknown as { node_group: string };
    expect(app.doc.node_groups[mod.node_group].name).toBe('Inflate');
    app.run('object.collection_external_asset_drop', { asset: ref('collections', 'Backdrop Set'), location: [0, 0, 0], use_instance: false }, { invoke: false, area: null });
    expect(Object.values(app.doc.collections).some((c) => c.name === 'Backdrop Set')).toBe(true);
    app.run('anim.action_asset_assign', { asset: ref('actions', 'Turntable'), object: cubeOb.id }, { invoke: false, area: null });
    expect(app.doc.actions[cubeOb.animation_data!.action!].name).toBe('Turntable');
  });

  it('creates pose assets in pose mode', () => {
    app.run('object.armature_add');
    app.run('object.mode_set', { mode: 'POSE' });
    expect(app.run('poselib.create_pose_asset', { pose_name: 'Rest' }, { invoke: false })).toBe('FINISHED');
    const act = named(app.doc.actions, 'Rest') as typeof app.doc.actions[string] & Meta;
    expect(act.asset_data).toBeTruthy();
    expect(isPoseAction(act)).toBe(true);
  });

  it('marks assets from scripts', () => {
    const B = bpy as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const m = B.data.materials['Material'];
    expect(m.asset_data).toBeNull();
    m.asset_mark();
    expect(m.asset_data).toBeTruthy();
    m.asset_data.description = 'Grey';
    expect((named(app.doc.materials, 'Material') as Meta).asset_data!.description).toBe('Grey');
    m.asset_clear();
    expect(m.asset_data).toBeNull();
  });

  it('activates brush assets in their paint mode', async () => {
    await import('../../src/paint/index');
    const { activeTools } = await import('../../src/app/prefs');
    const brush = Object.values(app.doc.brushes).find((b) => b.mode === 'SCULPT')!;
    app.run('asset.mark', { targets: encodeTarget('brushes', brush.id) }, { area: null });
    const ref = `LOCAL|brushes:${brush.id}`;
    expect(app.run('brush.asset_activate', { asset: ref }, { invoke: false, area: null })).toBe('CANCELLED');
    app.run('object.mode_set', { mode: 'SCULPT' });
    expect(app.doc.mode).toBe('SCULPT');
    expect(app.run('brush.asset_activate', { asset: ref }, { invoke: false, area: null })).toBe('FINISHED');
    expect(activeTools.SCULPT).toBe(brush.id);
  });
});
