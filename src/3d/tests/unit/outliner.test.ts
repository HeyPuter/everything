// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp } from '../../src/app/app';
import { startupDocument, newObject, newMaterial } from '../../src/data/defaults';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { buildRows, defaultFilter, allElements, userCounts, collectionsInOrder, nameMatches, type TreeState } from '../../src/editors/outliner/tree';
import * as C from '../../src/editors/outliner/collections';
import { idOperation } from '../../src/editors/outliner/ops';

let doc: DocumentData;
let cube: ObjectData, camera: ObjectData, light: ObjectData;
let col: string;

function st(over: Partial<TreeState> = {}): TreeState {
  return {
    mode: 'VIEW_LAYER',
    filter: defaultFilter(),
    search: '',
    open: new Map(),
    ...over,
  };
}
const labels = (s: TreeState) => buildRows(doc, s).map((r) => r.label);

beforeEach(() => {
  doc = startupDocument();
  setApp(new App(doc));
  const obs = Object.values(doc.objects);
  cube = obs.find((o) => o.type === 'MESH')!;
  camera = obs.find((o) => o.type === 'CAMERA')!;
  light = obs.find((o) => o.type === 'LIGHT')!;
  col = doc.collections[doc.scene.collection].children[0];
});

describe('outliner tree', () => {
  it('lists collections and objects (sorted) in the view layer', () => {
    expect(labels(st())).toEqual(['Scene Collection', 'Collection', 'Camera', 'Cube', 'Light']);
    const rows = buildRows(doc, st());
    expect(rows[2].depth).toBe(2);
    expect(rows.find((r) => r.label === 'Cube')!.parentCollection).toBe(col);
  });

  it('keeps collection order when alphabetical sorting is off', () => {
    const f = { ...defaultFilter(), use_sort_alpha: false };
    doc.collections[col].objects = [light.id, cube.id, camera.id];
    expect(labels(st({ filter: f })).slice(2)).toEqual(['Light', 'Cube', 'Camera']);
  });

  it('nests children under their parent and lists them flat without the children filter', () => {
    cube.parent = camera.id;
    expect(labels(st())).toEqual(['Scene Collection', 'Collection', 'Camera', 'Light']);
    const open = new Map([[`o:${camera.id}`, true]]);
    const rows = buildRows(doc, st({ open }));
    const c = rows.find((r) => r.label === 'Cube')!;
    expect(c.depth).toBe(rows.find((r) => r.label === 'Camera' && r.kind === 'object')!.depth + 1);
    const flat = { ...defaultFilter(), use_filter_children: false };
    expect(labels(st({ filter: flat }))).toEqual(['Scene Collection', 'Collection', 'Camera', 'Cube', 'Light']);
  });

  it('shows object contents when expanded', () => {
    const rows = buildRows(
      doc,
      st({
        open: new Map([
          [`o:${cube.id}`, true],
          [`d:${cube.id}`, true],
        ]),
      }),
    );
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('data');
    expect(kinds).toContain('material');
    const noContent = { ...defaultFilter(), use_filter_object_content: false };
    expect(buildRows(doc, st({ filter: noContent, open: new Map([[`o:${cube.id}`, true]]) })).some((r) => r.kind === 'data')).toBe(false);
  });

  it('summarises collapsed children as icon chips with counts', () => {
    const rows = buildRows(doc, st({ open: new Map([[`c:${col}`, false]]) }));
    const c = rows.find((r) => r.ekey === `c:${col}`)!;
    expect(c.expanded).toBe(false);
    expect(c.chips!.reduce((n, x) => n + x.count, 0)).toBe(3);
  });

  it('search keeps matching rows with their parents and supports exact / case / wildcard matching', () => {
    // the object and its mesh data both match
    expect(labels(st({ search: 'cub' }))).toEqual(['Scene Collection', 'Collection', 'Cube', 'Cube']);
    const rows = buildRows(doc, st({ search: 'cub' }));
    expect(rows.find((r) => r.label === 'Cube')!.match).toBe(true);
    expect(
      labels(
        st({
          search: 'cub',
          filter: { ...defaultFilter(), use_filter_complete: true },
        }),
      ),
    ).toEqual([]);
    expect(
      labels(
        st({
          search: 'cub',
          filter: { ...defaultFilter(), use_filter_case_sensitive: true },
        }),
      ),
    ).toEqual([]);
    expect(nameMatches('Cube.001', 'C*1', defaultFilter())).toBe(true);
    // a collapsed object still reveals matching contents
    expect(labels(st({ search: 'Material' }))).toContain('Material');
  });

  it('filters object types and states', () => {
    expect(labels(st({ filter: { ...defaultFilter(), use_filter_object_mesh: false } }))).not.toContain('Cube');
    for (const o of Object.values(doc.objects)) o.select = o === light;
    expect(labels(st({ filter: { ...defaultFilter(), filter_state: 'SELECTED' } })).slice(2)).toEqual(['Light']);
    expect(
      labels(
        st({
          filter: {
            ...defaultFilter(),
            filter_state: 'SELECTED',
            filter_invert: true,
          },
        }),
      ).slice(2),
    ).toEqual(['Camera', 'Cube']);
    expect(labels(st({ filter: { ...defaultFilter(), use_filter_collection: false } }))).toEqual(['Camera', 'Cube', 'Light']);
    expect(labels(st({ filter: { ...defaultFilter(), use_filter_object: false } }))).toEqual(['Scene Collection', 'Collection']);
  });

  it('lists data-blocks by type and unused data', () => {
    const rows = buildRows(doc, st({ mode: 'BLENDER_FILE', open: new Map([['g:materials', true]]) }));
    expect(rows[0].label).toBe('Current File');
    expect(rows.some((r) => r.label === 'Materials')).toBe(true);
    expect(rows.some((r) => r.kind === 'id' && r.label === 'Material')).toBe(true);
    expect(rows.some((r) => r.label === 'Scene Collection')).toBe(false);
    expect(buildRows(doc, st({ mode: 'ORPHAN_DATA' }))).toEqual([]);
    const m = newMaterial('Spare');
    doc.materials[m.id] = m;
    const orphans = buildRows(doc, st({ mode: 'ORPHAN_DATA' }));
    expect(orphans.map((r) => r.label)).toEqual(['Materials', 'Spare']);
    expect(orphans[1].users).toBe(0);
    expect(userCounts(doc).get(doc.materials[Object.keys(doc.materials)[0]].id)).toBeGreaterThan(0);
  });

  it('enumerates every element for one-level expansion', () => {
    const els = allElements(doc, st());
    expect(els[0]).toMatchObject({ kind: 'collection', depth: 0, open: true });
    expect(els.find((e) => e.ekey === `o:${cube.id}`)).toMatchObject({
      depth: 2,
      open: false,
      hasKids: true,
    });
  });
});

