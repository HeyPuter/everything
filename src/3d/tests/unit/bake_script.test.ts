// @vitest-environment happy-dom
// Baking settings through the scripting API (the GPU bake itself runs in the browser tests).
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import '../../src/bake/ops';
import { runJavaScript, output } from '../../src/scripting/runner';
import { pythonAvailable, runPy } from './support/python';
import { bakeOptions } from '../../src/bake/ops';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}

beforeEach(() => setApp(new App(startupDocument())));

describe('bake settings in scripts', () => {
  it('scene.render.bake, scene.cycles.bake_type and image color spaces', () => {
    const out = run(`
      const b = C.scene.render.bake;
      b.margin = 4; b.margin_type = 'EXTEND'; b.normal_g = 'NEG_Y'; b.use_selected_to_active = true;
      C.scene.cycles.bake_type = 'NORMAL';
      const img = D.images.new('N', 8, 8);
      img.colorspace_settings.name = 'Non-Color';
      print(b.margin, C.scene.cycles.bake_type, img.colorspace_settings.name, img.colorspace_settings.is_data)`);
    expect(out).toBe('4 NORMAL Non-Color true');
    expect(app.doc.scene.render.bake_type).toBe('NORMAL');
  });
  it('operator properties fall back to the scene settings', () => {
    const r = app.doc.scene.render;
    r.bake!.margin = 3;
    r.bake!.use_clear = false;
    const o = bakeOptions({ type: 'AO', pass_filter: [] });
    expect(o).toMatchObject({ type: 'AO', margin: 3, use_clear: false, normal_space: 'TANGENT' });
    expect(bakeOptions({ margin: 7, pass_filter: ['COLOR'] })).toMatchObject({ margin: 7, filter: { color: true, direct: false } });
    expect(() => bakeOptions({ cage_object: 'Nope' })).toThrow(/No object named/);
  });
});

describe('bake settings in Python', () => {
  let ok = false;
  beforeAll(async () => {
    ok = await pythonAvailable();
  }, 60000);
  it('reads and writes the bake settings', () => {
    if (!ok) return;
    const out = runPy(`
      import bpy
      s = bpy.context.scene
      s.render.bake.margin = 8
      s.render.bake.use_pass_direct = False
      s.cycles.bake_type = 'AO'
      print(s.render.bake.margin, s.render.bake.use_pass_direct, s.cycles.bake_type, s.render.bake.normal_space)
    `);
    expect(out).toBe('8 False AO TANGENT');
  });
});

describe('UDIM tiles in scripts', () => {
  it('source, tiles.new / get / remove / active', () => {
    const out = run(`
      const img = D.images.new('U', 8, 8);
      img.source = 'TILED';
      const t = img.tiles.new(1002, 'Arm');
      img.tiles.new({tile_number: 1011});
      print(img.source, img.tiles.length, t.number, t.label, img.tiles.get(1011).number, img.tiles.get(1500));
      img.tiles.active_index = 1;
      print(img.tiles.active.number);
      img.tiles.remove(img.tiles.get(1002));
      print([...img.tiles].map((x) => x.number).join(','));
      img.source = 'GENERATED';
      print(img.source, img.tiles.length)`);
    expect(out).toBe('TILED 3 1002 Arm 1011 null\n1002\n1001,1011\nGENERATED 0');
  });
});
