// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import type { ObjectData } from '../../src/data/types';
import { keyProperty, ensureFCurve, keyingTarget } from '../../src/anim/keyframes';
import { insertKeyframe } from '../../src/anim/fcurve';
import { applyAnimData } from '../../src/anim/evaluate';
import { keyingSetScript, updateTransformConstraintCurves } from '../../src/animation/animutils';
import { pythonAvailable, runPy } from './support/python';
import '../../src/ops/object';

let cube: ObjectData;
beforeEach(() => {
  setApp(new App(startupDocument()));
  cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
});

describe('disabled F-Curves', () => {
  it('a curve whose property is gone gets disabled, and revive clears it', () => {
    keyProperty(app.doc, cube, 'location', 0, 1);
    const { act, slot } = keyingTarget(app.doc, cube);
    const bad = ensureFCurve(act, 'modifiers["Gone"].levels', 0, slot);
    insertKeyframe(bad, 1, 2);
    applyAnimData(app.doc, cube, cube.animation_data!, 1);
    expect(bad.disabled).toBe(true);
    expect(act.fcurves[0].disabled).toBeUndefined();
    // a modifier with that name appears: the curve stays disabled until revived
    cube.modifiers.push({ id: 'm1', name: 'Gone', type: 'SUBSURF', levels: 1, show_viewport: true, show_render: true } as never);
    applyAnimData(app.doc, cube, cube.animation_data!, 1);
    expect((cube.modifiers[0] as unknown as { levels: number }).levels).toBe(1);
    expect(app.run('anim.channels_fcurves_enable')).toBe('FINISHED');
    expect(bad.disabled).toBeUndefined();
    applyAnimData(app.doc, cube, cube.animation_data!, 2);
    expect((cube.modifiers[0] as unknown as { levels: number }).levels).toBe(2);
  });
});

describe('keying set export', () => {
  it('writes a script that rebuilds the set', () => {
    const set = { name: 'My Set', paths: [{ id: cube.id, data_path: 'location', index: -1 }, { id: cube.id, data_path: 'scale', index: 2 }] };
    app.doc.scene.keying_sets = [set];
    app.doc.scene.keying_set = 'KS:My Set';
    const src = keyingSetScript(app.doc, set);
    expect(src).toContain('ks = scene.keying_sets.new(idname="My Set", name="My Set")');
    expect(src).toContain('ks.paths.add(bpy.data.objects["Cube"], "location", index=-1)');
    expect(src).toContain('ks.paths.add(bpy.data.objects["Cube"], "scale", index=2)');
    expect(app.run('anim.keying_set_export')).toBe('FINISHED');
    const text = Object.values(app.doc.texts).find((t) => t.name === 'My_Set.py')!;
    expect(text.language).toBe('python');
    expect(text.body).toBe(src);
  });

  let py = false;
  beforeAll(async () => {
    py = await pythonAvailable();
  }, 120000);
  it('the exported script runs and recreates the set', () => {
    if (!py) return;
    const set = { name: 'Again', paths: [{ id: cube.id, data_path: 'rotation_euler', index: 1 }] };
    const src = keyingSetScript(app.doc, set);
    runPy(src);
    const made = app.doc.scene.keying_sets!.find((k) => k.name === 'Again')!;
    expect(made.paths).toEqual([{ id: cube.id, data_path: 'rotation_euler', index: 1 }]);
  });
});

describe('transform constraint animation update', () => {
  it('moves range curves to the _rot properties and converts degrees', () => {
    cube.constraints.push({ id: 'c1', name: 'Transformation', type: 'TRANSFORM', mute: false, influence: 1, show_expanded: true, map_from: 'ROTATION', map_to: 'LOCATION' });
    const { act, slot } = keyingTarget(app.doc, cube);
    const fc = ensureFCurve(act, 'constraints["Transformation"].from_max_x', 0, slot);
    insertKeyframe(fc, 1, 90);
    const to = ensureFCurve(act, 'constraints["Transformation"].to_max_x', 0, slot);
    insertKeyframe(to, 1, 3);
    expect(updateTransformConstraintCurves(app.doc, true)).toBe(1);
    expect(fc.data_path).toBe('constraints["Transformation"].from_max_x_rot');
    expect(fc.keyframe_points[0].co[1]).toBeCloseTo(Math.PI / 2, 6);
    // map_to is LOCATION: unchanged
    expect(to.data_path).toBe('constraints["Transformation"].to_max_x');
  });
});
