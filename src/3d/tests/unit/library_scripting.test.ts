// @vitest-environment happy-dom
// Scripting the library system: bpy.data.libraries.load(), ID.library, make_local(), overrides,
// orphan purge, and the link / append operators with Adjust Last Operation.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newCollection, newObject } from '../../src/data/defaults';
import { runJavaScript, output } from '../../src/scripting/runner';
import { pythonAvailable, runPy } from './support/python';
import { cacheSource } from '../../src/library/runtime';
import { encodeDocument, decodeDocument } from '../../src/io/native';
import { linkedRecords, lockLinked } from '../../src/library/core';
import type { DocumentData } from '../../src/data/types';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}

/** A library file "props.p3d" with collection "Rig" (Root empty parenting mesh "Crate"). */
function props(): DocumentData {
  const d = startupDocument();
  const col = newCollection('Rig');
  const cube = Object.values(d.objects).find((o) => o.name === 'Cube')!;
  cube.name = 'Crate';
  for (const c of Object.values(d.collections)) c.objects = c.objects.filter((o) => o !== cube.id);
  const root = newObject('Root', 'EMPTY', null);
  d.objects[root.id] = root;
  d.object_order.push(root.id);
  cube.parent = root.id;
  col.objects.push(root.id, cube.id);
  d.collections[col.id] = col;
  d.collections[d.scene.collection].children.push(col.id);
  return d;
}
const KEY = 'copy:props.p3d:test';
const entry = { key: KEY, name: 'props.p3d', path: 'props.p3d' };

let has = false;
beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  has = await pythonAvailable();
}, 90000);

beforeEach(() => {
  setApp(new App(startupDocument()));
  cacheSource(KEY, props(), entry);
});

const names = () =>
  Object.values(app.doc.objects)
    .map((o) => `${o.name}${(o as unknown as { library?: string }).library ? '@L' : ''}${(o as unknown as { override_library?: object }).override_library ? '@O' : ''}`)
    .sort()
    .join(',');

describe('link / append operators', () => {
  it('links picked data-blocks and adjusts the last operation', () => {
    expect(app.run('wm.link', { filepath: KEY, files: 'collections/Rig' }, { invoke: false })).toBe('FINISHED');
    expect(names()).toBe('Camera,Crate@L,Cube,Light,Rig,Root@L');
    expect(app.lastOp?.idname).toBe('wm.link');
    // without instancing, the collection goes straight into the scene
    app.redoLast({ instance_collections: false });
    expect(names()).toBe('Camera,Crate@L,Cube,Light,Root@L');
    expect(app.doc.collections[app.doc.scene.collection].children.some((c) => app.doc.collections[c]?.name === 'Rig')).toBe(true);
  });

  it('appends copies that remember their source, reusing them on request', () => {
    app.run('wm.append', { filepath: KEY, files: 'objects/Crate' }, { invoke: false });
    expect(names()).toBe('Camera,Crate,Cube,Light,Root');
    const n = Object.keys(app.doc.meshes).length;
    app.run('wm.append', { filepath: KEY, files: 'objects/Crate', do_reuse_local_id: true }, { invoke: false });
    // the object is reused, so nothing new arrives
    expect(Object.keys(app.doc.meshes).length).toBe(n);
    app.run('wm.append', { filepath: KEY, files: 'objects/Crate' }, { invoke: false });
    expect(Object.keys(app.doc.meshes).length).toBe(n + 1);
  });

  it('keeps linked data through a save and open', () => {
    app.run('wm.link', { filepath: KEY, files: 'collections/Rig' }, { invoke: false });
    const back = decodeDocument(encodeDocument(app.doc)).doc;
    lockLinked(back);
    expect(Object.values(back.libraries ?? {}).map((l) => l.name)).toEqual(['props.p3d']);
    expect(linkedRecords(back).length).toBe(linkedRecords(app.doc).length);
    const crate = Object.values(back.objects).find((o) => o.name === 'Crate')!;
    expect(() => {
      crate.location = [1, 1, 1];
    }).toThrow();
  });

  it('makes linked data local and purges unused linked data', () => {
    app.run('wm.link', { filepath: KEY, files: 'collections/Rig' }, { invoke: false });
    const empty = Object.values(app.doc.objects).find((o) => o.name === 'Rig')!;
    for (const o of Object.values(app.doc.objects)) o.select = o === empty;
    app.doc.scene.active_object = empty.id;
    app.run('object.make_override_library', {}, { invoke: false });
    expect(names()).toBe('Camera,Crate@L,Crate@O,Cube,Light,Root@L,Root@O');
    app.run('object.make_local', { type: 'ALL' }, { invoke: false });
    expect(linkedRecords(app.doc)).toHaveLength(0);
    expect(Object.keys(app.doc.libraries ?? {})).toHaveLength(0);
  });
});

