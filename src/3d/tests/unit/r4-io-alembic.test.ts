// @vitest-environment happy-dom
// Alembic export: archive layout, schemas and a round trip through the importer.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { runJavaScript } from '../../src/scripting/runner';
import { vfsRead, vfsClear } from '../../src/io/vfs';
import { AlembicArchive, findProp } from '../../src/io/formats/alembic/archive';
import { readAlembic } from '../../src/io/formats/alembic/read';
import { encodeArchive, f64, digest } from '../../src/io/formats/alembic/write';
import { commitScene } from '../../src/io/formats/to-document';
import { Depsgraph } from '../../src/eval/depsgraph';
import { emptyDocument } from '../../src/data/defaults';

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
});
beforeEach(() => {
  setApp(new App(startupDocument()));
  vfsClear();
});

const js = (code: string) => {
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error}`);
};

function scene() {
  js(`
    for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
    const sc = bpy.context.scene;
    sc.frame_start = 1; sc.frame_end = 3;
    bpy.ops.mesh.primitive_cube_add({ size: 2, location: [1, 2, 3] });
    const cube = bpy.context.object;
    cube.keyframe_insert('location', { frame: 1 });
    cube.location = [4, 2, 3];
    cube.keyframe_insert('location', { frame: 3 });
    bpy.ops.mesh.primitive_plane_add({ location: [0, 0, -2] });
    bpy.ops.object.camera_add({ location: [0, -10, 0], rotation: [Math.PI / 2, 0, 0] });
    bpy.context.object.data.lens = 50;
    bpy.context.object.name = 'Cam';
  `);
}

describe('Alembic writer', () => {
  it('encodes property headers the reader understands (constant, changing and inline metadata)', () => {
    const long = `k=${'x'.repeat(300)}`;
    const bytes = encodeArchive(
      [
        {
          name: 'A',
          metadata: 'schema=AbcGeom_Xform_v3',
          props: [
            { kind: 'scalar', name: 'c', pod: 'float64', extent: 2, timeSampling: 1, samples: [f64([1, 2]), f64([1, 2]), f64([1, 2])] },
            { kind: 'scalar', name: 'v', pod: 'float64', extent: 1, timeSampling: 1, samples: [f64([1]), f64([1]), f64([5])] },
            { kind: 'scalar', name: 'long', pod: 'float64', extent: 1, metadata: long, timeSampling: 0, samples: [f64([7])] },
          ],
          children: [],
        },
      ],
      { metadata: { FramesPerTimeUnit: '24' }, samplings: [{ timePerCycle: 1 / 24, times: [1 / 24], maxSamples: 3 }] },
    );
    const abc = new AlembicArchive(bytes);
    const a = abc.top.children[0];
    const c = findProp(a.properties, 'c')!;
    const v = findProp(a.properties, 'v')!;
    expect(c.numSamples).toBe(3);
    expect(abc.isConstant(c)).toBe(true);
    expect(abc.sample(c, 2)).toEqual([1, 2]);
    expect(v.firstChanged).toBe(2);
    expect([0, 1, 2].map((i) => abc.sample(v, i)![0])).toEqual([1, 1, 5]);
    expect(abc.sampleTime(1, 2)).toBeCloseTo(3 / 24, 10);
    expect(findProp(a.properties, 'long')!.metadata.k.length).toBe(300);
    expect(digest(new Uint8Array([1])).length).toBe(16);
  });

  it('exports transforms, meshes, cameras and animation that import back', () => {
    scene();
    js(`bpy.ops.wm.alembic_export({ filepath: '/tmp/t.abc' })`);
    const bytes = vfsRead('/tmp/t.abc')!;
    if (process.env.ABC_OUT) writeFileSync(process.env.ABC_OUT, bytes);
    const abc = new AlembicArchive(bytes);
    expect(abc.metadata.FramesPerTimeUnit).toBe('24.000000');
    const names = abc.top.children.map((c) => c.name).sort();
    expect(names).toEqual(['Cam', 'Cube', 'Plane']);
    const cube = abc.top.children.find((c) => c.name === 'Cube')!;
    expect(cube.children[0].metadata.schema).toBe('AbcGeom_PolyMesh_v1');
    const vals = findProp(findProp(cube.properties, '.xform'), '.vals')!;
    expect(vals.numSamples).toBe(3);
    // Y up: (x, y, z) → (x, z, -y)
    expect(abc.sample(vals, 0)!.slice(12, 15)).toEqual([1, 3, -2]);
    expect(abc.sample(vals, 2)!.slice(12, 15)).toEqual([4, 3, -2]);
    const cam = abc.top.children.find((c) => c.name === 'Cam')!;
    const camVals = abc.sample(findProp(findProp(cam.properties, '.xform'), '.vals')!, 0)!;
    // looking down -Z already: the rotation part is the identity
    expect(camVals.slice(0, 11).map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const core = abc.sample(findProp(findProp(cam.children[0].properties, '.geom'), '.core')!, 0)!;
    expect(core[0]).toBe(50);
    expect(core[1]).toBeCloseTo(3.6, 6);

    const doc = emptyDocument();
    const res = commitScene(doc, readAlembic(bytes));
    expect(res.objects.map((o) => o.name).sort()).toEqual(['Cam', 'Cube', 'Plane']);
    const g = new Depsgraph(doc);
    const at = (name: string, f: number) => {
      doc.scene.frame_current = f;
      g.evaluate(doc);
      const ob = Object.values(doc.objects).find((o) => o.name === name)!;
      return [...g.get(ob.id)!.world.elements].slice(12, 15).map((x) => Math.round(x * 1e4) / 1e4 + 0);
    };
    expect(at('Cube', 1)).toEqual([1, 2, 3]);
    expect(at('Cube', 3)).toEqual([4, 2, 3]);
    expect(at('Plane', 2)).toEqual([0, 0, -2]);
    const camOb = Object.values(doc.objects).find((o) => o.name === 'Cam')!;
    expect(camOb.rotation_euler.map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([1.571, 0, 0]);
    expect(doc.cameras[camOb.data!].lens).toBeCloseTo(50, 4);
    const cubeMesh = doc.meshes[Object.values(doc.objects).find((o) => o.name === 'Cube')!.data!];
    expect(cubeMesh.positions.length / 3).toBe(8);
    expect(cubeMesh.offsets.length - 1).toBe(6);
  });

  it('writes deforming meshes per frame and face sets per material', () => {
    js(`
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      const sc = bpy.context.scene; sc.frame_start = 1; sc.frame_end = 2;
      bpy.ops.mesh.primitive_plane_add();
      const ob = bpy.context.object;
      const red = bpy.data.materials.new('Red');
      ob.data.materials.append(red);
      ob.shape_key_add({ name: 'Basis' });
      const k = ob.shape_key_add({ name: 'Up' });
      k.data[0].co = [k.data[0].co[0], k.data[0].co[1], 1];
      k.value = 0; k.keyframe_insert('value', { frame: 1 });
      k.value = 1; k.keyframe_insert('value', { frame: 2 });
      bpy.ops.wm.alembic_export({ filepath: '/tmp/d.abc', face_sets: true });
    `);
    if (process.env.ABC_OUT) writeFileSync(process.env.ABC_OUT.replace(/\.abc$/, '_deform.abc'), vfsRead('/tmp/d.abc')!);
    const abc = new AlembicArchive(vfsRead('/tmp/d.abc')!);
    const shape = abc.top.children[0].children[0];
    const P = findProp(findProp(shape.properties, '.geom'), 'P')!;
    expect(P.numSamples).toBe(2);
    expect(abc.isConstant(P)).toBe(false);
    expect(shape.children.map((c) => c.name)).toEqual(['Red']);
    const doc = emptyDocument();
    commitScene(doc, readAlembic(vfsRead('/tmp/d.abc')!));
    const me = Object.values(doc.meshes)[0];
    expect(me.shape_keys.length).toBeGreaterThan(1);
    expect(me.materials.map((m) => doc.materials[m!].name)).toEqual(['Red']);
  });
});
