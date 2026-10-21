// @vitest-environment happy-dom
// Per-format import / export operators run from scripts: they write and read the session file
// store by path, synchronously, under their scripting names and property names.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app, operators } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { runJavaScript } from '../../src/scripting/runner';
import { vfsRead, vfsWrite, vfsClear, normPath, vfsCompanion, vfsFind } from '../../src/io/vfs';
import { importPaths, propsToOptions, isTempPath } from '../../src/io/formats/formatops';
import { pythonAvailable, runPy } from './support/python';

let has = false;
beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  has = await pythonAvailable();
}, 120000);

beforeEach(() => {
  setApp(new App(startupDocument()));
  vfsClear();
});

const js = (code: string) => {
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error}`);
  return r;
};
const meshObjects = () => Object.values(app.doc.objects).filter((o) => o.type === 'MESH');

describe('session file store', () => {
  it('normalises paths', () => {
    expect(normPath('//a/b.obj')).toBe('/project/a/b.obj');
    expect(normPath('C:\\tmp\\x.obj')).toBe('/c/tmp/x.obj');
    expect(normPath('/tmp/../tmp/./y.stl')).toBe('/tmp/y.stl');
    expect(normPath('rel.ply')).toBe('/project/rel.ply');
    expect(isTempPath('/tmp/a.obj')).toBe(true);
    expect(isTempPath('//a.obj')).toBe(false);
  });
  it('finds companions next to a file, else by name', () => {
    vfsWrite('/x/a.mtl', 'one');
    vfsWrite('/y/a.mtl', 'two');
    expect(new TextDecoder().decode(vfsCompanion('/x/m.obj', 'a.mtl')!)).toBe('one');
    expect(new TextDecoder().decode(vfsCompanion('/z/m.obj', 'a.mtl')!)).toBe('two'); // newest
    expect(vfsFind('A.MTL')?.path).toBe('/y/a.mtl');
  });
  it('reads files + directory like the file browser passes them', () => {
    expect(importPaths({ directory: '/tmp/', files: [{ name: 'a.obj' }, { name: 'b.obj' }] })).toEqual(['/tmp/a.obj', '/tmp/b.obj']);
    expect(importPaths({ filepath: '//c.obj' })).toEqual(['/project/c.obj']);
  });
  it('maps scripting enum values onto option values', () => {
    const opts = [{ id: 'forward_axis', label: 'F', type: 'enum' as const, default: '-Z', items: [['-Z', '-Z'], ['Y', 'Y']] as [string, string][], bpyItems: { NEGATIVE_Z: '-Z' } }];
    expect(propsToOptions(opts, { forward_axis: 'NEGATIVE_Z' }).forward_axis).toBe('-Z');
    expect(() => propsToOptions(opts, { forward_axis: 'BAD' })).toThrow(/not found/);
  });
});

describe('format operators', () => {
  it('registers the scripting operator ids', () => {
    for (const id of ['wm.obj_import', 'wm.obj_export', 'wm.stl_import', 'wm.stl_export', 'wm.ply_import', 'wm.ply_export', 'wm.usd_import', 'wm.usd_export', 'wm.alembic_import', 'wm.fbx_import', 'import_scene.fbx', 'export_scene.fbx', 'import_scene.gltf', 'export_scene.gltf'])
      expect(operators.has(id), id).toBe(true);
  });

  const roundTrip: [string, string, string, Record<string, unknown>][] = [
    ['wm.obj_export', 'wm.obj_import', '/tmp/cube.obj', {}],
    ['wm.stl_export', 'wm.stl_import', '/tmp/cube.stl', {}],
    ['wm.ply_export', 'wm.ply_import', '/tmp/cube.ply', { merge_verts: true }],
    ['export_scene.gltf', 'import_scene.gltf', '/tmp/cube.glb', { merge_vertices: true }],
    ['export_scene.gltf', 'import_scene.gltf', '/tmp/cube.gltf', { merge_vertices: true }],
    ['export_scene.fbx', 'import_scene.fbx', '/tmp/cube.fbx', {}],
    ['export_scene.fbx', 'wm.fbx_import', '/tmp/cube2.fbx', {}],
    ['wm.usd_export', 'wm.usd_import', '/tmp/cube.usda', {}],
    ['wm.usd_export', 'wm.usd_import', '/tmp/cube.usdz', {}],
  ];
  for (const [exp, imp, path, importProps] of roundTrip)
    it(`${exp} → ${imp} (${path.split('.').pop()})`, () => {
      js(`
        for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
        bpy.ops.mesh.primitive_cube_add({ size: 2, location: [1, 2, 3] });
        bpy.ops.${exp}(${JSON.stringify({ filepath: path })});
      `);
      const bytes = vfsRead(path);
      expect(bytes && bytes.length).toBeGreaterThan(50);
      js(`
        for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
        bpy.ops.${imp}(${JSON.stringify({ filepath: path, ...importProps })});
      `);
      const obs = meshObjects();
      expect(obs.length).toBe(1);
      const me = app.doc.meshes[obs[0].data!];
      // STL and glTF hold triangles; the others keep the 6 quads
      expect(me.positions.length / 3).toBe(8);
      expect(me.offsets.length - 1).toBe(/\.(stl|glb|gltf)$/.test(path) ? 12 : 6);
      const ev = app.graph.get(obs[0].id)!;
      ev.world.elements; // evaluated
      const bb = [0, 1, 2].map((k) => {
        let lo = Infinity,
          hi = -Infinity;
        for (let i = k; i < me.positions.length; i += 3) {
          lo = Math.min(lo, me.positions[i]);
          hi = Math.max(hi, me.positions[i]);
        }
        return hi - lo;
      });
      const s = obs[0].scale;
      expect(bb.map((v, i) => Math.round(v * s[i] * 1000) / 1000)).toEqual([2, 2, 2]);
    });

  it('writes OBJ material libraries next to the file and finds them again', () => {
    js(`
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      bpy.ops.mesh.primitive_cube_add();
      const m = bpy.data.materials.new('Red');
      m.diffuse_color = [1, 0, 0, 1];
      bpy.context.object.data.materials.append(m);
      bpy.ops.wm.obj_export({ filepath: '/tmp/out/red.obj', export_materials: true });
    `);
    expect(new TextDecoder().decode(vfsRead('/tmp/out/red.mtl')!)).toMatch(/newmtl Red/);
    js(`
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      for (const m of [...bpy.data.materials]) bpy.data.materials.remove(m);
      bpy.ops.wm.obj_import({ filepath: '/tmp/out/red.obj' });
    `);
    const mats = Object.values(app.doc.materials).map((m) => m.name);
    expect(mats).toContain('Red');
  });

  it('limits exports to the selection or a collection', () => {
    js(`
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      bpy.ops.mesh.primitive_cube_add();
      bpy.ops.mesh.primitive_uv_sphere_add({ location: [4, 0, 0] });
      bpy.ops.wm.obj_export({ filepath: '/tmp/sel.obj', export_selected_objects: true });
      bpy.ops.wm.obj_export({ filepath: '/tmp/all.obj' });
    `);
    const count = (p: string) => (new TextDecoder().decode(vfsRead(p)!).match(/^o /gm) ?? []).length;
    expect(count('/tmp/sel.obj')).toBe(1);
    expect(count('/tmp/all.obj')).toBe(2);
    js(`
      const c = bpy.data.collections.new('Export Me');
      bpy.context.scene.collection.children.link(c);
      c.objects.link(bpy.data.objects['Cube']);
      bpy.ops.wm.stl_export({ filepath: '/tmp/col.stl', collection: 'Export Me', ascii_format: true });
    `);
    expect(new TextDecoder().decode(vfsRead('/tmp/col.stl')!).match(/facet normal/g)?.length).toBe(12);
  });

  it('reports a missing file as an error', () => {
    expect(() => js(`bpy.ops.wm.obj_import({ filepath: '/tmp/nothing.obj' })`)).toThrow(/no such file/);
  });

  it('routes the generic import / export operators to the format operators', () => {
    js(`
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      bpy.ops.mesh.primitive_cube_add();
      bpy.ops.wm.export({ format: 'stl', filepath: '/tmp/g.stl' });
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      bpy.ops.wm.import({ filepath: '/tmp/g.stl' });
    `);
    expect(meshObjects().length).toBe(1);
  });

  it('shares files with Python', () => {
    if (!has) return;
    const out = runPy(`
      import bpy, os
      for o in list(bpy.data.objects):
          bpy.data.objects.remove(o)
      bpy.ops.mesh.primitive_cube_add()
      path = os.path.join(bpy.app.tempdir, "py.obj")
      bpy.ops.wm.obj_export(filepath=path, forward_axis='NEGATIVE_Z', up_axis='Y')
      with open(path) as f:
          text = f.read()
      print(sum(1 for l in text.splitlines() if l.startswith("v ")))
      with open("/tmp/tri.obj", "w") as f:
          f.write("o Tri\\nv 0 0 0\\nv 1 0 0\\nv 0 1 0\\nf 1 2 3\\n")
      bpy.ops.wm.obj_import(filepath="/tmp/tri.obj")
      print(bpy.data.objects["Tri"].data.vertices.__len__())
    `);
    expect(out.split('\n')).toEqual(['8', '3']);
  });
});

describe('content options', () => {
  it('leaves cameras, lights or materials out of imports and exports', () => {
    js(`
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      bpy.ops.mesh.primitive_cube_add();
      const m = bpy.data.materials.new('Red');
      bpy.context.object.data.materials.append(m);
      bpy.ops.object.camera_add({ location: [0, -5, 0] });
      bpy.ops.object.light_add({ type: 'POINT' });
      bpy.ops.wm.usd_export({ filepath: '/tmp/all.usda' });
      bpy.ops.wm.usd_export({ filepath: '/tmp/nocam.usda', export_cameras: false, export_materials: false });
      bpy.ops.export_scene.gltf({ filepath: '/tmp/nomat.gltf', export_materials: 'NONE' });
    `);
    const all = new TextDecoder().decode(vfsRead('/tmp/all.usda')!);
    const nocam = new TextDecoder().decode(vfsRead('/tmp/nocam.usda')!);
    expect(all).toMatch(/def Camera/);
    expect(nocam).not.toMatch(/def Camera/);
    expect(nocam).not.toMatch(/def Material/);
    expect(JSON.parse(new TextDecoder().decode(vfsRead('/tmp/nomat.gltf')!)).materials ?? []).toEqual([]);
    js(`
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      bpy.ops.wm.usd_import({ filepath: '/tmp/all.usda', import_cameras: false, import_lights: false, create_collection: true });
    `);
    const types = Object.values(app.doc.objects).map((o) => o.type).sort();
    expect(types.filter((t) => t === 'CAMERA' || t === 'LIGHT')).toEqual([]);
    expect(Object.values(app.doc.collections).some((c) => c.name === 'all')).toBe(true);
  });
});
