import { describe, it, expect } from 'vitest';
import { startupDocument, newCollection, newObject } from '../../src/data/defaults';
import type { DocumentData, ObjectData } from '../../src/data/types';
import type { LibraryData } from '../../src/library/types';
import {
  linkFromDoc,
  reloadFromDoc,
  makeLocal,
  makeOverride,
  resetOverrides,
  clearOverrides,
  overriddenKeys,
  deleteLibrary,
  lockLinked,
  linkedRecords,
  makeLocalTargets,
  resetOverrideProperty,
  closureOf,
  dropUnusedLibraries,
} from '../../src/library/core';
import { isReadOnly, withLinkedWrites } from '../../src/library/readonly';
import { cloneShared } from '../../src/data/cow';

const lib = (id = 'li_a'): LibraryData => ({ id, name: 'props.p3d', filepath: 'Recent/props.p3d', source: { kind: 'recent', key: 'k1' }, format: 'p3d' });
const cubeOf = (d: DocumentData) => Object.values(d.objects).find((o) => o.name === 'Cube')!;

/** A library file with a collection "Rig" holding a parent empty and a cube child. */
function rigLibrary(): DocumentData {
  const src = startupDocument();
  const col = newCollection('Rig');
  const root = newObject('Root', 'EMPTY', null);
  const cube = cubeOf(src);
  cube.parent = root.id;
  src.objects[root.id] = root;
  src.object_order.push(root.id);
  col.objects.push(root.id, cube.id);
  src.collections[col.id] = col;
  src.collections[src.scene.collection].children.push(col.id);
  for (const c of Object.values(src.collections)) if (c.id !== col.id) c.objects = c.objects.filter((o) => o !== cube.id);
  return src;
}
const rigCol = (d: DocumentData) => Object.values(d.collections).find((c) => c.name === 'Rig')!;

describe('linking', () => {
  it('links an object with its data and materials, read-only after locking', () => {
    const target = startupDocument();
    const src = startupDocument();
    const cube = cubeOf(src);
    const res = linkFromDoc(target, src, lib(), [{ table: 'objects', id: cube.id }]);
    const lid = res.picked[0].id;
    const ob = target.objects[lid] as ObjectData & { library?: string };
    expect(ob.library).toBe('li_a');
    expect(ob.name).toBe('Cube');
    expect(target.meshes[ob.data!]).toBeTruthy();
    expect((target.meshes[ob.data!] as unknown as { library: string }).library).toBe('li_a');
    expect(target.collections[target.scene.collection].objects).toContain(lid);
    expect(target.object_order).toContain(lid);
    lockLinked(target);
    expect(isReadOnly(ob)).toBe(true);
    expect(() => {
      ob.location = [5, 0, 0];
    }).toThrow();
    expect(() => ob.modifiers.push({} as never)).toThrow();
    // evaluation (animation, drivers) may still write current values
    withLinkedWrites(() => (ob.location = [1, 2, 3]));
    expect(ob.location).toEqual([1, 2, 3]);
    expect(() => {
      ob.name = 'x';
    }).toThrow();
    // view-layer state stays writable
    ob.select = true;
    ob.hide = true;
    expect(ob.select && ob.hide).toBe(true);
  });

  it('reuses data-blocks that are already linked', () => {
    const target = startupDocument();
    const src = startupDocument();
    const cube = cubeOf(src);
    linkFromDoc(target, src, lib(), [{ table: 'objects', id: cube.id }]);
    const n = linkedRecords(target).length;
    const res = linkFromDoc(target, src, lib(), [{ table: 'meshes', id: cube.data! }]);
    expect(linkedRecords(target).length).toBe(n);
    expect(Object.keys(res.added)).toHaveLength(0);
  });

  it('instances linked collections and object data when asked', () => {
    const target = startupDocument();
    const src = rigLibrary();
    const res = linkFromDoc(target, src, lib(), [{ table: 'collections', id: rigCol(src).id }], { instance_collections: true, location: [1, 2, 3] });
    const empty = target.objects[res.placed[0]];
    expect(empty.type).toBe('EMPTY');
    expect(empty.instance_type).toBe('COLLECTION');
    expect(empty.instance_collection).toBe(res.picked[0].id);
    expect(empty.location).toEqual([1, 2, 3]);
    expect(target.collections[target.scene.collection].children).not.toContain(res.picked[0].id);
    const res2 = linkFromDoc(target, src, lib(), [{ table: 'meshes', id: cubeOf(src).data! }], { instance_object_data: true });
    expect(target.objects[res2.placed[0]].type).toBe('MESH');
    expect(target.objects[res2.placed[0]].data).toBe(res2.picked[0].id);
  });

  it('links collections into the scene with their objects', () => {
    const target = startupDocument();
    const src = rigLibrary();
    const res = linkFromDoc(target, src, lib(), [{ table: 'collections', id: rigCol(src).id }]);
    const col = target.collections[res.picked[0].id];
    expect(target.collections[target.scene.collection].children).toContain(col.id);
    expect(col.objects).toHaveLength(2);
    const cube = target.objects[col.objects.find((o) => target.objects[o].name === 'Cube')!];
    expect(target.objects[cube.parent!].name).toBe('Root');
  });

  it('does not pull in the source scene collection', () => {
    const src = rigLibrary();
    const deps = closureOf(src, [{ table: 'collections', id: rigCol(src).id }]);
    expect(deps.some((d) => d.id === src.scene.collection)).toBe(false);
  });
});

