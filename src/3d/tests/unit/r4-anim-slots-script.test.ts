// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import { runJavaScript, output } from '../../src/scripting/runner';
import { pythonAvailable, runPy } from './support/python';
import * as S from '../../src/anim/slots';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}
const ob = (name: string) => Object.values(app.doc.objects).find((o) => o.name === name)!;

beforeEach(() => setApp(new App(startupDocument())));

describe('action slots from scripts', () => {
  it('slots, channelbags and animation_data.action_slot', () => {
    const out = run(`
      const cube = D.objects['Cube'], cam = D.objects['Camera'];
      cube.keyframe_insert('location', {index: 0, frame: 1});
      const act = cube.animation_data.action;
      print(act.slots.length, act.slots[0].identifier, act.slots[0].name_display, act.slots[0].target_id_type);
      print(cube.animation_data.action_slot.identifier, cube.animation_data.action_slot_handle);
      const slot = act.slots.new('OBJECT', 'Camera');
      cam.animation_data_create();
      cam.animation_data.action = act;
      print(cam.animation_data.action_slot.identifier);
      const bag = act.layers[0].strips[0].channelbag(slot, {ensure: true});
      const fc = bag.fcurves.new('location', {index: 1});
      fc.keyframe_points.insert(1, 4);
      act.layers[0].strips[0].key_insert(slot, 'location', 2, 9, 1);
      print(bag.fcurves.length, act.fcurves.length, act.layers[0].strips[0].channelbags.length);
      print(act.slots.get('OBCamera').users().map((o) => o.name).join(','));
      cam.animation_data.action_slot = null;
      print(cam.animation_data.action_slot);
      cam.animation_data.action_slot_handle = slot.handle;
      print(cam.animation_data.action_slot.name_display, cam.animation_data.action_suitable_slots.length);
      slot.name_display = 'Cam';
      print(cam.animation_data.action_slot.identifier, cam.animation_data.last_slot_identifier);
    `);
    expect(out.split('\n')).toEqual(['1 OBCube Cube OBJECT', 'OBCube 1', 'OBCamera', '2 3 2', 'Camera', 'null', 'Camera 2', 'OBCam OBCam']);
    app.evaluate();
    expect(ob('Camera').location[1]).toBeCloseTo(4, 5);
    expect(ob('Camera').location[2]).toBeCloseTo(9, 5);
  });

  it('NLA strips play a slot', () => {
    run(`
      const cube = D.objects['Cube'], cam = D.objects['Camera'];
      cube.keyframe_insert('location', {index: 0, frame: 1});
      const act = cube.animation_data.action;
      const slot = act.slots.new('OBJECT', 'Camera');
      act.layers[0].strips[0].key_insert(slot, 'location', 0, 42, 1);
      cam.animation_data_create();
      const st = cam.animation_data.nla_tracks.new().strips.new('S', 1, act);
      print(st.action_slot);
      st.action_slot = slot;
    `);
    const strip = ob('Camera').animation_data!.nla_tracks[0].strips[0];
    expect(S.findSlot(app.doc.actions[strip.action], strip.action_slot_handle)?.identifier).toBe('OBCamera');
    app.evaluate();
    expect(ob('Camera').location[0]).toBeCloseTo(42, 5);
  });
});

describe('action slots from Python', () => {
  let py = false;
  beforeAll(async () => {
    py = await pythonAvailable();
  }, 120000);
  it('channelbag helpers and slots in Python', () => {
    if (!py) return;
    const out = runPy(`
      import bpy
      from bpy_extras import anim_utils
      cube = bpy.data.objects['Cube']
      act = bpy.data.actions.new('Walk')
      slot = act.slots.new('OBJECT', 'Cube')
      cube.animation_data_create()
      cube.animation_data.action = act
      print(cube.animation_data.action_slot == slot, cube.animation_data.action_slot.identifier)
      bag = anim_utils.action_ensure_channelbag_for_slot(act, slot)
      fc = bag.fcurves.new('location', index=2)
      fc.keyframe_points.insert(1, 3.5)
      print(len(anim_utils.action_get_channelbag_for_slot(act, slot).fcurves))
    `);
    expect(out.split('\n')).toEqual(['True OBCube', '1']);
  });
});
