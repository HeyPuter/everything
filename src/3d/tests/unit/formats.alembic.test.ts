import { describe, it, expect } from 'vitest';
import { readAlembic } from '../../src/io/formats/alembic/read';
import { AlembicArchive } from '../../src/io/formats/alembic/archive';
import { commitScene } from '../../src/io/formats/to-document';
import { Depsgraph } from '../../src/eval/depsgraph';
import { fixture, freshDoc, byName, EXPECTED_BBOX, expectBBox } from '../fixtures/formats/helpers';

describe('Alembic (Ogawa) import', () => {
  it('reads the archive structure: metadata, time samplings, objects and property headers', () => {
    const abc = new AlembicArchive(fixture('ref_scene.abc'));
    expect(abc.metadata.FramesPerTimeUnit).toBe('24.000000');
    expect(abc.timeSamplings[1].timePerCycle).toBeCloseTo(1 / 24, 10);
    expect(abc.top.children.map((c) => c.name).sort()).toEqual(['Cam', 'Cube', 'Ngon', 'Plane', 'Point', 'Rig', 'Spot', 'Sun']);
    const cube = abc.top.children.find((c) => c.name === 'Cube')!;
    expect(cube.metadata.schema).toBe('AbcGeom_Xform_v3');
    expect(cube.children.map((c) => c.metadata.schema).sort()).toEqual(['AbcGeom_PolyMesh_v1', 'AbcGeom_Xform_v3']);
  });

  it('imports meshes (n-gons, UVs, face sets), hierarchy, camera, animated transforms and vertex caches', () => {
    const doc = freshDoc();
    const res = commitScene(doc, readAlembic(fixture('ref_scene.abc')));
    expect(res.objects.map((o) => o.name).sort()).toEqual(['Cam', 'Cube', 'Ngon', 'Plane', 'Point', 'Rig', 'Skinned', 'Sphere', 'Spot', 'Sun']);
    const cube = byName(doc, 'Cube');
    const me = doc.meshes[cube.data!];
    expect(me.offsets.length - 1).toBe(6);
    expect(me.materials.map((m) => doc.materials[m!].name).sort()).toEqual(['Blue', 'Red']);
    expect(byName(doc, 'Sphere').parent).toBe(cube.id);
    expect(doc.meshes[byName(doc, 'Ngon').data!].offsets[1]).toBe(6);
    expect(doc.meshes[byName(doc, 'Sphere').data!].uvs.some((v) => v !== 0)).toBe(true);
    const cam = byName(doc, 'Cam');
    expect(cam.rotation_euler.map((v) => +v.toFixed(3) + 0)).toEqual([1.1, 0, 0.8]);
    expect(doc.cameras[cam.data!].lens).toBeCloseTo(35, 3);
    // vertex caches (skin and shape key results) became per-sample shape keys
    expect(doc.meshes[byName(doc, 'Skinned').data!].shape_keys.length).toBe(25);
    const g = new Depsgraph(doc);
    for (const [name, frames] of Object.entries(EXPECTED_BBOX)) for (const [f, bb] of Object.entries(frames)) expectBBox(doc, name, Number(f), bb, 2e-3, g);
    // expected import result for this file
    expectBBox(
      doc,
      'Sphere',
      12,
      [
        [1.5124, -2.0807, 0.507],
        [2.4876, -1.1148, 1.493],
      ],
      2e-3,
      g,
    );
    expectBBox(
      doc,
      'Ngon',
      1,
      [
        [-1, -3.866, 0],
        [1, -2.134, 0],
      ],
      2e-3,
      g,
    );
  });
});