describe('reloading', () => {
  it('refreshes linked data with the new library content, keeping ids and selection', () => {
    const target = startupDocument();
    const src = startupDocument();
    const cube = cubeOf(src);
    const res = linkFromDoc(target, src, lib(), [{ table: 'objects', id: cube.id }]);
    const lid = res.picked[0].id;
    lockLinked(target);
    target.objects[lid].select = true;
    const v2 = cloneShared(src);
    cubeOf(v2).location = [4, 5, 6];
    const r = reloadFromDoc(target, 'li_a', v2);
    expect(r.updated).toBeGreaterThan(0);
    expect(r.missing).toHaveLength(0);
    expect(target.objects[lid].location).toEqual([4, 5, 6]);
    expect(target.objects[lid].select).toBe(true);
  });

  it('keeps data the library lost and reports it missing', () => {
    const target = startupDocument();
    const src = startupDocument();
    const res = linkFromDoc(target, src, lib(), [{ table: 'objects', id: cubeOf(src).id }]);
    const v2 = cloneShared(src);
    delete v2.objects[cubeOf(src).id];
    const r = reloadFromDoc(target, 'li_a', v2);
    expect(r.missing).toContain('Cube');
    expect(target.objects[res.picked[0].id]).toBeTruthy();
  });

  it('links data-blocks the library added to linked collections', () => {
    const target = startupDocument();
    const src = rigLibrary();
    const res = linkFromDoc(target, src, lib(), [{ table: 'collections', id: rigCol(src).id }]);
    const v2 = cloneShared(src);
    const extra = newObject('Extra', 'EMPTY', null);
    v2.objects[extra.id] = extra;
    rigCol(v2).objects.push(extra.id);
    const r = reloadFromDoc(target, 'li_a', v2);
    expect(r.added).toBe(1);
    expect(target.collections[res.picked[0].id].objects.map((o) => target.objects[o].name)).toContain('Extra');
  });
});

describe('make local', () => {
  it('makes an object local while its data stays linked', () => {
    const target = startupDocument();
    const src = startupDocument();
    const res = linkFromDoc(target, src, lib(), [{ table: 'objects', id: cubeOf(src).id }]);
    lockLinked(target);
    const lid = res.picked[0].id;
    const linkedMesh = target.objects[lid].data!;
    const map = makeLocal(target, makeLocalTargets(target, [lid], false, false));
    const nid = map.get(lid)!;
    const ob = target.objects[nid] as ObjectData & { library?: string };
    expect(ob.library).toBeUndefined();
    expect(ob.data).toBe(linkedMesh);
    expect(target.objects[lid]).toBeUndefined();
    expect(target.collections[target.scene.collection].objects).toContain(nid);
    expect(target.object_order).toContain(nid);
    ob.location[0] = 3;
    expect(ob.location[0]).toBe(3);
  });

  it('makes object, data and materials local and drops the unused library', () => {
    const target = startupDocument();
    const src = startupDocument();
    const res = linkFromDoc(target, src, lib(), [{ table: 'objects', id: cubeOf(src).id }]);
    const lid = res.picked[0].id;
    const map = makeLocal(target, makeLocalTargets(target, [lid], true, true));
    const ob = target.objects[map.get(lid)!];
    const me = target.meshes[ob.data!] as unknown as { library?: string; materials: string[] };
    expect(me.library).toBeUndefined();
    expect((target.materials[me.materials[0]] as unknown as { library?: string }).library).toBeUndefined();
    expect(linkedRecords(target)).toHaveLength(0);
    expect(dropUnusedLibraries(target)).toBe(0);
    expect(Object.keys(target.libraries ?? {})).toHaveLength(0);
  });
});

