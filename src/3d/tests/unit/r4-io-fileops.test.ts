// @vitest-environment happy-dom
// External Data (pack / relative paths), name validation and collection exporters.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { runJavaScript } from '../../src/scripting/runner';
import { vfsRead, vfsWrite, vfsClear } from '../../src/io/vfs';
import { cleanName, externalPaths, makePaths, packAll, relativePath, validateNames } from '../../src/io/fileops';
import { addExporter, exporterFormat, exporterPath, runExporter } from '../../src/io/collectionexport';
import { encodePngRgba } from '../../src/io/formats/pngsync';
import type { ImageData } from '../../src/data/types';

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
}, 120000);
beforeEach(() => {
  setApp(new App(startupDocument()));
  vfsClear();
});

const js = (code: string) => {
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error}`);
};

const img = (name: string, filepath: string): ImageData => ({ id: `im_${name}`, name, mime: 'image/png', bytes: null, width: 1, height: 1, source: 'FILE', colorspace: 'sRGB', filepath });

describe('external data', () => {
  it('packs images that only have a path from the session files', () => {
    const doc = app.doc;
    doc.images.a = img('a', '/textures/wood.png');
    doc.images.b = img('b', 'C:\\other\\metal.png');
    vfsWrite('/imports/wood.png', encodePngRgba(3, 2, new Uint8Array(24).fill(200)));
    const r = packAll(doc);
    expect(r.packed).toBe(1);
    expect(r.missing).toEqual(['b']);
    expect(doc.images.a.width).toBe(3);
    expect(doc.images.a.height).toBe(2);
    expect(doc.images.a.mime).toBe('image/png');
  });

  it('makes paths relative to the project folder and back', () => {
    const doc = app.doc;
    doc.images.a = img('a', '/project/tex/a.png');
    doc.images.b = img('b', '/elsewhere/b.png');
    expect(relativePath('/project/x/y.png')).toBe('//x/y.png');
    expect(relativePath('/tmp/y.png')).toBeNull();
    const r = makePaths(doc, true);
    expect(r.changed).toBe(1);
    expect(r.failed.length).toBe(1);
    expect(doc.images.a.filepath).toBe('//tex/a.png');
    expect(makePaths(doc, false).changed).toBe(1);
    expect(doc.images.a.filepath).toBe('/project/tex/a.png');
    expect(externalPaths(doc).filter((p) => p.kind === 'IMAGE').length).toBe(2);
  });

  it('runs through the operators', () => {
    app.doc.images.a = img('a', '//tex/a.png');
    js(`bpy.ops.file.make_paths_absolute()`);
    expect(app.doc.images.a.filepath).toBe('/project/tex/a.png');
    js(`bpy.ops.file.make_paths_relative()`);
    expect(app.doc.images.a.filepath).toBe('//tex/a.png');
    js(`bpy.ops.file.autopack_toggle()`);
    expect(app.doc.use_autopack).toBe(true);
  });

  it('cleans invalid characters from names', () => {
    expect(cleanName('ok\u0001name\ud800')).toBe('ok_name\ufffd');
    expect(cleanName('emoji 😀')).toBe('emoji 😀');
    const ob = Object.values(app.doc.objects)[0];
    ob.name = 'Bad\u0007';
    expect(validateNames(app.doc)).toBe(1);
    expect(ob.name).toBe('Bad_');
  });
});

describe('collection exporters', () => {
  it('adds exporters by file handler name and exports the collection objects', () => {
    js(`
      for (const o of [...bpy.data.objects]) bpy.data.objects.remove(o);
      bpy.ops.mesh.primitive_cube_add();
      bpy.ops.mesh.primitive_uv_sphere_add({ location: [4, 0, 0] });
      const c = bpy.data.collections.new('Props');
      bpy.context.scene.collection.children.link(c);
      c.objects.link(bpy.data.objects['Sphere']);
    `);
    const c = Object.values(app.doc.collections).find((x) => x.name === 'Props')!;
    expect(exporterFormat('IO_FH_obj')?.format).toBe('obj');
    const ex = addExporter(c, 'IO_FH_obj')!;
    expect(ex.name).toBe('Wavefront OBJ');
    expect(exporterPath(c, ex)).toBe('//Props.obj');
    ex.filepath = '/tmp/props.obj';
    expect(runExporter(app.doc, c, ex)).toBe('/tmp/props.obj');
    const text = new TextDecoder().decode(vfsRead('/tmp/props.obj')!);
    expect(text.match(/^o /gm)?.length).toBe(1);
    expect(text).toMatch(/^o Sphere/m);
    const st = addExporter(c, 'stl')!;
    st.filepath = '/tmp/props.stl';
    st.export_properties.ascii_format = true;
    js(`bpy.ops.wm.collection_export_all()`);
    expect(new TextDecoder().decode(vfsRead('/tmp/props.stl')!)).toMatch(/^solid/);
  });
});