describe('outliner collections', () => {
  it('adds, duplicates (with and without shared data) and deletes collections', () => {
    const nid = C.addCollection(doc, col);
    expect(doc.collections[col].children).toContain(nid);
    const dup = C.duplicateCollection(doc, col, false)!;
    const d = doc.collections[dup];
    expect(d.name).toBe('Collection.002');
    expect(d.objects).toHaveLength(3);
    expect(d.children).toHaveLength(1);
    const cubeCopy = d.objects.map((id) => doc.objects[id]).find((o) => o.type === 'MESH')!;
    expect(cubeCopy.id).not.toBe(cube.id);
    expect(cubeCopy.data).not.toBe(cube.data);
    // originals are not linked into the copy and copies are not in the source
    expect(doc.collections[col].objects).not.toContain(cubeCopy.id);
    const linked = C.duplicateCollection(doc, col, true)!;
    const cubeLinked = doc.collections[linked].objects.map((id) => doc.objects[id]).find((o) => o.type === 'MESH')!;
    expect(cubeLinked.data).toBe(cube.data);
    // keeps parenting inside the copy
    cube.parent = camera.id;
    const withParent = C.duplicateCollection(doc, col, true)!;
    const obs = doc.collections[withParent].objects.map((id) => doc.objects[id]);
    expect(obs.find((o) => o.type === 'MESH')!.parent).toBe(obs.find((o) => o.type === 'CAMERA')!.id);

    const before = Object.keys(doc.objects).length;
    expect(C.deleteCollections(doc, [dup], true)).toBe(1);
    expect(Object.keys(doc.objects).length).toBe(before - 3);
    expect(doc.collections[dup]).toBeUndefined();
    // deleting without hierarchy moves contents to the parent
    C.deleteCollections(doc, [col], false);
    const master = doc.collections[doc.scene.collection];
    expect(master.objects).toContain(cube.id);
    expect(master.children).toContain(nid);
  });

  it('moves collections into / before / after others without cycles', () => {
    const a = C.addCollection(doc, doc.scene.collection, 'A');
    const b = C.addCollection(doc, a, 'B');
    expect(C.moveCollection(doc, a, b, 'INTO')).toBe(false);
    expect(C.moveCollection(doc, b, col, 'BEFORE')).toBe(true);
    expect(doc.collections[doc.scene.collection].children).toEqual([b, col, a]);
    expect(C.moveCollection(doc, b, a, 'INTO')).toBe(true);
    expect(doc.collections[a].children).toEqual([b]);
  });

  it('isolates, shows and hides inside, and toggles numbered collections', () => {
    const a = C.addCollection(doc, doc.scene.collection, 'A');
    const b = C.addCollection(doc, a, 'B');
    C.isolateCollection(doc, b);
    expect(doc.collections[col].hide).toBe(true);
    expect(doc.collections[a].hide).toBe(false);
    expect(doc.collections[b].hide).toBe(false);
    C.setInsideHidden(doc, col, true);
    expect(cube.hide).toBe(true);
    C.setInsideHidden(doc, col, false);
    expect(cube.hide).toBe(false);
    expect(collectionsInOrder(doc).map((c) => c.name)).toEqual(['Collection', 'A', 'B']);
    expect(C.hideCollectionByIndex(doc, 1, false)).toBe(true);
    expect(doc.collections[col].hide).toBe(false);
    expect(doc.collections[a].hide).toBe(true);
    C.hideCollectionByIndex(doc, 3, true);
    expect(doc.collections[b].hide).toBe(false);
    expect(doc.collections[a].hide).toBe(false);
    expect(C.hideCollectionByIndex(doc, 9, false)).toBe(false);
  });

  it('moves and links objects between collections', () => {
    const a = C.addCollection(doc, doc.scene.collection, 'A');
    C.moveObjectsToCollection(doc, [cube.id], a, true);
    expect(doc.collections[col].objects).toContain(cube.id);
    expect(doc.collections[a].objects).toContain(cube.id);
    C.moveObjectsToCollection(doc, [cube.id], a, false);
    expect(doc.collections[col].objects).not.toContain(cube.id);
  });
});

