import { describe, it, expect } from 'vitest';
import { startupDocument } from '../../src/data/defaults';
import { appendDatablocks, dependencyClosure, dataTables } from '../../src/io/appenddata';

describe('append data-blocks', () => {
  it('lists the data tables of a document', () => {
    const t = dataTables(startupDocument());
    for (const k of ['objects', 'meshes', 'materials', 'collections', 'cameras', 'lights']) expect(t).toContain(k);
    expect(t).not.toContain('scene');
  });

  it('pulls the object data and materials of a picked object', () => {
    const src = startupDocument();
    const cube = Object.values(src.objects).find((o) => o.name === 'Cube')!;
    const deps = dependencyClosure(src, [{ table: 'objects', id: cube.id }]);
    const tables = deps.map((d) => d.table).sort();
    expect(tables).toContain('meshes');
    expect(tables).toContain('materials');
    expect(tables.filter((t) => t === 'objects')).toHaveLength(1);
  });

  it('copies with new ids and unique names and links the object into the scene', () => {
    const target = startupDocument();
    const src = startupDocument();
    const cube = Object.values(src.objects).find((o) => o.name === 'Cube')!;
    const before = Object.keys(target.objects).length;
    const res = appendDatablocks(target, src, [{ table: 'objects', id: cube.id }]);
    expect(Object.keys(target.objects)).toHaveLength(before + 1);
    const ob = target.objects[res.linkedObjects[0]];
    expect(ob.name).toBe('Cube.001');
    expect(ob.id).not.toBe(cube.id);
    // the copy points at the copied mesh, not at the source one
    expect(ob.data).not.toBe(cube.data);
    expect(target.meshes[ob.data!]).toBeTruthy();
    expect(target.object_order).toContain(ob.id);
    expect(target.collections[target.scene.collection].objects.concat(...Object.values(target.collections).map((c) => c.objects))).toContain(ob.id);
  });

  it('links picked collections under the scene collection with their objects', () => {
    const target = startupDocument();
    const src = startupDocument();
    const coll = Object.values(src.collections).find((c) => c.id !== src.scene.collection && c.objects.length)!;
    const res = appendDatablocks(target, src, [{ table: 'collections', id: coll.id }]);
    expect(res.linkedCollections).toHaveLength(1);
    const master = target.collections[target.scene.collection];
    expect(master.children).toContain(res.linkedCollections[0]);
    const copy = target.collections[res.linkedCollections[0]];
    expect(copy.objects).toHaveLength(coll.objects.length);
    expect(res.linkedObjects).toHaveLength(0);
    for (const o of copy.objects) expect(target.object_order).toContain(o);
  });
});
