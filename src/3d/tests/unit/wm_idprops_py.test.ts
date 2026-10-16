// @vitest-environment happy-dom
// Custom property settings and wm.context operators from Python (skipped when Pyodide can't load).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { pythonAvailable, runPy } from './support/python';

let has = false;
beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  await import('../../src/ops/wm_index');
  has = await pythonAvailable();
}, 90000);

beforeEach(() => setApp(new App(startupDocument())));

const py = (name: string, fn: () => void) => it(name, () => (has ? fn() : undefined));

describe('custom properties and context operators from Python', () => {
  py('id_properties_ui sets limits, default and description; del drops them', () => {
    const out = runPy(`
      import bpy
      ob = bpy.data.objects["Cube"]
      ob["weight"] = 0.5
      ui = ob.id_properties_ui("weight")
      ui.update(min=0.0, max=2.0, default=1.0, subtype="FACTOR", description="How heavy")
      d = ui.as_dict()
      print(d["min"], d["max"], d["default"], d["subtype"], d["description"])
    `);
    expect(out).toBe('0 2 1 FACTOR How heavy');
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')! as unknown as { custom_ui?: Record<string, unknown> };
    expect(cube.custom_ui?.weight).toMatchObject({ min: 0, max: 2, default: 1 });
    runPy('import bpy\ndel bpy.data.objects["Cube"]["weight"]');
    expect(cube.custom_ui).toBeUndefined();
  });

  py('wm.context_toggle and wm.context_set_enum change tool settings', () => {
    runPy(`
      import bpy
      bpy.ops.wm.context_toggle(data_path="tool_settings.use_snap")
      bpy.ops.wm.context_set_enum(data_path="tool_settings.proportional_edit_falloff", value="SHARP")
    `);
    expect(app.doc.scene.tool_settings.use_snap).toBe(true);
    expect(app.doc.scene.tool_settings.proportional_edit_falloff).toBe('SHARP');
  });
});