describe('outliner ID data operations', () => {
  it('unlinks, makes single user, fakes users and selects linked objects', () => {
    const mat = doc.materials[Object.keys(doc.materials)[0]];
    const me = doc.meshes[cube.data!];
    const twin = newObject('Twin', 'MESH', cube.data);
    doc.objects[twin.id] = twin;
    doc.object_order.push(twin.id);
    doc.collections[col].objects.push(twin.id);
    // make single user gives the cube its own mesh
    expect(idOperation(doc, 'SINGLE', [`meshes:${me.id}:${cube.id}`])).toBe(1);
    expect(cube.data).not.toBe(me.id);
    expect(twin.data).toBe(me.id);
    // select linked selects objects using the mesh
    for (const o of Object.values(doc.objects)) o.select = false;
    idOperation(doc, 'SELECT_LINKED', [`meshes:${me.id}:`]);
    expect(twin.select).toBe(true);
    expect(cube.select).toBe(false);
    idOperation(doc, 'ADD_FAKE', [`materials:${mat.id}:`]);
    expect(mat.use_fake_user).toBe(true);
    // unlinking the material from the cube's mesh clears the slot
    const cm = doc.meshes[cube.data!];
    cm.materials = [mat.id];
    idOperation(doc, 'UNLINK', [`materials:${mat.id}:${cube.id}`]);
    expect(cm.materials).toEqual([null]);
    // unlinking an object from its collection
    idOperation(doc, 'UNLINK', [`objects:${light.id}:${col}`]);
    expect(doc.collections[col].objects).not.toContain(light.id);
    expect(idOperation(doc, 'DELETE', [`materials:${mat.id}:`])).toBe(1);
    expect(doc.materials[mat.id]).toBeUndefined();
  });
});