describe('relocating', () => {
  it('replaces a linked data-block by one of another file; local users follow', () => {
    app.run('wm.link', { filepath: KEY, files: 'materials/Material' }, { invoke: false });
    const linkedMat = Object.values(app.doc.materials).find((m) => (m as unknown as { library?: string }).library)!;
    // a local mesh uses the linked material
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    app.doc.meshes[cube.data!].materials = [linkedMat.id];
    const other = startupDocument();
    Object.values(other.materials)[0].name = 'Steel';
    cacheSource('copy:metals.p3d:test', other, { key: 'copy:metals.p3d:test', name: 'metals.p3d', path: 'metals.p3d' });
    expect(app.run('wm.id_linked_relocate', { id: linkedMat.id, filepath: 'copy:metals.p3d:test', files: 'materials/Steel' }, { invoke: false })).toBe('FINISHED');
    const now = app.doc.materials[app.doc.meshes[cube.data!].materials[0]!];
    expect(now.name).toBe('Steel');
    expect(app.doc.materials[linkedMat.id]).toBeUndefined();
    expect(Object.values(app.doc.libraries ?? {}).map((l) => l.name)).toEqual(['metals.p3d']);
  });
});

describe('scripting', () => {
  it('bpy.data.libraries.load links by name (JavaScript)', () => {
    const out = run(`
      const ctx = bpy.data.libraries.load('${KEY}', { link: true });
      const [from, to] = ctx.__enter__();
      print(from.objects.join(','));
      to.objects = ['Crate'];
      ctx.__exit__();
      const ob = to.objects[0];
      print(ob.name, ob.library.name, ob.is_editable, bpy.data.libraries.length);
      bpy.context.scene.collection.objects.link(ob);
      const local = ob.make_local();
      print(local.library === null, local.is_editable);
    `);
    expect(out).toBe('Camera,Crate,Light,Root\nCrate props.p3d false 1\ntrue true');
  });

  it('with bpy.data.libraries.load(...) as (data_from, data_to) (Python)', () => {
    if (!has) return;
    const out = runPy(`
      import bpy
      with bpy.data.libraries.load("props.p3d", link=False) as (data_from, data_to):
          data_to.collections = [c for c in data_from.collections if c == "Rig"]
      col = data_to.collections[0]
      print(col.name, col.library, sorted(o.name for o in col.objects))
      with bpy.data.libraries.load("props.p3d", link=True) as (data_from, data_to):
          data_to.objects = ["Root"]
      ob = data_to.objects[0]
      print(ob.library.name, ob.library.filepath, len(bpy.data.libraries))
      ov = ob.override_hierarchy_create()
      print(ov.override_library.reference.name, ov.override_library.reference == ob)
      print(bpy.data.orphans_purge(do_local_ids=False, do_linked_ids=True) >= 0)
    `);
    expect(out).toBe("Rig None ['Crate', 'Root']\nprops.p3d props.p3d 1\nRoot True\nTrue");
  });
});

describe('data-block selector operators', () => {
  it('toggles fake users and editable overrides', () => {
    const mat = Object.values(app.doc.materials)[0];
    app.run('ed.lib_id_fake_user_toggle', { id: mat.id }, { invoke: false });
    expect(mat.use_fake_user).toBe(true);
    app.run('wm.link', { filepath: KEY, files: 'collections/Rig' }, { invoke: false });
    const empty = Object.values(app.doc.objects).find((o) => o.name === 'Rig')!;
    app.doc.scene.active_object = empty.id;
    app.run('object.make_override_library', {}, { invoke: false });
    const col = Object.values(app.doc.collections).find((c) => c.name === 'Rig' && (c as unknown as { override_library?: object }).override_library)!;
    const ov = (col as unknown as { override_library: { is_system_override?: boolean } }).override_library;
    const before = !!ov.is_system_override;
    app.run('ed.lib_id_override_editable_toggle', { id: col.id }, { invoke: false });
    expect(!!(app.doc.collections[col.id] as unknown as { override_library: { is_system_override?: boolean } }).override_library.is_system_override).toBe(!before);
  });
});
