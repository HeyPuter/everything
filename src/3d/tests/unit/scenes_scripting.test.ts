// @vitest-environment happy-dom
// Scripting API of scenes, view layers and custom properties (JavaScript and Python).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { runJavaScript, output } from '../../src/scripting/runner';
import { pythonAvailable, runPy } from './support/python';
import { allScenes } from '../../src/scenes/scenes';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}

let has = false;
beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  has = await pythonAvailable();
}, 90000);

beforeEach(() => setApp(new App(startupDocument())));
const py = (name: string, fn: () => void) => it(name, () => (has ? fn() : undefined));

describe('scenes from scripts', () => {
  it('bpy.data.scenes lists, creates and removes scenes', () => {
    expect(run(`print(bpy.data.scenes.length, bpy.context.scene.name)`)).toBe('1 Scene');
    expect(run(`const s = bpy.data.scenes.new('Shot'); print(s.name, bpy.data.scenes.length, bpy.context.scene.name, s.objects.length)`)).toBe('Shot 2 Scene 0');
    expect(run(`bpy.data.scenes['Shot'].frame_end = 42; print(bpy.data.scenes['Shot'].frame_end, bpy.context.scene.frame_end)`)).toBe('42 250');
    run(`bpy.context.window.scene = bpy.data.scenes['Shot']`);
    expect(app.doc.scene.name).toBe('Shot');
    expect(run(`print(bpy.context.scene.name, bpy.context.scene === bpy.data.scenes['Shot'])`)).toBe('Shot true');
    run(`bpy.data.scenes.remove(bpy.data.scenes['Scene'])`);
    expect(allScenes(app.doc).map((s) => s.name)).toEqual(['Shot']);
  });

  it('view layers: add, rename, passes and collection flags', () => {
    expect(run(`print(bpy.context.scene.view_layers.length, bpy.context.view_layer.name)`)).toBe('1 ViewLayer');
    run(`const vl = bpy.context.scene.view_layers.new('Mask'); vl.use_pass_z = true; vl.layer_collection.children['Collection'].exclude = true`);
    expect(app.doc.scene.view_layers!.map((l) => l.name)).toEqual(['ViewLayer', 'Mask']);
    // the new layer is not active: the live settings are untouched
    expect(app.doc.scene.render.use_pass_z).toBe(false);
    expect(Object.values(app.doc.collections).find((c) => c.name === 'Collection')!.exclude).toBe(false);
    run(`bpy.context.window.view_layer = bpy.context.scene.view_layers['Mask']`);
    expect(app.doc.scene.render.use_pass_z).toBe(true);
    expect(Object.values(app.doc.collections).find((c) => c.name === 'Collection')!.exclude).toBe(true);
    expect(run(`print(bpy.context.view_layer.name, bpy.context.view_layer.use_pass_z)`)).toBe('Mask true');
  });

  py('Python: scenes, view layers, light groups', () => {
    expect(
      runPy(`
      import bpy
      s = bpy.data.scenes.new("Alt")
      print(len(bpy.data.scenes), s.name, bpy.context.scene.name)
      vl = bpy.context.view_layer
      g = vl.lightgroups.new(name="key")
      print(g.name, len(vl.lightgroups), vl.use)
      vl.use = False
      print(bpy.context.scene.render.use_view_layer)
    `),
    ).toBe('2 Alt Scene\nkey 1 True\nFalse');
  });
});