describe('library overrides', () => {
  function overridden() {
    const target = startupDocument();
    const src = rigLibrary();
    const res = linkFromDoc(target, src, lib(), [{ table: 'collections', id: rigCol(src).id }], { instance_collections: true });
    lockLinked(target);
    const empty = res.placed[0];
    const root = makeOverride(target, 'collections', res.picked[0].id, { instancer: empty })!;
    return { target, src, root, linkedCol: res.picked[0].id, empty };
  }

  it('replaces the instancer with an editable override hierarchy', () => {
    const { target, root, linkedCol, empty } = overridden();
    expect(target.objects[empty]).toBeUndefined();
    const col = target.collections[root] as unknown as { override_library: { reference: string }; objects: string[] };
    expect(col.override_library.reference).toBe(linkedCol);
    expect(target.collections[target.scene.collection].children).toContain(root);
    const obs = col.objects.map((o) => target.objects[o]);
    expect(obs).toHaveLength(2);
    const cube = obs.find((o) => o.name === 'Cube')!;
    // the override cube is parented to the override root, its mesh stays linked
    expect(target.objects[cube.parent!].name).toBe('Root');
    expect((target.objects[cube.parent!] as unknown as { override_library?: object }).override_library).toBeTruthy();
    expect((target.meshes[cube.data!] as unknown as { library?: string }).library).toBe('li_a');
    cube.location = [9, 9, 9];
    expect(overriddenKeys(target, 'objects', cube.id)).toEqual(['location']);
  });

  it('keeps override changes through a reload and resets them on request', () => {
    const { target, src, root } = overridden();
    const col = target.collections[root];
    const cubeId = col.objects.find((o) => target.objects[o].name === 'Cube')!;
    target.objects[cubeId].location = [9, 9, 9];
    const v2 = cloneShared(src);
    cubeOf(v2).scale = [2, 2, 2];
    reloadFromDoc(target, 'li_a', v2);
    expect(target.objects[cubeId].location).toEqual([9, 9, 9]);
    expect(target.objects[cubeId].scale).toEqual([2, 2, 2]);
    expect(resetOverrideProperty(target, cubeId, 'location')).toBe(true);
    expect(target.objects[cubeId].location).toEqual(cubeOf(v2).location);
    target.objects[cubeId].rotation_euler = [1, 0, 0];
    resetOverrides(target, [cubeId]);
    expect(target.objects[cubeId].rotation_euler).toEqual(cubeOf(v2).rotation_euler);
  });

  it('clears a hierarchy back to the linked collection', () => {
    const { target, root, linkedCol } = overridden();
    expect(clearOverrides(target, [root])).toBe(3);
    expect(target.collections[root]).toBeUndefined();
    expect(target.collections[target.scene.collection].children).toContain(linkedCol);
  });
});

describe('deleting a library', () => {
  it('removes linked data and local objects using it', () => {
    const target = startupDocument();
    const src = startupDocument();
    const res = linkFromDoc(target, src, lib(), [{ table: 'meshes', id: cubeOf(src).data! }], { instance_object_data: true });
    lockLinked(target);
    const placed = res.placed[0];
    expect(deleteLibrary(target, 'li_a')).toBeGreaterThan(0);
    expect(target.objects[placed]).toBeUndefined();
    expect(linkedRecords(target)).toHaveLength(0);
    expect(target.libraries?.li_a).toBeUndefined();
    expect(target.object_order).not.toContain(placed);
  });
});
